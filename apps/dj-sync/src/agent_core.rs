//! What both cloud lanes share, whatever the transport (v1 HTTP polling in
//! `cloud.rs`, v2 WebSocket in `cloud_v2.rs`): turning a claimed cloud job
//! into local work, deciding when its result can be reported, and keeping
//! the library snapshot the Worker serves to ChatGPT.
//!
//! A result stays pending until the transport says the Worker accepted it
//! (`reported`), so a dropped connection means "send it again", never "lost".

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::jobs::{JobError, JobKind, JobQueue, JobState, JobTrack, LibraryWork};
use crate::parser::extract_media_ref;
use crate::rekordbox_db::{BatchOutcome, RekordboxLibrary};

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
    pub fn new(jobs: JobQueue, library: Option<Arc<RekordboxLibrary>>) -> Self {
        Self {
            jobs,
            active: HashMap::new(),
            rejected: HashMap::new(),
            library: library.map(LibrarySync::new),
        }
    }

    /// Share the library snapshot and take playlist (library) jobs too.
    pub fn with_library(mut self, library: Option<Arc<RekordboxLibrary>>) -> Self {
        self.library = library.map(LibrarySync::new);
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
            .submit(media, Some(&job.playlist))
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
                "This Mac doesn't write to Rekordbox's library ([rekordbox_db] is off).",
                vec![],
            )));
        };
        let paths = job
            .ops
            .iter()
            .filter_map(|op| op.get("content_id").and_then(Value::as_str))
            .filter_map(|id| sync.paths.get(id).map(|p| (id.to_string(), p.clone())))
            .collect();
        let work = LibraryWork {
            summary: job
                .summary
                .clone()
                .unwrap_or_else(|| "Playlist change".into()),
            playlist: job.playlist.clone(),
            ops: job.ops.clone(),
            paths,
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
        // A playlist change is done when it reaches Rekordbox's library,
        // not when it's queued: keep the cloud job (and its lease) open.
        if s.kind == JobKind::Library && s.state == JobState::Done {
            if let (Some(batch), Some(sync)) = (&s.library_batch, &self.library) {
                match sync.lib.batch_outcome(batch) {
                    BatchOutcome::Pending => return None,
                    BatchOutcome::Applied { version } => {
                        // The Worker shows the summary and version itself.
                        return Some(Completion {
                            xml_version: s.xml_version.clone(),
                            library_version: version,
                            ..Completion::new("done", "Applied to your Rekordbox library.")
                        });
                    }
                    BatchOutcome::Failed { error } => {
                        return Some(Completion {
                            xml_version: s.xml_version.clone(),
                            ..Completion::failed(
                                format!("Couldn't change your Rekordbox library: {error}"),
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
        self.active.remove(cloud_id);
        self.rejected.remove(cloud_id);
    }

    /// Rebuild the library snapshot if master.db changed (at most once a minute).
    pub async fn refresh_library(&mut self) {
        if let Some(sync) = self.library.as_mut() {
            sync.refresh().await;
        }
    }

    pub fn library_hash(&self) -> Option<String> {
        self.library.as_ref().and_then(|s| s.hash.clone())
    }

    /// The snapshot as the Worker stores it, or `None` before the first build.
    pub fn library_upload(&self) -> Option<(String, Value)> {
        let sync = self.library.as_ref()?;
        let (hash, body) = (sync.hash.as_ref()?, sync.body.as_ref()?);
        let mut upload = body.clone();
        upload["hash"] = json!(hash);
        upload["generated_at"] = json!(chrono::Utc::now().to_rfc3339());
        upload["library_version"] = json!(sync.lib.current_version());
        Some((hash.clone(), upload))
    }
}

/// Keeps a snapshot of Rekordbox's library (playlists + a track index) for
/// the Worker, so ChatGPT can browse it while this Mac is offline. Rebuilt
/// when master.db changes (at most once a minute); uploaded only when the
/// Worker says its copy is stale. File paths never leave the Mac.
struct LibrarySync {
    lib: Arc<RekordboxLibrary>,
    db_mtime: Option<SystemTime>,
    last_built: Option<Instant>,
    hash: Option<String>,
    body: Option<Value>,
    /// Rekordbox content id → local file, for mirroring edits into the XML.
    paths: HashMap<String, PathBuf>,
}

const SNAPSHOT_MIN_INTERVAL: Duration = Duration::from_secs(60);

impl LibrarySync {
    fn new(lib: Arc<RekordboxLibrary>) -> Self {
        Self {
            lib,
            db_mtime: None,
            last_built: None,
            hash: None,
            body: None,
            paths: HashMap::new(),
        }
    }

    async fn refresh(&mut self) {
        let mtime = std::fs::metadata(self.lib.db_path())
            .and_then(|m| m.modified())
            .ok();
        let stale = self.hash.is_none() || mtime != self.db_mtime;
        let due = self
            .last_built
            .is_none_or(|t| t.elapsed() >= SNAPSHOT_MIN_INTERVAL);
        if !(stale && due) {
            return;
        }
        self.last_built = Some(Instant::now());
        let lib = self.lib.clone();
        match tokio::task::spawn_blocking(move || lib.snapshot()).await {
            Ok(Ok(snapshot)) => {
                let (body, paths) = split_snapshot(snapshot);
                let hash = sha256_hex(&serde_json::to_vec(&body).unwrap_or_default());
                info!(
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
                warn!(error = %format!("{e:#}"), "couldn't snapshot the Rekordbox library")
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
