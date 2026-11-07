//! One DJ app's library, kept in step with downloads and playlist edits.
//!
//! The rules are the same for every app, so they live here and each app only
//! supplies a [`Backend`] (`rekordbox_db.rs`, `serato.rs`):
//!
//! - Changes are queued in `~/.dj-sync/<key>-pending.json` and applied only
//!   while the app is closed, because it overwrites its library on exit.
//! - Every apply is bracketed by semver snapshots in `~/.dj-sync/<key>-backups/`:
//!   before it (MAJOR when the app itself changed the library since dj-sync
//!   last wrote) and after it (MINOR when a playlist was created, PATCH when
//!   only tracks moved).
//! - Any snapshot can be restored (app closed); the current library is
//!   snapshotted first, so a restore can itself be undone.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::settings::{DjApp, Settings};
use crate::xml_versions::{Bump, Version, Versions};

/// After this many failed attempts a batch is set aside instead of retried.
pub(crate) const MAX_ATTEMPTS: u32 = 3;

/// What one DJ app has to provide.
pub trait Backend: Send + Sync {
    /// The app as people know it: "Rekordbox", "Serato".
    fn app(&self) -> &'static str;
    /// Prefix of the state files: `<key>-pending.json`, `<key>-backups/`.
    fn key(&self) -> &'static str;
    /// `(stem, ext)` of backup files: `<stem>.vX.Y.Z.<ext>`.
    fn backup_name(&self) -> (&'static str, &'static str);
    fn keep_backups(&self) -> usize;
    /// How often to check whether the app has closed.
    fn check_secs(&self) -> u64;
    fn running(&self) -> bool;
    /// The library, for the status page.
    fn location(&self) -> PathBuf;
    /// The library as one file (backups are semver copies of it), up to date.
    fn library_file(&self) -> anyhow::Result<PathBuf>;
    /// Anything the backend needs before it can apply.
    fn prepare(&self) -> anyhow::Result<()> {
        Ok(())
    }
    /// Apply ops as one transaction: all of them, or none.
    fn apply(&self, ops: Vec<Value>, own_dirs: &[PathBuf]) -> anyhow::Result<ApplyOutcome>;
    /// Read-only snapshot of playlists and tracks (safe while the app runs).
    fn snapshot(&self) -> anyhow::Result<Value>;
    /// Changes when the library does.
    fn change_stamp(&self) -> Option<SystemTime>;
    /// `file` was just put back from a backup; make it the live library.
    fn restored(&self, _file: &Path) -> anyhow::Result<()> {
        Ok(())
    }
    /// Said after a restore, for apps that pick it up in their own time.
    fn restore_note(&self) -> &'static str {
        ""
    }
    /// One-time work at startup, as ops to queue: `(marker, summary, ops)`.
    fn startup_batch(&self, _own_dirs: &[PathBuf]) -> Option<(&'static str, String, Vec<Value>)> {
        None
    }
}

pub enum ApplyOutcome {
    Done(Value),
    /// The app opened before the write started: the batch stays queued.
    AppRunning,
}

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
pub(crate) struct Pending {
    pub(crate) batches: Vec<Batch>,
    #[serde(default)]
    pub(crate) failed: Vec<FailedBatch>,
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
    /// "Rekordbox" or "Serato".
    pub app: String,
    pub db_path: PathBuf,
    pub app_running: bool,
    /// `app_running`, for menu apps older than this service during an update.
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

/// dj-sync's download folders (read fresh: the menu bar app can change them).
type OwnDirs = Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>;

pub struct DjLibrary {
    backend: Box<dyn Backend>,
    state_dir: PathBuf,
    own_dirs: OwnDirs,
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

impl DjLibrary {
    pub fn new(backend: Box<dyn Backend>, state_dir: PathBuf) -> Self {
        Self {
            backend,
            state_dir,
            own_dirs: Arc::new(Vec::new),
            lock: Mutex::new(Memory::default()),
        }
    }

    /// Where dj-sync downloads to, for backends that treat those tracks
    /// specially (see `repair_tracks` in rbdb.py).
    pub fn with_own_dirs(
        mut self,
        dirs: impl Fn() -> Vec<PathBuf> + Send + Sync + 'static,
    ) -> Self {
        self.own_dirs = Arc::new(dirs);
        self
    }

    pub fn app(&self) -> &'static str {
        self.backend.app()
    }

    pub fn app_running(&self) -> bool {
        self.backend.running()
    }

    pub fn change_stamp(&self) -> Option<SystemTime> {
        self.backend.change_stamp()
    }

    pub fn prepare(&self) -> anyhow::Result<()> {
        self.backend.prepare()
    }

    /// Queue the backend's one-time work, once.
    pub fn queue_startup_once(&self) -> anyhow::Result<()> {
        let own_dirs = (self.own_dirs)();
        let Some((marker, summary, ops)) = self.backend.startup_batch(&own_dirs) else {
            return Ok(());
        };
        let marker = self.state_dir.join(marker);
        if marker.exists() {
            return Ok(());
        }
        if !ops.is_empty() {
            self.enqueue(summary, ops)?;
            info!(app = self.app(), "queued one-time library work");
        }
        std::fs::create_dir_all(&self.state_dir)?;
        std::fs::write(&marker, now())?;
        Ok(())
    }

    fn pending_path(&self) -> PathBuf {
        self.state_dir
            .join(format!("{}-pending.json", self.backend.key()))
    }

    fn versions(&self) -> Versions {
        let (stem, ext) = self.backend.backup_name();
        Versions::in_dir(&self.backups_dir(), stem, ext, self.backend.keep_backups())
    }

    fn backups_dir(&self) -> PathBuf {
        self.state_dir
            .join(format!("{}-backups", self.backend.key()))
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

    /// Read-only snapshot of playlists and tracks (safe while the app runs).
    pub fn snapshot(&self) -> anyhow::Result<Value> {
        self.backend.snapshot()
    }

    pub fn current_version(&self) -> Option<String> {
        self.versions().latest().map(|(v, _)| v.to_string())
    }

    fn read_pending(&self) -> Pending {
        match std::fs::read_to_string(self.pending_path()) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                error!(app = self.app(), error = %e, "pending file is unreadable; starting empty");
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

    /// Apply everything queued, if the app is closed. `Ok(None)` when there
    /// was nothing to do or the app is open (changes stay queued).
    pub fn apply_pending(&self) -> anyhow::Result<Option<Applied>> {
        let mut memory = self.lock.lock().expect("library lock");
        let mut pending = self.read_pending();
        if pending.batches.is_empty() || self.backend.running() {
            return Ok(None);
        }

        let versions = self.versions();
        let file = self.backend.library_file()?;
        let before = versions
            .reconcile(&file)
            .context("backing up the library")?;
        self.note_backup(before, "Library before dj-sync's changes");

        let ops: Vec<Value> = pending.batches.iter().flat_map(|b| b.ops.clone()).collect();
        let mut summary = pending
            .batches
            .iter()
            .map(|b| b.summary.as_str())
            .collect::<Vec<_>>()
            .join("; ");

        match self.backend.apply(ops, &(self.own_dirs)()) {
            Ok(ApplyOutcome::Done(result)) => {
                let repaired = repaired_in(&result);
                if repaired > 0 {
                    warn!(
                        repaired,
                        "repaired dj-sync tracks the app couldn't load to a deck"
                    );
                    summary.push_str(&format!(
                        "; fixed {repaired} song(s) that wouldn't load to a deck"
                    ));
                }
                let bump = bump_for(&result);
                let version = match bump {
                    Some(bump) => {
                        let file = self.backend.library_file()?;
                        let v = versions.record(&file, before, bump)?;
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
                info!(app = self.app(), version = ?applied.version, summary = %applied.summary, "library updated");
                memory.last_applied = Some(applied.clone());
                memory.last_error = None;
                Ok(Some(applied))
            }
            Ok(ApplyOutcome::AppRunning) => Ok(None),
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
                    warn!(app = self.app(), batch = %batch.id, error = %message, "giving up on library batch");
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

    /// Back up the library as it is now (v1.0.0 on a fresh install), before
    /// DJ Sync ever changes it. Needs the app closed, like every write.
    pub fn ensure_baseline(&self) -> anyhow::Result<String> {
        let _memory = self.lock.lock().expect("library lock");
        let app = self.app();
        if self.backend.running() {
            bail!("{app} is open: your library will be backed up before DJ Sync's first change.");
        }
        let file = self.backend.library_file()?;
        anyhow::ensure!(
            file.is_file(),
            "no {app} library at {}",
            self.backend.location().display()
        );
        let version = self
            .versions()
            .reconcile(&file)
            .context("backing up the library")?
            .ok_or_else(|| anyhow!("couldn't back up the library"))?;
        self.note_backup(Some(version), "Your library as it was before DJ Sync");
        Ok(version.to_string())
    }

    // ---------- restore ----------

    pub fn restore(&self, version: &str) -> anyhow::Result<String> {
        let target = Version::parse(version.trim_start_matches('v'))
            .ok_or_else(|| anyhow!("not a version: {version}"))?;
        let mut memory = self.lock.lock().expect("library lock");
        let app = self.app();
        if self.backend.running() {
            bail!("Quit {app} first: its library can only be restored while it's closed.");
        }
        let versions = self.versions();
        anyhow::ensure!(versions.path_for(target).exists(), "no backup v{target}");
        // Keep what's there now, so the restore itself can be undone.
        let file = self.backend.library_file()?;
        let safety = versions.reconcile(&file)?;
        self.note_backup(safety, &format!("Before restoring v{target}"));
        versions.restore(target, &file)?;
        self.backend.restored(&file)?;
        let message = format!(
            "Restored your {app} library to v{target}. The library before the restore is v{}.{}",
            safety.map(|v| v.to_string()).unwrap_or_else(|| "–".into()),
            self.backend.restore_note(),
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
        let running = self.backend.running();
        LibraryStatus {
            app: self.app().to_string(),
            db_path: self.backend.location(),
            app_running: running,
            rekordbox_running: running,
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Note {
    created_at: String,
    reason: String,
}

/// MINOR when a playlist was created, PATCH when anything else was added or
/// moved, nothing when every op was already in place.
pub(crate) fn bump_for(result: &Value) -> Option<Bump> {
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
        || repaired_in(result) > 0
    {
        Some(Bump::Patch)
    } else {
        None
    }
}

/// Tracks `repair_tracks` fixed in this apply.
fn repaired_in(result: &Value) -> u64 {
    result
        .get("results")
        .and_then(Value::as_array)
        .map(|rs| rs.iter().filter_map(|r| r.get("repaired")?.as_u64()).sum())
        .unwrap_or(0)
}

fn now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

/// Background loop: apply queued changes whenever the app is closed.
pub async fn run(library: Arc<DjLibrary>, mut shutdown: watch::Receiver<bool>) {
    let every = Duration::from_secs(library.backend.check_secs().max(2));
    let app = library.app();
    let prep = library.clone();
    match tokio::task::spawn_blocking(move || prep.prepare()).await {
        Ok(Ok(())) => info!(app, "library sync ready"),
        Ok(Err(e)) => error!(app, error = %format!("{e:#}"), "library setup failed; will retry"),
        Err(e) => error!(app, error = %e, "library setup panicked"),
    }
    if let Err(e) = library.queue_startup_once() {
        warn!(app, error = %format!("{e:#}"), "couldn't queue one-time library work");
    }
    loop {
        tokio::select! {
            _ = shutdown.wait_for(|s| *s) => return,
            _ = tokio::time::sleep(every) => {}
        }
        let lib = library.clone();
        let result = tokio::task::spawn_blocking(move || {
            lib.prepare()?;
            lib.apply_pending()
        })
        .await;
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => warn!(app, error = %format!("{e:#}"), "couldn't update the library yet"),
            Err(e) => error!(app, error = %e, "library apply task panicked"),
        }
    }
}

/// The DJ apps on this Mac, and which of them the DJ is using right now.
/// Cheap to clone. The choice is read fresh from `settings.json`, so changing
/// it in the menu bar app takes effect on the next job, with no restart.
#[derive(Clone, Default)]
pub struct Libraries {
    rekordbox: Option<Arc<DjLibrary>>,
    serato: Option<Arc<DjLibrary>>,
    settings_file: Option<PathBuf>,
}

impl Libraries {
    pub fn new(
        rekordbox: Option<Arc<DjLibrary>>,
        serato: Option<Arc<DjLibrary>>,
        settings_file: Option<PathBuf>,
    ) -> Self {
        Self {
            rekordbox,
            serato,
            settings_file,
        }
    }

    /// Only this library (tests, and Macs with one app).
    pub fn single(lib: Arc<DjLibrary>) -> Self {
        Self {
            rekordbox: Some(lib),
            ..Self::default()
        }
    }

    pub fn is_empty(&self) -> bool {
        self.rekordbox.is_none() && self.serato.is_none()
    }

    pub fn rekordbox(&self) -> Option<&Arc<DjLibrary>> {
        self.rekordbox.as_ref()
    }

    pub fn serato(&self) -> Option<&Arc<DjLibrary>> {
        self.serato.as_ref()
    }

    /// By the name the local API uses: `rekordbox` or `serato`.
    pub fn by_key(&self, key: &str) -> Option<Arc<DjLibrary>> {
        match key {
            "rekordbox" => self.rekordbox.clone(),
            "serato" => self.serato.clone(),
            _ => None,
        }
    }

    /// Every library on this Mac, in use or not.
    pub fn all(&self) -> Vec<Arc<DjLibrary>> {
        self.rekordbox
            .iter()
            .chain(self.serato.iter())
            .cloned()
            .collect()
    }

    /// The libraries downloads go into. Macs that never chose keep what they
    /// had: Rekordbox if it's here, else Serato. A choice that can't be met
    /// (that app's library is gone) falls back to the same.
    pub fn active(&self) -> Vec<Arc<DjLibrary>> {
        let choice = self
            .settings_file
            .as_deref()
            .map(Settings::load_from)
            .map(|s| s.dj_app())
            .unwrap_or_default();
        let (rekordbox, serato) = (self.rekordbox.as_ref(), self.serato.as_ref());
        let chosen: Vec<&Arc<DjLibrary>> = match choice {
            DjApp::Auto => Vec::new(),
            DjApp::Rekordbox => rekordbox.into_iter().collect(),
            DjApp::Serato => serato.into_iter().collect(),
            DjApp::Both => rekordbox.into_iter().chain(serato).collect(),
        };
        if chosen.is_empty() {
            return rekordbox.or(serato).cloned().into_iter().collect();
        }
        chosen.into_iter().cloned().collect()
    }

    /// The library assistants browse and edit. With both apps in use that's
    /// Rekordbox: playlist ids are per-library, so edits go to one of them.
    pub fn primary(&self) -> Option<Arc<DjLibrary>> {
        self.active().into_iter().next()
    }

    /// Where a batch stands, whichever library it was queued in.
    pub fn batch_outcome(&self, id: &str) -> (BatchOutcome, &'static str) {
        for lib in self.all() {
            let outcome = lib.batch_outcome(id);
            if outcome != BatchOutcome::Unknown {
                return (outcome, lib.app());
            }
        }
        let app = self.primary().map_or("DJ", |l| l.app());
        (BatchOutcome::Unknown, app)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(&'static str);

    impl Backend for Fake {
        fn app(&self) -> &'static str {
            self.0
        }
        fn key(&self) -> &'static str {
            "fake"
        }
        fn backup_name(&self) -> (&'static str, &'static str) {
            ("fake", "bin")
        }
        fn keep_backups(&self) -> usize {
            3
        }
        fn check_secs(&self) -> u64 {
            3
        }
        fn running(&self) -> bool {
            false
        }
        fn location(&self) -> PathBuf {
            PathBuf::new()
        }
        fn library_file(&self) -> anyhow::Result<PathBuf> {
            Ok(PathBuf::new())
        }
        fn apply(&self, _: Vec<Value>, _: &[PathBuf]) -> anyhow::Result<ApplyOutcome> {
            Ok(ApplyOutcome::Done(json!({"results": []})))
        }
        fn snapshot(&self) -> anyhow::Result<Value> {
            Ok(json!({}))
        }
        fn change_stamp(&self) -> Option<SystemTime> {
            None
        }
    }

    fn lib(app: &'static str) -> Arc<DjLibrary> {
        Arc::new(DjLibrary::new(Box::new(Fake(app)), PathBuf::from("/tmp/x")))
    }

    fn apps(libs: &Libraries) -> Vec<&'static str> {
        libs.active().iter().map(|l| l.app()).collect()
    }

    fn with_choice(rb: bool, serato: bool, choice: Option<&str>) -> (tempfile::TempDir, Libraries) {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        if let Some(choice) = choice {
            std::fs::write(&file, format!(r#"{{"dj_app": "{choice}"}}"#)).unwrap();
        }
        let libs = Libraries::new(
            rb.then(|| lib("Rekordbox")),
            serato.then(|| lib("Serato")),
            Some(file),
        );
        (tmp, libs)
    }

    #[test]
    fn a_mac_that_never_chose_keeps_rekordbox_and_serato_only_macs_get_serato() {
        assert_eq!(apps(&with_choice(true, true, None).1), ["Rekordbox"]);
        assert_eq!(apps(&with_choice(true, false, None).1), ["Rekordbox"]);
        assert_eq!(apps(&with_choice(false, true, None).1), ["Serato"]);
        assert!(apps(&with_choice(false, false, None).1).is_empty());
    }

    #[test]
    fn the_djs_choice_wins_and_rekordbox_stays_primary_with_both() {
        assert_eq!(apps(&with_choice(true, true, Some("serato")).1), ["Serato"]);
        let (_tmp, both) = with_choice(true, true, Some("both"));
        assert_eq!(apps(&both), ["Rekordbox", "Serato"]);
        assert_eq!(both.primary().unwrap().app(), "Rekordbox");
    }

    #[test]
    fn a_choice_that_cant_be_met_falls_back_instead_of_going_quiet() {
        assert_eq!(
            apps(&with_choice(true, false, Some("serato")).1),
            ["Rekordbox"]
        );
        assert_eq!(
            apps(&with_choice(false, true, Some("rekordbox")).1),
            ["Serato"]
        );
        assert_eq!(apps(&with_choice(false, true, Some("both")).1), ["Serato"]);
    }

    #[test]
    fn an_unreadable_choice_is_treated_as_never_chosen() {
        assert_eq!(apps(&with_choice(true, true, Some("cdj")).1), ["Rekordbox"]);
    }
}
