//! Keeps Rekordbox's own library (`master.db`) in step with downloads and
//! playlist edits, alongside the import XML (which works while Rekordbox is
//! open; this is what makes tracks appear in the real Collection/Playlists).
//!
//! - Changes are queued in `~/.dj-sync/rekordbox-pending.json` and applied by
//!   `rekordbox/rbdb.py` (pyrekordbox) — only while Rekordbox is closed,
//!   because writing under a running Rekordbox can corrupt its library.
//! - Every apply is bracketed by semver snapshots of master.db in
//!   `~/.dj-sync/rekordbox-backups/` (APFS clones): before it (MAJOR when
//!   Rekordbox itself changed the library since dj-sync last wrote) and after
//!   it (MINOR when a playlist was created, PATCH when only tracks moved).
//! - Any snapshot can be restored (Rekordbox closed); the current library is
//!   snapshotted first, so a restore can itself be undone.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::config::RekordboxDbCfg;
use crate::xml_versions::{Bump, Version, Versions};

/// The helper script, bundled into the binary and installed next to the
/// state files (launchd can't read the repo under ~/Desktop).
const HELPER_SOURCE: &str = include_str!("../rekordbox/rbdb.py");
/// After this many failed attempts a batch is set aside instead of retried.
const MAX_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Batch {
    pub id: String,
    pub created_at: String,
    /// One line for people: "Add 3 tracks to “Friday”".
    pub summary: String,
    pub ops: Vec<Value>,
    #[serde(default)]
    pub attempts: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Pending {
    batches: Vec<Batch>,
    #[serde(default)]
    failed: Vec<FailedBatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailedBatch {
    pub batch: Batch,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupInfo {
    pub version: String,
    pub created_at: String,
    pub reason: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Applied {
    pub at: String,
    pub version: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryStatus {
    pub db_path: PathBuf,
    pub rekordbox_running: bool,
    pub pending: Vec<PendingInfo>,
    pub failed: Vec<FailedInfo>,
    pub last_applied: Option<Applied>,
    pub last_error: Option<String>,
    pub current_version: Option<String>,
    /// Newest first.
    pub backups: Vec<BackupInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingInfo {
    pub id: String,
    pub created_at: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailedInfo {
    pub id: String,
    pub summary: String,
    pub error: String,
}

/// How to run `rbdb.py`. Tests swap in a fake.
#[derive(Debug, Clone)]
pub struct Helper {
    pub program: PathBuf,
    pub prefix_args: Vec<OsString>,
}

type RunningCheck = Arc<dyn Fn() -> bool + Send + Sync>;

pub struct RekordboxLibrary {
    cfg: RekordboxDbCfg,
    state_dir: PathBuf,
    helper: Helper,
    running: RunningCheck,
    /// Serialises pending-file edits, applies and restores.
    lock: Mutex<Memory>,
}

#[derive(Default)]
struct Memory {
    last_applied: Option<Applied>,
    last_error: Option<String>,
    /// Batch id → library version, for batches applied since startup.
    applied: std::collections::HashMap<String, Option<String>>,
}

/// Where one queued batch stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchOutcome {
    Pending,
    Applied {
        version: Option<String>,
    },
    Failed {
        error: String,
    },
    /// Not known to this process (e.g. queued before a restart and applied).
    Unknown,
}

impl RekordboxLibrary {
    /// The real thing: helper in `~/.dj-sync`, run by the managed venv's
    /// python, Rekordbox detected with `pgrep`.
    pub fn new(cfg: RekordboxDbCfg, state_dir: PathBuf) -> Self {
        let helper = Helper {
            program: cfg.python.clone(),
            prefix_args: vec!["-I".into(), state_dir.join("rbdb.py").into()],
        };
        Self::with_parts(cfg, state_dir, helper, Arc::new(rekordbox_is_running))
    }

    pub fn with_parts(
        cfg: RekordboxDbCfg,
        state_dir: PathBuf,
        helper: Helper,
        running: RunningCheck,
    ) -> Self {
        Self {
            cfg,
            state_dir,
            helper,
            running,
            lock: Mutex::new(Memory::default()),
        }
    }

    fn pending_path(&self) -> PathBuf {
        self.state_dir.join("rekordbox-pending.json")
    }

    fn versions(&self) -> Versions {
        Versions::in_dir(&self.backups_dir(), "master", "db", self.cfg.keep_backups)
    }

    fn backups_dir(&self) -> PathBuf {
        self.state_dir.join("rekordbox-backups")
    }

    pub fn rekordbox_running(&self) -> bool {
        (self.running)()
    }

    // ---------- queue ----------

    /// Queue a batch; returns its id (see `batch_outcome`).
    pub fn enqueue(&self, summary: String, ops: Vec<Value>) -> anyhow::Result<String> {
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        if ops.is_empty() {
            return Ok(id);
        }
        let _guard = self.lock.lock().expect("library lock");
        let mut pending = self.read_pending();
        pending.batches.push(Batch {
            id: id.clone(),
            created_at: now(),
            summary,
            ops,
            attempts: 0,
        });
        self.write_pending(&pending)?;
        Ok(id)
    }

    pub fn batch_outcome(&self, id: &str) -> BatchOutcome {
        let memory = self.lock.lock().expect("library lock");
        if let Some(version) = memory.applied.get(id) {
            return BatchOutcome::Applied {
                version: version.clone(),
            };
        }
        let pending = self.read_pending();
        if pending.batches.iter().any(|b| b.id == id) {
            return BatchOutcome::Pending;
        }
        if let Some(f) = pending.failed.iter().find(|f| f.batch.id == id) {
            return BatchOutcome::Failed {
                error: f.error.clone(),
            };
        }
        BatchOutcome::Unknown
    }

    /// Read-only snapshot of playlists and tracks (safe while Rekordbox runs).
    pub fn snapshot(&self) -> anyhow::Result<Value> {
        match self.run_helper(&["snapshot"], None)? {
            HelperOutcome::Done(v) => Ok(v),
            HelperOutcome::RekordboxRunning => bail!("unexpected: snapshot refused"),
        }
    }

    pub fn current_version(&self) -> Option<String> {
        self.versions().latest().map(|(v, _)| v.to_string())
    }

    pub fn db_path(&self) -> &Path {
        &self.cfg.db_path
    }

    fn read_pending(&self) -> Pending {
        match std::fs::read_to_string(self.pending_path()) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                error!(error = %e, "rekordbox-pending.json is unreadable; starting empty");
                Pending::default()
            }),
            Err(_) => Pending::default(),
        }
    }

    fn write_pending(&self, pending: &Pending) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.state_dir)?;
        let path = self.pending_path();
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(pending)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    // ---------- apply ----------

    /// Apply everything queued, if Rekordbox is closed. `Ok(None)` when
    /// there was nothing to do or Rekordbox is open (changes stay queued).
    pub fn apply_pending(&self) -> anyhow::Result<Option<Applied>> {
        let mut memory = self.lock.lock().expect("library lock");
        let mut pending = self.read_pending();
        if pending.batches.is_empty() || self.rekordbox_running() {
            return Ok(None);
        }

        let versions = self.versions();
        let before = versions
            .reconcile(&self.cfg.db_path)
            .context("backing up master.db")?;
        self.note_backup(before, "Library before dj-sync's changes");

        let ops: Vec<Value> = pending.batches.iter().flat_map(|b| b.ops.clone()).collect();
        let summary = pending
            .batches
            .iter()
            .map(|b| b.summary.as_str())
            .collect::<Vec<_>>()
            .join("; ");

        match self.run_helper(&["apply"], Some(&json!({ "ops": ops }))) {
            Ok(HelperOutcome::Done(result)) => {
                let bump = bump_for(&result);
                let version = match bump {
                    Some(bump) => {
                        let v = versions.record(&self.cfg.db_path, before, bump)?;
                        self.note_backup(Some(v), &summary);
                        Some(v)
                    }
                    None => before,
                };
                let version_str = version.map(|v| v.to_string());
                for b in pending.batches.drain(..) {
                    memory.applied.insert(b.id, version_str.clone());
                }
                self.write_pending(&pending)?;
                let applied = Applied {
                    at: now(),
                    version: version.map(|v| v.to_string()),
                    summary,
                };
                info!(version = ?applied.version, summary = %applied.summary, "rekordbox library updated");
                memory.last_applied = Some(applied.clone());
                memory.last_error = None;
                Ok(Some(applied))
            }
            Ok(HelperOutcome::RekordboxRunning) => Ok(None),
            Err(e) => {
                let message = format!("{e:#}");
                memory.last_error = Some(message.clone());
                for b in &mut pending.batches {
                    b.attempts += 1;
                }
                let (give_up, keep): (Vec<Batch>, Vec<Batch>) = pending
                    .batches
                    .drain(..)
                    .partition(|b| b.attempts >= MAX_ATTEMPTS);
                pending.batches = keep;
                for batch in give_up {
                    warn!(batch = %batch.id, error = %message, "giving up on rekordbox batch");
                    pending.failed.push(FailedBatch {
                        batch,
                        error: message.clone(),
                    });
                }
                self.write_pending(&pending)?;
                Err(e)
            }
        }
    }

    /// Put set-aside batches back in the queue (e.g. after a fix).
    pub fn retry_failed(&self) -> anyhow::Result<usize> {
        let _guard = self.lock.lock().expect("library lock");
        let mut pending = self.read_pending();
        let n = pending.failed.len();
        for mut f in pending.failed.drain(..) {
            f.batch.attempts = 0;
            pending.batches.push(f.batch);
        }
        self.write_pending(&pending)?;
        Ok(n)
    }

    /// Forget set-aside batches.
    pub fn dismiss_failed(&self) -> anyhow::Result<usize> {
        let _guard = self.lock.lock().expect("library lock");
        let mut pending = self.read_pending();
        let n = pending.failed.len();
        pending.failed.clear();
        self.write_pending(&pending)?;
        Ok(n)
    }

    // ---------- restore ----------

    pub fn restore(&self, version: &str) -> anyhow::Result<String> {
        let target = Version::parse(version.trim_start_matches('v'))
            .ok_or_else(|| anyhow!("not a version: {version}"))?;
        let mut memory = self.lock.lock().expect("library lock");
        if self.rekordbox_running() {
            bail!("Quit Rekordbox first: its library can only be restored while it's closed.");
        }
        let versions = self.versions();
        anyhow::ensure!(versions.path_for(target).exists(), "no backup v{target}");
        // Keep what's there now, so the restore itself can be undone.
        let safety = versions.reconcile(&self.cfg.db_path)?;
        self.note_backup(safety, &format!("Before restoring v{target}"));
        versions.restore(target, &self.cfg.db_path)?;
        let message = format!(
            "Restored your Rekordbox library to v{target}. The library before the restore is v{}.",
            safety.map(|v| v.to_string()).unwrap_or_else(|| "–".into())
        );
        info!(%message);
        memory.last_applied = Some(Applied {
            at: now(),
            version: Some(target.to_string()),
            summary: format!("Restored v{target}"),
        });
        Ok(message)
    }

    // ---------- status ----------

    pub fn status(&self) -> LibraryStatus {
        let memory = self.lock.lock().expect("library lock");
        let pending = self.read_pending();
        let index = self.read_index();
        let versions = self.versions();
        let mut backups: Vec<BackupInfo> = versions
            .list()
            .into_iter()
            .map(|(v, path)| {
                let note = index.get(&v.to_string()).cloned().unwrap_or_default();
                BackupInfo {
                    version: v.to_string(),
                    created_at: note.created_at,
                    reason: note.reason,
                    size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                }
            })
            .collect();
        backups.reverse();
        LibraryStatus {
            db_path: self.cfg.db_path.clone(),
            rekordbox_running: self.rekordbox_running(),
            pending: pending
                .batches
                .iter()
                .map(|b| PendingInfo {
                    id: b.id.clone(),
                    created_at: b.created_at.clone(),
                    summary: b.summary.clone(),
                })
                .collect(),
            failed: pending
                .failed
                .iter()
                .map(|f| FailedInfo {
                    id: f.batch.id.clone(),
                    summary: f.batch.summary.clone(),
                    error: f.error.clone(),
                })
                .collect(),
            last_applied: memory.last_applied.clone(),
            last_error: memory.last_error.clone(),
            current_version: versions.latest().map(|(v, _)| v.to_string()),
            backups,
        }
    }

    // ---------- backup notes (version → when/why) ----------

    fn index_path(&self) -> PathBuf {
        self.backups_dir().join("index.json")
    }

    fn read_index(&self) -> std::collections::BTreeMap<String, Note> {
        std::fs::read_to_string(self.index_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn note_backup(&self, version: Option<Version>, reason: &str) {
        let Some(v) = version else { return };
        let mut index = self.read_index();
        index.entry(v.to_string()).or_insert_with(|| Note {
            created_at: now(),
            reason: reason.to_string(),
        });
        let _ = std::fs::create_dir_all(self.backups_dir());
        if let Ok(bytes) = serde_json::to_vec_pretty(&index) {
            let _ = std::fs::write(self.index_path(), bytes);
        }
    }

    // ---------- helper process ----------

    /// Install the bundled helper and, if needed, its Python environment.
    pub fn prepare_helper(&self) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.state_dir)?;
        let script = self.state_dir.join("rbdb.py");
        if std::fs::read_to_string(&script).ok().as_deref() != Some(HELPER_SOURCE) {
            std::fs::write(&script, HELPER_SOURCE)
                .with_context(|| format!("installing {}", script.display()))?;
        }
        if !self.cfg.python.exists() {
            let venv = self
                .cfg
                .python
                .parent()
                .and_then(Path::parent)
                .ok_or_else(|| anyhow!("rekordbox_db.python must be <venv>/bin/python"))?;
            info!(venv = %venv.display(), "creating python environment for pyrekordbox");
            run_checked(
                Command::new(&self.cfg.uv_bin)
                    .envs(uv_env())
                    .args(["venv", "--python", "3.12"])
                    .arg(venv),
            )?;
            run_checked(
                Command::new(&self.cfg.uv_bin)
                    .envs(uv_env())
                    .args(["pip", "install", "--python"])
                    .arg(&self.cfg.python)
                    .arg(format!("pyrekordbox=={}", self.cfg.pyrekordbox_version)),
            )?;
        }
        Ok(())
    }

    fn run_helper(&self, args: &[&str], input: Option<&Value>) -> anyhow::Result<HelperOutcome> {
        let mut command = Command::new(&self.helper.program);
        command
            .args(&self.helper.prefix_args)
            .arg("--db")
            .arg(&self.cfg.db_path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .with_context(|| format!("starting {}", self.helper.program.display()))?;
        if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
            use std::io::Write;
            stdin.write_all(&serde_json::to_vec(input)?)?;
        }
        let output = child.wait_with_output()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: Option<Value> = stdout
            .lines()
            .rev()
            .find_map(|l| serde_json::from_str(l).ok());
        match (output.status.code(), parsed) {
            (Some(0), Some(v)) => Ok(HelperOutcome::Done(v)),
            (Some(3), _) => Ok(HelperOutcome::RekordboxRunning),
            (_, Some(v)) => bail!(
                "{}",
                v.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("rekordbox helper failed")
            ),
            (code, None) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let tail: String = stderr.lines().rev().take(5).collect::<Vec<_>>().join(" | ");
                bail!("rekordbox helper exited {code:?}: {tail}")
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Note {
    created_at: String,
    reason: String,
}

enum HelperOutcome {
    Done(Value),
    RekordboxRunning,
}

/// MINOR when the helper created a playlist, PATCH when it added or moved
/// anything else, nothing when every op was already in place.
fn bump_for(result: &Value) -> Option<Bump> {
    let results = result.get("results")?.as_array()?;
    let flag = |key: &str| {
        results
            .iter()
            .any(|r| r.get(key).and_then(Value::as_bool) == Some(true))
    };
    if results
        .iter()
        .any(|r| r.get("playlist_id").is_some() && r.get("created") == Some(&json!(true)))
    {
        Some(Bump::Minor)
    } else if flag("created")
        || flag("added")
        || flag("removed")
        || flag("renamed")
        || flag("deleted")
    {
        Some(Bump::Patch)
    } else {
        None
    }
}

fn run_checked(command: &mut Command) -> anyhow::Result<()> {
    let out = command.output().context("running uv")?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// Is Rekordbox (the app, not its agent) running?
pub fn rekordbox_is_running() -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-x", "rekordbox"])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

/// Background loop: apply queued changes whenever Rekordbox is closed.
pub async fn run(library: Arc<RekordboxLibrary>, mut shutdown: watch::Receiver<bool>) {
    let every = Duration::from_secs(library.cfg.check_secs.max(2));
    let prep = library.clone();
    match tokio::task::spawn_blocking(move || prep.prepare_helper()).await {
        Ok(Ok(())) => info!(db = %library.cfg.db_path.display(), "rekordbox library sync ready"),
        Ok(Err(e)) => {
            error!(error = %format!("{e:#}"), "rekordbox helper setup failed; will retry")
        }
        Err(e) => error!(error = %e, "rekordbox helper setup panicked"),
    }
    loop {
        tokio::select! {
            _ = shutdown.wait_for(|s| *s) => return,
            _ = tokio::time::sleep(every) => {}
        }
        let lib = library.clone();
        let result = tokio::task::spawn_blocking(move || {
            lib.prepare_helper()?;
            lib.apply_pending()
        })
        .await;
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => warn!(error = %format!("{e:#}"), "couldn't update rekordbox library yet"),
            Err(e) => error!(error = %e, "rekordbox apply task panicked"),
        }
    }
}

/// uv keeps its Pythons and cache inside the toolbox (see `toolbox.rs`).
fn uv_env() -> Vec<(&'static str, PathBuf)> {
    crate::toolbox::ToolPaths::new(crate::toolbox::ToolPaths::default_root()).uv_env()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A stand-in for rbdb.py: appends to the "database" and answers with
    /// whatever JSON is in $FAKE_RESULT (or fails if $FAKE_FAIL is set).
    fn fake_helper(dir: &Path, result: &str, fail: bool) -> Helper {
        let script = dir.join("fake-rbdb.sh");
        let body = if fail {
            r#"echo '{"ok": false, "error": "file not found: /x.mp3"}'; exit 1"#.to_string()
        } else {
            format!(
                r#"db="$2"; cat > "$db.last-input"; printf 'changed\n' >> "$db"; echo '{result}'"#
            )
        };
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        Helper {
            program: "/bin/sh".into(),
            prefix_args: vec![script.into()],
        }
    }

    struct Rig {
        _tmp: tempfile::TempDir,
        db: PathBuf,
        running: Arc<AtomicBool>,
        lib: RekordboxLibrary,
    }

    fn rig(result: &str, fail: bool) -> Rig {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("master.db");
        std::fs::write(&db, "library v0\n").unwrap();
        let cfg = RekordboxDbCfg {
            enabled: true,
            db_path: db.clone(),
            keep_backups: 10,
            ..RekordboxDbCfg::default()
        };
        let running = Arc::new(AtomicBool::new(false));
        let flag = running.clone();
        let lib = RekordboxLibrary::with_parts(
            cfg,
            tmp.path().join("state"),
            fake_helper(tmp.path(), result, fail),
            Arc::new(move || flag.load(Ordering::SeqCst)),
        );
        Rig {
            _tmp: tmp,
            db,
            running,
            lib,
        }
    }

    const CREATED_PLAYLIST: &str = r#"{"ok": true, "applied": 2, "results": [{"content_id": "1", "created": true}, {"playlist_id": "9", "created": true}]}"#;

    #[test]
    fn waits_while_rekordbox_runs_then_applies_with_backups() {
        let r = rig(CREATED_PLAYLIST, false);
        r.lib
            .enqueue(
                "Add 1 track to “Friday”".into(),
                vec![json!({"op": "add_track", "path": "/a.mp3"})],
            )
            .unwrap();

        r.running.store(true, Ordering::SeqCst);
        assert!(r.lib.apply_pending().unwrap().is_none());
        assert_eq!(
            r.lib.status().pending.len(),
            1,
            "kept while Rekordbox is open"
        );
        assert_eq!(
            std::fs::read_to_string(&r.db).unwrap(),
            "library v0\n",
            "untouched"
        );

        r.running.store(false, Ordering::SeqCst);
        let applied = r.lib.apply_pending().unwrap().expect("applied");
        assert_eq!(
            applied.version.as_deref(),
            Some("1.1.0"),
            "baseline, then a new playlist"
        );
        let status = r.lib.status();
        assert!(status.pending.is_empty());
        let versions: Vec<_> = status.backups.iter().map(|b| b.version.as_str()).collect();
        assert_eq!(versions, ["1.1.0", "1.0.0"], "newest first");
        assert_eq!(status.backups[1].reason, "Library before dj-sync's changes");
        assert_eq!(status.backups[0].reason, "Add 1 track to “Friday”");
    }

    #[test]
    fn outside_changes_become_a_major_before_the_next_write() {
        let r = rig(r#"{"ok": true, "results": [{"added": true}]}"#, false);
        r.lib.enqueue("a".into(), vec![json!({"op": "x"})]).unwrap();
        r.lib.apply_pending().unwrap();
        // Rekordbox runs and changes its library.
        std::fs::write(&r.db, "edited in rekordbox\n").unwrap();
        r.lib.enqueue("b".into(), vec![json!({"op": "x"})]).unwrap();
        let applied = r.lib.apply_pending().unwrap().unwrap();
        assert_eq!(applied.version.as_deref(), Some("2.0.1"));
        assert_eq!(r.lib.status().backups[1].version, "2.0.0");
    }

    #[test]
    fn batches_are_merged_into_one_transaction_and_survive_restarts() {
        let r = rig(r#"{"ok": true, "results": []}"#, false);
        r.lib
            .enqueue("one".into(), vec![json!({"op": "a"})])
            .unwrap();
        r.lib
            .enqueue("two".into(), vec![json!({"op": "b"}), json!({"op": "c"})])
            .unwrap();
        // A second instance (dj-sync restarted) sees the same queue.
        let again = RekordboxLibrary::with_parts(
            r.lib.cfg.clone(),
            r.lib.state_dir.clone(),
            r.lib.helper.clone(),
            Arc::new(|| false),
        );
        assert_eq!(again.status().pending.len(), 2);
        let applied = again.apply_pending().unwrap().unwrap();
        assert_eq!(applied.summary, "one; two");
        let input = std::fs::read_to_string(r.db.with_file_name("master.db.last-input")).unwrap();
        let sent: Value = serde_json::from_str(&input).unwrap();
        assert_eq!(sent["ops"].as_array().unwrap().len(), 3);
        assert_eq!(
            applied.version.as_deref(),
            Some("1.0.0"),
            "nothing changed: no new version"
        );
    }

    #[test]
    fn failures_are_retried_then_set_aside() {
        let r = rig("", true);
        r.lib
            .enqueue("bad".into(), vec![json!({"op": "add_track"})])
            .unwrap();
        for _ in 0..MAX_ATTEMPTS {
            assert!(r.lib.apply_pending().is_err());
        }
        let s = r.lib.status();
        assert!(s.pending.is_empty());
        assert_eq!(s.failed.len(), 1);
        assert!(s.failed[0].error.contains("file not found"));
        assert!(s.last_error.is_some());
    }

    #[test]
    fn failed_batches_can_be_retried_or_dismissed() {
        let r = rig("", true);
        r.lib
            .enqueue("bad".into(), vec![json!({"op": "x"})])
            .unwrap();
        for _ in 0..MAX_ATTEMPTS {
            let _ = r.lib.apply_pending();
        }
        assert_eq!(r.lib.status().failed.len(), 1);
        assert_eq!(r.lib.retry_failed().unwrap(), 1);
        let s = r.lib.status();
        assert_eq!((s.pending.len(), s.failed.len()), (1, 0));
        for _ in 0..MAX_ATTEMPTS {
            let _ = r.lib.apply_pending();
        }
        assert_eq!(r.lib.dismiss_failed().unwrap(), 1);
        let s = r.lib.status();
        assert_eq!((s.pending.len(), s.failed.len()), (0, 0));
    }

    #[test]
    fn restore_needs_rekordbox_closed_and_is_itself_undoable() {
        let r = rig(CREATED_PLAYLIST, false);
        r.lib.enqueue("x".into(), vec![json!({"op": "x"})]).unwrap();
        r.lib.apply_pending().unwrap(); // 1.0.0 (before) and 1.1.0 (after)
        assert_ne!(std::fs::read_to_string(&r.db).unwrap(), "library v0\n");

        r.running.store(true, Ordering::SeqCst);
        assert!(r
            .lib
            .restore("1.0.0")
            .unwrap_err()
            .to_string()
            .contains("Quit Rekordbox"));

        r.running.store(false, Ordering::SeqCst);
        let msg = r.lib.restore("v1.0.0").unwrap();
        assert!(msg.contains("v1.0.0"), "{msg}");
        assert_eq!(std::fs::read_to_string(&r.db).unwrap(), "library v0\n");
        assert!(r.lib.restore("7.7.7").is_err());
    }

    #[test]
    fn batch_outcomes_track_each_batch() {
        let r = rig(CREATED_PLAYLIST, false);
        let id = r.lib.enqueue("x".into(), vec![json!({"op": "x"})]).unwrap();
        assert_eq!(r.lib.batch_outcome(&id), BatchOutcome::Pending);
        r.lib.apply_pending().unwrap();
        assert_eq!(
            r.lib.batch_outcome(&id),
            BatchOutcome::Applied {
                version: Some("1.1.0".into())
            }
        );
        assert_eq!(r.lib.batch_outcome("nope"), BatchOutcome::Unknown);
    }

    #[test]
    fn bump_rules() {
        assert_eq!(
            bump_for(&json!({"results": [{"playlist_id": "1", "created": true}]})),
            Some(Bump::Minor)
        );
        assert_eq!(
            bump_for(
                &json!({"results": [{"playlist_id": "1", "created": false}, {"added": true}]})
            ),
            Some(Bump::Patch)
        );
        assert_eq!(
            bump_for(&json!({"results": [{"content_id": "1", "created": true}]})),
            Some(Bump::Patch)
        );
        assert_eq!(bump_for(&json!({"results": [{"added": false}]})), None);
    }
}
