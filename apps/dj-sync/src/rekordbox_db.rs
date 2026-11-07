//! Rekordbox's own library (`master.db`), alongside the import XML (which
//! works while Rekordbox is open; this is what makes tracks appear in the
//! real Collection/Playlists). Queueing, backups and restore are shared with
//! the other DJ apps (`dj_library.rs`); what's here is how Rekordbox is
//! written: `rekordbox/rbdb.py` (pyrekordbox), a backup is a copy of master.db.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::{anyhow, bail, Context};
use serde_json::{json, Value};
use tracing::info;

use crate::config::RekordboxDbCfg;
use crate::dj_library::{ApplyOutcome, Backend, DjLibrary};

/// The helper script, bundled into the binary and installed next to the
/// state files (launchd can't read the repo under ~/Desktop).
const HELPER_SOURCE: &str = include_str!("../rekordbox/rbdb.py");

/// How to run `rbdb.py`. Tests swap in a fake.
#[derive(Debug, Clone)]
pub struct Helper {
    pub program: PathBuf,
    pub prefix_args: Vec<OsString>,
}

type RunningCheck = Arc<dyn Fn() -> bool + Send + Sync>;

/// Marks the one-time repair of tracks added before 1.2.1 as queued.
const REPAIR_MARKER: &str = "rekordbox-repair-content-link";

/// The real thing: helper in `~/.dj-sync`, run by the managed venv's python,
/// Rekordbox detected with `pgrep`.
pub fn library(cfg: RekordboxDbCfg, state_dir: PathBuf) -> DjLibrary {
    let helper = Helper {
        program: cfg.python.clone(),
        prefix_args: vec!["-I".into(), state_dir.join("rbdb.py").into()],
    };
    library_with_parts(cfg, state_dir, helper, Arc::new(rekordbox_is_running))
}

pub fn library_with_parts(
    cfg: RekordboxDbCfg,
    state_dir: PathBuf,
    helper: Helper,
    running: RunningCheck,
) -> DjLibrary {
    let backend = Rekordbox {
        cfg,
        state_dir: state_dir.clone(),
        helper,
        running,
    };
    DjLibrary::new(Box::new(backend), state_dir)
}

struct Rekordbox {
    cfg: RekordboxDbCfg,
    state_dir: PathBuf,
    helper: Helper,
    running: RunningCheck,
}

impl Backend for Rekordbox {
    fn app(&self) -> &'static str {
        "Rekordbox"
    }

    fn key(&self) -> &'static str {
        "rekordbox"
    }

    fn backup_name(&self) -> (&'static str, &'static str) {
        ("master", "db")
    }

    fn keep_backups(&self) -> usize {
        self.cfg.keep_backups
    }

    fn check_secs(&self) -> u64 {
        self.cfg.check_secs
    }

    fn running(&self) -> bool {
        (self.running)()
    }

    fn location(&self) -> PathBuf {
        self.cfg.db_path.clone()
    }

    fn library_file(&self) -> anyhow::Result<PathBuf> {
        Ok(self.cfg.db_path.clone())
    }

    fn prepare(&self) -> anyhow::Result<()> {
        self.prepare_helper()
    }

    /// Every apply first repairs the tracks in the download folders that
    /// Rekordbox can't load (see `repair_tracks` in rbdb.py).
    fn apply(&self, mut ops: Vec<Value>, own_dirs: &[PathBuf]) -> anyhow::Result<ApplyOutcome> {
        if !own_dirs.is_empty() {
            ops.insert(0, json!({"op": "repair_tracks"}));
        }
        self.run_helper(
            &["apply"],
            Some(&json!({ "ops": ops, "own_dirs": own_dirs })),
        )
    }

    fn snapshot(&self) -> anyhow::Result<Value> {
        match self.run_helper(&["snapshot"], None)? {
            ApplyOutcome::Done(v) => Ok(v),
            ApplyOutcome::AppRunning => bail!("unexpected: snapshot refused"),
        }
    }

    fn change_stamp(&self) -> Option<SystemTime> {
        std::fs::metadata(&self.cfg.db_path)
            .and_then(|m| m.modified())
            .ok()
    }

    /// Queue the repair once for libraries that already have dj-sync's tracks
    /// (added before 1.2.1, they preview but never load to a deck).
    fn startup_batch(&self, own_dirs: &[PathBuf]) -> Option<(&'static str, String, Vec<Value>)> {
        let has_tracks = own_dirs.iter().any(|d| {
            std::fs::read_dir(d)
                .map(|mut rd| rd.any(|e| e.map(|e| e.path().is_file()).unwrap_or(false)))
                .unwrap_or(false)
        });
        let ops = if has_tracks {
            vec![json!({"op": "repair_tracks"})]
        } else {
            Vec::new()
        };
        Some((
            REPAIR_MARKER,
            "Repair songs that wouldn't load to a deck".into(),
            ops,
        ))
    }
}

impl Rekordbox {
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

    fn run_helper(&self, args: &[&str], input: Option<&Value>) -> anyhow::Result<ApplyOutcome> {
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
            (Some(0), Some(v)) => Ok(ApplyOutcome::Done(v)),
            (Some(3), _) => Ok(ApplyOutcome::AppRunning),
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

fn run_checked(command: &mut Command) -> anyhow::Result<()> {
    let out = command.output().context("running uv")?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

pub fn rekordbox_is_running() -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-x", "rekordbox"])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// uv keeps its Pythons and cache inside the toolbox (see `toolbox.rs`).
fn uv_env() -> Vec<(&'static str, PathBuf)> {
    crate::toolbox::ToolPaths::new(crate::toolbox::ToolPaths::default_root()).uv_env()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dj_library::{bump_for, BatchOutcome, MAX_ATTEMPTS};
    use crate::xml_versions::Bump;
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
        cfg: RekordboxDbCfg,
        state: PathBuf,
        helper: Helper,
        lib: DjLibrary,
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
        let state = tmp.path().join("state");
        let helper = fake_helper(tmp.path(), result, fail);
        let lib = library_with_parts(
            cfg.clone(),
            state.clone(),
            helper.clone(),
            Arc::new(move || flag.load(Ordering::SeqCst)),
        );
        Rig {
            _tmp: tmp,
            db,
            running,
            cfg,
            state,
            helper,
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
        let again = library_with_parts(
            r.cfg.clone(),
            r.state.clone(),
            r.helper.clone(),
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
    fn the_baseline_backup_is_taken_once_and_needs_rekordbox_closed() {
        let r = rig("", false);
        r.running.store(true, Ordering::SeqCst);
        assert!(r.lib.ensure_baseline().is_err());
        r.running.store(false, Ordering::SeqCst);
        assert_eq!(r.lib.ensure_baseline().unwrap(), "1.0.0");
        assert_eq!(
            r.lib.ensure_baseline().unwrap(),
            "1.0.0",
            "unchanged library: same backup"
        );
        let s = r.lib.status();
        assert_eq!(s.backups.len(), 1);
        assert_eq!(s.backups[0].reason, "Your library as it was before DJ Sync");
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
        assert_eq!(
            bump_for(&json!({"results": [{"repaired": 3}]})),
            Some(Bump::Patch)
        );
        assert_eq!(bump_for(&json!({"results": [{"repaired": 0}]})), None);
    }

    #[test]
    fn every_apply_repairs_tracks_in_the_download_folders() {
        let r = rig(
            r#"{"ok": true, "results": [{"repaired": 2}, {"added": false}]}"#,
            false,
        );
        let downloads = r._tmp.path().join("DJ_Downloads");
        let dir = downloads.clone();
        let lib = library_with_parts(
            r.cfg.clone(),
            r.state.clone(),
            r.helper.clone(),
            Arc::new(|| false),
        )
        .with_own_dirs(move || vec![dir.clone()]);
        lib.enqueue("Add 1 track to “Friday”".into(), vec![json!({"op": "x"})])
            .unwrap();
        let applied = lib.apply_pending().unwrap().unwrap();

        let input = std::fs::read_to_string(r.db.with_file_name("master.db.last-input")).unwrap();
        let sent: Value = serde_json::from_str(&input).unwrap();
        assert_eq!(
            sent["ops"][0],
            json!({"op": "repair_tracks"}),
            "repair first"
        );
        assert_eq!(sent["ops"].as_array().unwrap().len(), 2);
        assert_eq!(sent["own_dirs"], json!([downloads]));
        assert_eq!(
            applied.version.as_deref(),
            Some("1.0.1"),
            "a repair is a change"
        );
        assert_eq!(
            applied.summary,
            "Add 1 track to “Friday”; fixed 2 song(s) that wouldn't load to a deck"
        );
    }

    #[test]
    fn the_track_repair_is_queued_once_and_only_with_downloads() {
        let r = rig(CREATED_PLAYLIST, false);
        let empty = r._tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let fresh = library_with_parts(
            r.cfg.clone(),
            r._tmp.path().join("fresh-state"),
            r.helper.clone(),
            Arc::new(|| false),
        )
        .with_own_dirs(move || vec![empty.clone()]);
        fresh.queue_startup_once().unwrap();
        assert!(
            fresh.status().pending.is_empty(),
            "nothing downloaded: nothing to repair"
        );

        let downloads = r._tmp.path().join("DJ_Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join("a.mp3"), "x").unwrap();
        let lib = library_with_parts(
            r.cfg.clone(),
            r.state.clone(),
            r.helper.clone(),
            Arc::new(|| false),
        )
        .with_own_dirs(move || vec![downloads.clone()]);
        lib.queue_startup_once().unwrap();
        lib.queue_startup_once().unwrap();
        let pending = lib.status().pending;
        assert_eq!(pending.len(), 1, "queued once");
        assert_eq!(
            pending[0].summary,
            "Repair songs that wouldn't load to a deck"
        );
    }
}
