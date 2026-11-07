//! What both cloud lanes share, whatever the transport (v1 HTTP polling in
//! `cloud.rs`, v2 WebSocket in `cloud_v2.rs`): turning a claimed cloud job
//! into local work, deciding when its result can be reported, and keeping
//! the library snapshot the Worker serves to ChatGPT.
//!
//! A result stays pending until the transport says the Worker accepted it
//! (`reported`), so a dropped connection means "send it again", never "lost".

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::dj_library::{BatchOutcome, DjLibrary, Libraries};
use crate::jobs::{JobError, JobKind, JobQueue, JobState, JobTrack, LibraryWork};
use crate::parser::extract_media_ref;

/// A job handed to this Mac by the Worker (v1 poll response or v2 `job`
/// message; unknown fields such as `type` are ignored).
#[derive(Debug, Clone, Deserialize)]
pub struct ClaimedJob {
    pub job_id: String,
    #[serde(default)]
    pub playlist: String,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub attempt: u32,
    /// "download" (default) or "library".
    #[serde(default)]
    pub kind: Option<String>,
    /// rbdb.py ops for library jobs.
    #[serde(default)]
    pub ops: Vec<Value>,
    #[serde(default)]
    pub summary: Option<String>,
    /// The existing playlist the name resolved to, in the app it was asked of.
    #[serde(default)]
    pub playlist_id: Option<String>,
    /// The DJ app the request named. `None`: the default.
    #[serde(default)]
    pub app: Option<String>,
}

/// A job's result as the Worker receives it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Completion {
    pub state: &'static str,
    pub message: String,
    pub tracks: Vec<JobTrack>,
    pub errors: Vec<JobError>,
    pub xml_version: Option<String>,
    pub library_version: Option<String>,
}

impl Completion {
    pub fn new(state: &'static str, message: impl Into<String>) -> Self {
        Self {
            state,
            message: message.into(),
            tracks: vec![],
            errors: vec![],
            xml_version: None,
            library_version: None,
        }
    }

    pub fn failed(message: impl Into<String>, errors: Vec<JobError>) -> Self {
        Self {
            errors,
            ..Self::new("failed", message)
        }
    }
}

pub struct AgentCore {
    jobs: JobQueue,
    /// cloud job id → local job id, for jobs started but not yet reported.
    active: HashMap<String, String>,
    /// Jobs that couldn't start here; reported like any other result.
    rejected: HashMap<String, Completion>,
    library: Option<LibrarySync>,
}

impl AgentCore {
    pub fn new(jobs: JobQueue) -> Self {
        Self {
            jobs,
            active: HashMap::new(),
            rejected: HashMap::new(),
            library: None,
        }
    }

    /// Share the library snapshot and take playlist (library) jobs too.
    pub fn with_library(mut self, libraries: Libraries) -> Self {
        self.library = (!libraries.is_empty()).then(|| LibrarySync::new(libraries));
        self
    }

    /// Every cloud job this Mac still owes a result for.
    pub fn active_ids(&self) -> Vec<String> {
        self.active
            .keys()
            .chain(self.rejected.keys())
            .cloned()
            .collect()
    }

    /// Nothing outstanding: ready to take another job.
    pub fn is_idle(&self) -> bool {
        self.active.is_empty() && self.rejected.is_empty()
    }

    /// Start a claimed job. A job that can't run here gets a `failed`
    /// result straight away, reported through `finished` like the rest.
    pub fn start(&mut self, job: ClaimedJob) {
        info!(
            cloud_job = %job.job_id,
            kind = job.kind.as_deref().unwrap_or("download"),
            attempt = job.attempt,
            links = job.urls.len(),
            playlist = %job.playlist,
            "claimed cloud job"
        );
        let started = if job.kind.as_deref() == Some("library") {
            self.start_library(&job)
        } else {
            self.start_download(&job)
        };
        match started {
            Ok(local) => {
                self.active.insert(job.job_id, local);
            }
            Err(result) => {
                self.rejected.insert(job.job_id, *result);
            }
        }
    }

    fn start_download(&self, job: &ClaimedJob) -> Result<String, Box<Completion>> {
        // The Worker already validated these; re-check here anyway.
        let mut media = Vec::new();
        let mut rejected = Vec::new();
        for u in &job.urls {
            match extract_media_ref(u) {
                Ok(m) if !media.contains(&m) => media.push(m),
                Ok(_) => {}
                Err(reason) => rejected.push(JobError {
                    url: u.clone(),
                    error: reason,
                }),
            }
        }
        if media.is_empty() {
            return Err(Box::new(Completion::failed(
                "None of the links can be downloaded on this Mac.",
                rejected,
            )));
        }
        self.jobs
            .submit_to(
                media,
                Some(&job.playlist),
                job.playlist_id.clone(),
                job.app.clone(),
            )
            .map(|sub| sub.job.job_id)
            .map_err(|e| {
                Box::new(Completion::failed(
                    format!("Could not queue on the Mac: {e:#}"),
                    rejected,
                ))
            })
    }

    fn start_library(&self, job: &ClaimedJob) -> Result<String, Box<Completion>> {
        let Some(sync) = self.library.as_ref() else {
            return Err(Box::new(Completion::failed(
                "This Mac has no DJ library DJ Sync can write to.",
                vec![],
            )));
        };
        let known = sync.paths_for(job.app.as_deref());
        let paths = job
            .ops
            .iter()
            .filter_map(|op| op.get("content_id").and_then(Value::as_str))
            .filter_map(|id| known?.get(id).map(|p| (id.to_string(), p.clone())))
            .collect();
        let work = LibraryWork {
            summary: job
                .summary
                .clone()
                .unwrap_or_else(|| "Playlist change".into()),
            playlist: job.playlist.clone(),
            ops: job.ops.clone(),
            paths,
            app: job.app.clone(),
        };
        self.jobs
            .submit_library(work)
            .map(|sub| sub.job.job_id)
            .map_err(|e| {
                Box::new(Completion::failed(
                    format!("Could not queue on the Mac: {e:#}"),
                    vec![],
                ))
            })
    }

    /// Results ready to report now. They stay pending until `reported`.
    pub fn finished(&self) -> Vec<(String, Completion)> {
        let mut out: Vec<(String, Completion)> = self
            .rejected
            .iter()
            .map(|(id, c)| (id.clone(), c.clone()))
            .collect();
        for (cloud_id, local) in &self.active {
            if let Some(result) = self.result_for(local) {
                out.push((cloud_id.clone(), result));
            }
        }
        out
    }

    fn result_for(&self, local: &str) -> Option<Completion> {
        let Some(s) = self.jobs.get(local) else {
            return Some(Completion::failed(
                "The Mac lost track of this job.",
                vec![],
            ));
        };
        if s.state.is_active() {
            return None;
        }
        // A playlist change is done when it reaches the DJ's library, not
        // when it's queued: keep the cloud job (and its lease) open.
        if s.kind == JobKind::Library && s.state == JobState::Done {
            if let (Some(batch), Some(sync)) = (&s.library_batch, &self.library) {
                let (outcome, app) = sync.libraries.batch_outcome(batch);
                match outcome {
                    BatchOutcome::Pending => return None,
                    BatchOutcome::Applied { version } => {
                        // The Worker shows the summary and version itself.
                        return Some(Completion {
                            xml_version: s.xml_version.clone(),
                            library_version: version,
                            ..Completion::new("done", format!("Applied to your {app} library."))
                        });
                    }
                    BatchOutcome::Failed { error } => {
                        return Some(Completion {
                            xml_version: s.xml_version.clone(),
                            ..Completion::failed(
                                format!("Couldn't change your {app} library: {error}"),
                                vec![],
                            )
                        });
                    }
                    BatchOutcome::Unknown => {}
                }
            }
        }
        let state = if s.state == JobState::Done {
            "done"
        } else {
            "failed"
        };
        Some(Completion {
            tracks: s.tracks.clone(),
            errors: s.errors.clone(),
            xml_version: s.xml_version.clone(),
            ..Completion::new(state, s.message.clone())
        })
    }

    /// The Worker has the result (or will never take it): forget the job.
    pub fn reported(&mut self, cloud_id: &str) {
        self.rejected.remove(cloud_id);
        let Some(local) = self.active.remove(cloud_id) else {
            return;
        };
        // A playlist change just landed: the assistant may act on it next
        // ("now add…"), so re-share the library now, not in a minute.
        let was_library = self
            .jobs
            .get(&local)
            .is_some_and(|s| s.kind == JobKind::Library);
        if let (true, Some(sync)) = (was_library, self.library.as_mut()) {
            sync.urgent = true;
        }
    }

    /// Rebuild the library snapshot if the library changed (at most once a minute).
    pub async fn refresh_library(&mut self) {
        if let Some(sync) = self.library.as_mut() {
            sync.refresh().await;
        }
    }

    /// The default app's snapshot hash.
    pub fn library_hash(&self) -> Option<String> {
        self.library.as_ref()?.default_snapshot()?.hash.clone()
    }

    /// Every snapshot's hash, by app.
    pub fn library_hashes(&self) -> BTreeMap<&'static str, String> {
        let Some(sync) = self.library.as_ref() else {
            return BTreeMap::new();
        };
        sync.snapshots
            .iter()
            .filter_map(|s| Some((s.lib.key(), s.hash.clone()?)))
            .collect()
    }

    /// Where unnamed requests go, and which apps are on.
    pub fn apps(&self) -> Option<Value> {
        self.library.as_ref()?.libraries.report()
    }

    /// The default app's snapshot as the Worker stores it, or `None` before
    /// the first build.
    pub fn library_upload(&self) -> Option<(String, Value)> {
        self.library.as_ref()?.default_snapshot()?.upload()
    }

    /// One app's snapshot as the Worker stores it, labelled with the app.
    pub fn library_upload_for(&self, app: &str) -> Option<(String, Value)> {
        let sync = self.library.as_ref()?;
        let snapshot = sync.snapshots.iter().find(|s| s.lib.key() == app)?;
        let (hash, mut upload) = snapshot.upload()?;
        upload["app"] = json!(app);
        Some((hash, upload))
    }
}

/// Keeps a snapshot of each DJ app's library (playlists + a track index) for
/// the Worker, so ChatGPT can browse it while this Mac is offline. A snapshot
/// is rebuilt when its library changes (at most once a minute); uploaded only
/// when the Worker says its copy is stale. File paths never leave the Mac.
struct LibrarySync {
    libraries: Libraries,
    /// One for each app that's on.
    snapshots: Vec<Snapshot>,
    /// Skip the once-a-minute limit on the next rebuild.
    urgent: bool,
}

struct Snapshot {
    lib: Arc<DjLibrary>,
    db_mtime: Option<SystemTime>,
    last_built: Option<Instant>,
    hash: Option<String>,
    body: Option<Value>,
    /// Library track id → local file, for mirroring edits into the XML.
    paths: HashMap<String, PathBuf>,
}

const SNAPSHOT_MIN_INTERVAL: Duration = Duration::from_secs(60);

impl LibrarySync {
    fn new(libraries: Libraries) -> Self {
        Self {
            libraries,
            snapshots: Vec::new(),
            urgent: false,
        }
    }

    fn default_snapshot(&self) -> Option<&Snapshot> {
        let default = self.libraries.primary()?;
        self.snapshots
            .iter()
            .find(|s| Arc::ptr_eq(&s.lib, &default))
    }

    /// The local files a job's track ids mean, in the app it named.
    fn paths_for(&self, app: Option<&str>) -> Option<&HashMap<String, PathBuf>> {
        let snapshot = match app {
            Some(key) => self.snapshots.iter().find(|s| s.lib.key() == key),
            None => self.default_snapshot(),
        };
        snapshot.map(|s| &s.paths)
    }

    async fn refresh(&mut self) {
        let active = self.libraries.active();
        // An app the DJ turned off is left alone from here on.
        self.snapshots
            .retain(|s| active.iter().any(|l| Arc::ptr_eq(l, &s.lib)));
        for lib in active {
            if !self.snapshots.iter().any(|s| Arc::ptr_eq(&s.lib, &lib)) {
                self.snapshots.push(Snapshot::new(lib));
            }
        }
        let urgent = std::mem::take(&mut self.urgent);
        for snapshot in &mut self.snapshots {
            snapshot.refresh(urgent).await;
        }
    }
}

impl Snapshot {
    fn new(lib: Arc<DjLibrary>) -> Self {
        Self {
            lib,
            db_mtime: None,
            last_built: None,
            hash: None,
            body: None,
            paths: HashMap::new(),
        }
    }

    fn upload(&self) -> Option<(String, Value)> {
        let (hash, body) = (self.hash.as_ref()?, self.body.as_ref()?);
        let mut upload = body.clone();
        upload["hash"] = json!(hash);
        upload["generated_at"] = json!(chrono::Utc::now().to_rfc3339());
        upload["library_version"] = json!(self.lib.current_version());
        Some((hash.clone(), upload))
    }

    async fn refresh(&mut self, urgent: bool) {
        let mtime = self.lib.change_stamp();
        let stale = self.hash.is_none() || mtime != self.db_mtime;
        let due = urgent
            || self
                .last_built
                .is_none_or(|t| t.elapsed() >= SNAPSHOT_MIN_INTERVAL);
        if !(stale && due) {
            return;
        }
        self.last_built = Some(Instant::now());
        let source = self.lib.clone();
        match tokio::task::spawn_blocking(move || source.snapshot()).await {
            Ok(Ok(snapshot)) => {
                let (body, paths) = split_snapshot(snapshot);
                let hash = sha256_hex(&serde_json::to_vec(&body).unwrap_or_default());
                info!(
                    app = self.lib.app(),
                    tracks = body["tracks"].as_array().map_or(0, Vec::len),
                    playlists = body["playlists"].as_array().map_or(0, Vec::len),
                    "library snapshot built"
                );
                self.db_mtime = mtime;
                self.hash = Some(hash);
                self.body = Some(body);
                self.paths = paths;
            }
            Ok(Err(e)) => {
                warn!(app = self.lib.app(), error = %format!("{e:#}"), "couldn't snapshot the library")
            }
            Err(e) => warn!(error = %e, "library snapshot task panicked"),
        }
    }
}

/// Split the helper's snapshot into what's shared (no paths) and the local
/// id → path map.
fn split_snapshot(mut snapshot: Value) -> (Value, HashMap<String, PathBuf>) {
    let mut paths = HashMap::new();
    if let Some(tracks) = snapshot.get_mut("tracks").and_then(Value::as_array_mut) {
        for t in tracks.iter_mut() {
            if let Some(obj) = t.as_object_mut() {
                let path = obj.remove("path");
                if let (Some(id), Some(Value::String(path))) =
                    (obj.get("id").and_then(Value::as_str), path)
                {
                    paths.insert(id.to_string(), PathBuf::from(path));
                }
            }
        }
    }
    let body = json!({
        "playlists": snapshot.get("playlists").cloned().unwrap_or(json!([])),
        "tracks": snapshot.get("tracks").cloned().unwrap_or(json!([])),
    });
    (body, paths)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
