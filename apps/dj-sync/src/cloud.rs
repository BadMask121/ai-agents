//! Cloud lane: the always-on Cloudflare Worker (`apps/dj-sync-cloud`) holds
//! jobs from ChatGPT while this Mac is offline; this lane polls it outbound,
//! claims one job at a time, runs it through the local `JobQueue`, and
//! reports the result back. No inbound connection is needed.
//!
//! The Worker and this agent speak a versioned protocol (`AGENT_PROTOCOL`,
//! semver). The Worker refuses an agent whose MAJOR differs or whose MINOR is
//! newer than its own, and we stop claiming work until one side is updated.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, Context};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::config::CloudCfg;
use crate::jobs::{JobError, JobKind, JobQueue, JobState, JobStatus, JobTrack, LibraryWork};
use crate::parser::extract_media_ref;
use crate::rekordbox_db::{BatchOutcome, RekordboxLibrary};

/// Bump MAJOR for breaking changes to the agent API, MINOR for additions the
/// agent relies on, PATCH for fixes. Must stay in step with the Worker's.
pub const AGENT_PROTOCOL: &str = "1.1.0";

const PROTOCOL_HEADER: &str = "x-dj-sync-agent-protocol";
const VERSION_HEADER: &str = "x-dj-sync-agent-version";
const MAX_BACKOFF: Duration = Duration::from_secs(300);
const INCOMPATIBLE_RETRY: Duration = Duration::from_secs(600);

#[derive(Debug, Deserialize)]
struct PollResponse {
    #[serde(default)]
    worker_version: Option<String>,
    job: Option<ClaimedJob>,
    /// The Worker's copy of the library snapshot is stale (protocol ≥ 1.1).
    #[serde(default)]
    library_wanted: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct ClaimedJob {
    job_id: String,
    #[serde(default)]
    playlist: String,
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    attempt: u32,
    /// "download" (default) or "library" (protocol ≥ 1.1).
    #[serde(default)]
    kind: Option<String>,
    /// rbdb.py ops for library jobs.
    #[serde(default)]
    ops: Vec<Value>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Debug, Serialize)]
struct Completion<'a> {
    state: &'static str,
    message: &'a str,
    tracks: &'a [JobTrack],
    errors: &'a [JobError],
    xml_version: Option<&'a str>,
    library_version: Option<&'a str>,
}

impl<'a> Completion<'a> {
    fn new(state: &'static str, message: &'a str) -> Self {
        Self {
            state,
            message,
            tracks: &[],
            errors: &[],
            xml_version: None,
            library_version: None,
        }
    }

    fn failed(message: &'a str, errors: &'a [JobError]) -> Self {
        Self {
            errors,
            ..Self::new("failed", message)
        }
    }
}

#[derive(Debug)]
pub enum TickError {
    /// Worker says our protocol is incompatible: retry rarely, loudly.
    Incompatible(String),
    /// Offline, DNS, 5xx, …: back off and retry.
    Transient(anyhow::Error),
}

impl From<anyhow::Error> for TickError {
    fn from(e: anyhow::Error) -> Self {
        TickError::Transient(e)
    }
}

impl From<reqwest::Error> for TickError {
    fn from(e: reqwest::Error) -> Self {
        TickError::Transient(e.into())
    }
}

pub struct CloudAgent {
    http: reqwest::Client,
    base: String,
    token: String,
    jobs: JobQueue,
    /// cloud job id → local job id, for jobs claimed but not yet reported.
    active: HashMap<String, String>,
    library: Option<LibrarySync>,
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

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

impl CloudAgent {
    pub fn new(base_url: &str, token: String, jobs: JobQueue) -> anyhow::Result<Self> {
        let base = base_url.trim_end_matches('/').to_string();
        anyhow::ensure!(
            base.starts_with("https://") || base.starts_with("http://127.0.0.1"),
            "cloud.base_url must be https (got {base})"
        );
        Ok(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("dj-sync/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(30))
                .build()
                .context("building http client")?,
            base,
            token,
            jobs,
            active: HashMap::new(),
            library: None,
        })
    }

    /// Share the library snapshot and take playlist (library) jobs too.
    pub fn with_library(mut self, lib: Option<Arc<RekordboxLibrary>>) -> Self {
        self.library = lib.map(|lib| LibrarySync {
            lib,
            db_mtime: None,
            last_built: None,
            hash: None,
            body: None,
            paths: HashMap::new(),
        });
        self
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .header(PROTOCOL_HEADER, AGENT_PROTOCOL)
            .header(VERSION_HEADER, env!("CARGO_PKG_VERSION"))
    }

    /// One round: report finished jobs, extend leases on running ones, and
    /// claim a new job if we're idle. Returns the cloud id claimed, if any.
    pub async fn tick(&mut self) -> Result<Option<String>, TickError> {
        self.report_finished().await?;
        if let Some(sync) = self.library.as_mut() {
            sync.refresh().await;
        }

        let active: Vec<&String> = self.active.keys().collect();
        let library_hash = self.library.as_ref().and_then(|s| s.hash.clone());
        let res = self
            .post("/agent/poll")
            .json(&json!({
                "active": active,
                "can_claim": self.active.is_empty(),
                "library_hash": library_hash,
            }))
            .send()
            .await?;
        let res = check_status(res).await?;
        let poll: PollResponse = res.json().await.context("parsing poll response")?;
        if poll.library_wanted {
            self.upload_library().await?;
        }

        let Some(job) = poll.job else {
            return Ok(None);
        };
        info!(
            cloud_job = %job.job_id,
            attempt = job.attempt,
            links = job.urls.len(),
            playlist = %job.playlist,
            worker = poll.worker_version.as_deref().unwrap_or("?"),
            "claimed cloud job"
        );
        self.start(job).await?;
        Ok(self.active.keys().next().cloned())
    }

    async fn upload_library(&self) -> Result<(), TickError> {
        let Some(sync) = self.library.as_ref() else {
            return Ok(());
        };
        let (Some(hash), Some(body)) = (&sync.hash, &sync.body) else {
            return Ok(());
        };
        let mut upload = body.clone();
        upload["hash"] = json!(hash);
        upload["generated_at"] = json!(chrono::Utc::now().to_rfc3339());
        upload["library_version"] = json!(sync.lib.current_version());
        let res = self
            .post("/agent/library")
            .timeout(Duration::from_secs(120))
            .json(&upload)
            .send()
            .await?;
        check_status(res).await?;
        info!(%hash, "shared library snapshot");
        Ok(())
    }

    async fn start(&mut self, job: ClaimedJob) -> Result<(), TickError> {
        if job.kind.as_deref() == Some("library") {
            return self.start_library(job).await;
        }
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
            let msg = "None of the links can be downloaded on this Mac.";
            return self
                .complete(&job.job_id, Completion::failed(msg, &rejected))
                .await;
        }
        match self.jobs.submit(media, Some(&job.playlist)) {
            Ok(sub) => {
                self.active.insert(job.job_id, sub.job.job_id);
                Ok(())
            }
            Err(e) => {
                let msg = format!("Could not queue on the Mac: {e:#}");
                self.complete(&job.job_id, Completion::failed(&msg, &rejected))
                    .await
            }
        }
    }

    async fn start_library(&mut self, job: ClaimedJob) -> Result<(), TickError> {
        let summary = job
            .summary
            .clone()
            .unwrap_or_else(|| "Playlist change".into());
        let Some(sync) = self.library.as_ref() else {
            let msg = "This Mac doesn't write to Rekordbox's library ([rekordbox_db] is off).";
            return self
                .complete(&job.job_id, Completion::failed(msg, &[]))
                .await;
        };
        let paths = job
            .ops
            .iter()
            .filter_map(|op| op.get("content_id").and_then(Value::as_str))
            .filter_map(|id| sync.paths.get(id).map(|p| (id.to_string(), p.clone())))
            .collect();
        let work = LibraryWork {
            summary,
            playlist: job.playlist.clone(),
            ops: job.ops,
            paths,
        };
        match self.jobs.submit_library(work) {
            Ok(sub) => {
                self.active.insert(job.job_id, sub.job.job_id);
                Ok(())
            }
            Err(e) => {
                let msg = format!("Could not queue on the Mac: {e:#}");
                self.complete(&job.job_id, Completion::failed(&msg, &[]))
                    .await
            }
        }
    }

    async fn report_finished(&mut self) -> Result<(), TickError> {
        let finished: Vec<(String, Option<JobStatus>)> = self
            .active
            .iter()
            .filter_map(|(cloud, local)| match self.jobs.get(local) {
                Some(s) if s.state.is_active() => None,
                other => Some((cloud.clone(), other)),
            })
            .collect();
        for (cloud_id, status) in finished {
            // A playlist change is done when it reaches Rekordbox's library,
            // not when it's queued: keep the cloud job (and its lease) open.
            if let Some(s) = &status {
                if s.kind == JobKind::Library && s.state == JobState::Done {
                    if let (Some(batch), Some(sync)) = (&s.library_batch, &self.library) {
                        match sync.lib.batch_outcome(batch) {
                            BatchOutcome::Pending => continue,
                            BatchOutcome::Applied { version } => {
                                let msg = format!(
                                    "{} — applied to your Rekordbox library{}.",
                                    s.message
                                        .split(". ")
                                        .next()
                                        .unwrap_or(&s.message)
                                        .trim_end_matches('.'),
                                    version
                                        .as_ref()
                                        .map(|v| format!(" (v{v})"))
                                        .unwrap_or_default()
                                );
                                let done = Completion {
                                    xml_version: s.xml_version.as_deref(),
                                    library_version: version.as_deref(),
                                    ..Completion::new("done", &msg)
                                };
                                self.complete(&cloud_id, done).await?;
                                self.active.remove(&cloud_id);
                                continue;
                            }
                            BatchOutcome::Failed { error } => {
                                let msg =
                                    format!("Couldn't change your Rekordbox library: {error}");
                                let failed = Completion {
                                    xml_version: s.xml_version.as_deref(),
                                    ..Completion::failed(&msg, &[])
                                };
                                self.complete(&cloud_id, failed).await?;
                                self.active.remove(&cloud_id);
                                continue;
                            }
                            BatchOutcome::Unknown => {}
                        }
                    }
                }
            }
            match status {
                Some(s) => {
                    let state = if s.state == JobState::Done {
                        "done"
                    } else {
                        "failed"
                    };
                    let result = Completion {
                        tracks: &s.tracks,
                        errors: &s.errors,
                        xml_version: s.xml_version.as_deref(),
                        ..Completion::new(state, &s.message)
                    };
                    self.complete(&cloud_id, result).await?;
                }
                None => {
                    let lost = Completion::failed("The Mac lost track of this job.", &[]);
                    self.complete(&cloud_id, lost).await?;
                }
            }
            self.active.remove(&cloud_id);
        }
        Ok(())
    }

    async fn complete(&self, cloud_id: &str, result: Completion<'_>) -> Result<(), TickError> {
        let res = self
            .post(&format!("/agent/jobs/{cloud_id}/complete"))
            .json(&result)
            .send()
            .await?;
        let status = res.status();
        if status.is_success() {
            info!(
                cloud_job = cloud_id,
                state = result.state,
                "reported cloud job result"
            );
            return Ok(());
        }
        let body = res.text().await.unwrap_or_default();
        match classify(status, body) {
            // Unknown (pruned) or already finished differently: nothing to retry.
            TickError::Transient(_)
                if status == StatusCode::NOT_FOUND || status == StatusCode::CONFLICT =>
            {
                warn!(cloud_job = cloud_id, %status, "worker did not accept the result; dropping it");
                Ok(())
            }
            e => Err(e),
        }
    }
}

async fn check_status(res: reqwest::Response) -> Result<reqwest::Response, TickError> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    Err(classify(status, res.text().await.unwrap_or_default()))
}

fn classify(status: StatusCode, body: String) -> TickError {
    if status == StatusCode::CONFLICT && body.contains("incompatible_protocol") {
        return TickError::Incompatible(body);
    }
    if status == StatusCode::UNAUTHORIZED {
        return TickError::Transient(anyhow!("worker rejected CLOUD_AGENT_TOKEN (401)"));
    }
    let snippet: String = body.chars().take(300).collect();
    TickError::Transient(anyhow!("worker returned {status}: {snippet}"))
}

/// Run the lane until shutdown: poll every `poll_secs`, back off while the
/// network or Worker is down, and go quiet on a protocol mismatch.
pub async fn run(
    cfg: CloudCfg,
    token: String,
    jobs: JobQueue,
    library: Option<Arc<RekordboxLibrary>>,
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let mut agent = CloudAgent::new(&cfg.base_url, token, jobs)?.with_library(library);
    let poll = Duration::from_secs(cfg.poll_secs.max(2));
    let mut delay = Duration::ZERO;
    let mut offline_since: Option<std::time::Instant> = None;
    info!(base = %agent.base, protocol = AGENT_PROTOCOL, "cloud lane polling");

    loop {
        tokio::select! {
            _ = shutdown.wait_for(|s| *s) => return Ok(()),
            _ = tokio::time::sleep(delay) => {}
        }
        delay = match agent.tick().await {
            Ok(claimed) => {
                if let Some(since) = offline_since.take() {
                    info!(after = ?since.elapsed(), "cloud worker reachable again");
                }
                // Just claimed something: check back soon to report it.
                if claimed.is_some() {
                    Duration::from_secs(2).min(poll)
                } else {
                    poll
                }
            }
            Err(TickError::Incompatible(body)) => {
                error!(
                    agent_protocol = AGENT_PROTOCOL,
                    agent_version = env!("CARGO_PKG_VERSION"),
                    worker = %body,
                    "cloud worker speaks an incompatible protocol; not claiming jobs until one side is updated"
                );
                INCOMPATIBLE_RETRY
            }
            Err(TickError::Transient(e)) => {
                if offline_since.is_none() {
                    warn!(error = %format!("{e:#}"), "cloud worker unreachable; will keep retrying");
                    offline_since = Some(std::time::Instant::now());
                }
                (delay * 2).clamp(poll, MAX_BACKOFF)
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DownloadCfg;
    use crate::downloader::Fetcher;
    use crate::MediaRef;
    use axum::extract::{Path as AxPath, State};
    use axum::http::HeaderMap;
    use axum::routing::post;
    use axum::{Json, Router};
    use serde_json::Value;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    /// What the fake Worker saw and has queued.
    #[derive(Default)]
    struct Fake {
        queued: Vec<Value>,
        completed: Vec<(String, Value)>,
        polls: Vec<Value>,
        bad_headers: usize,
        protocol: String,
        /// Hash of the snapshot the "Worker" holds, and uploads received.
        library_hash: Option<String>,
        uploads: Vec<Value>,
    }

    type Shared = Arc<Mutex<Fake>>;

    async fn poll(
        State(s): State<Shared>,
        h: HeaderMap,
        Json(body): Json<Value>,
    ) -> (axum::http::StatusCode, Json<Value>) {
        let mut f = s.lock().unwrap();
        if h.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer agent-token")
            || h.get(PROTOCOL_HEADER).is_none()
            || h.get(VERSION_HEADER).is_none()
        {
            f.bad_headers += 1;
            return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({})));
        }
        if !f.protocol.starts_with("1.") {
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"error":"incompatible_protocol","worker_protocol":f.protocol})),
            );
        }
        f.polls.push(body.clone());
        let job = if body["can_claim"] == true && !f.queued.is_empty() {
            Some(f.queued.remove(0))
        } else {
            None
        };
        let wanted = body["library_hash"]
            .as_str()
            .is_some_and(|h| f.library_hash.as_deref() != Some(h));
        (
            axum::http::StatusCode::OK,
            Json(
                json!({"worker_version":"0.2.0","protocol":f.protocol,"job":job,"library_wanted":wanted}),
            ),
        )
    }

    async fn complete(
        State(s): State<Shared>,
        AxPath(id): AxPath<String>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        s.lock().unwrap().completed.push((id, body));
        Json(json!({"ok":true}))
    }

    async fn library_upload(State(s): State<Shared>, Json(body): Json<Value>) -> Json<Value> {
        let mut f = s.lock().unwrap();
        f.library_hash = body["hash"].as_str().map(String::from);
        f.uploads.push(body);
        Json(json!({"ok": true}))
    }

    async fn fake_worker(fake: Shared) -> String {
        let app = Router::new()
            .route("/agent/poll", post(poll))
            .route("/agent/library", post(library_upload))
            .route("/agent/jobs/{id}/complete", post(complete))
            .with_state(fake);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    /// Copies the fixture once the test opens the gate, so the test can see
    /// the job while it is still running.
    struct CopyFixture {
        gate: Arc<tokio::sync::Semaphore>,
    }
    impl Fetcher for CopyFixture {
        async fn fetch(&self, media: &MediaRef, staging: &Path) -> anyhow::Result<()> {
            self.gate.acquire().await?.forget();
            let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3");
            let name = media.url().as_str().rsplit(['/', '=']).next().unwrap();
            std::fs::copy(fixture, staging.join(format!("DJ Test - {name}.mp3")))?;
            Ok(())
        }
    }

    fn gated_queue(dir: &Path, gate: Arc<tokio::sync::Semaphore>) -> JobQueue {
        let cfg = DownloadCfg {
            dir: dir.join("dl"),
            import_xml: dir.join("import.xml"),
            ..DownloadCfg::default()
        };
        JobQueue::start(cfg, CopyFixture { gate }).unwrap().0
    }

    fn queue(dir: &Path) -> JobQueue {
        gated_queue(dir, Arc::new(tokio::sync::Semaphore::new(100)))
    }

    #[tokio::test]
    async fn claims_runs_and_reports_a_cloud_job() {
        let tmp = tempfile::tempdir().unwrap();
        let fake: Shared = Arc::new(Mutex::new(Fake {
            protocol: "1.0.0".into(),
            ..Fake::default()
        }));
        fake.lock().unwrap().queued.push(json!({
            "job_id": "c0ffee000001",
            "playlist": "Offline Friday",
            "urls": ["https://open.spotify.com/track/abc123"],
            "attempt": 1
        }));
        let base = fake_worker(fake.clone()).await;
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let mut agent = CloudAgent::new(
            &base,
            "agent-token".into(),
            gated_queue(tmp.path(), gate.clone()),
        )
        .unwrap();

        // Claim; while the download is held, the next poll extends its lease
        // and doesn't claim more.
        assert_eq!(agent.tick().await.unwrap().as_deref(), Some("c0ffee000001"));
        assert_eq!(agent.tick().await.unwrap(), None);
        {
            let f = fake.lock().unwrap();
            let last = f.polls.last().unwrap();
            assert_eq!(last["active"], json!(["c0ffee000001"]));
            assert_eq!(last["can_claim"], false);
            assert!(f.completed.is_empty());
        }
        // Let the local worker finish; a later tick reports it.
        gate.add_permits(1);
        for _ in 0..200 {
            if fake.lock().unwrap().completed.len() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            agent.tick().await.unwrap();
        }
        let f = fake.lock().unwrap();
        assert_eq!(f.bad_headers, 0);
        let (id, body) = &f.completed[0];
        assert_eq!(id, "c0ffee000001");
        assert_eq!(body["state"], "done");
        assert_eq!(body["tracks"][0]["title"], "Fixture Tune");
        assert_eq!(body["xml_version"], "1.1.0");
        assert!(agent.active.is_empty());
    }

    /// rbdb.py stand-in: a fixed snapshot, and `apply` that changes the db.
    fn fake_library(dir: &Path, track: &Path) -> Arc<RekordboxLibrary> {
        let db = dir.join("master.db");
        std::fs::write(&db, "library\n").unwrap();
        let script = dir.join("rbdb.sh");
        let snapshot = json!({"ok": true,
            "playlists": [{"id": "1", "name": "Old", "folder": "", "track_ids": ["101"]}],
            "tracks": [{"id": "101", "title": "T", "artist": "A", "path": track}]});
        let apply = r#"{"ok": true, "results": [{"playlist_id": "7", "created": true}]}"#;
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ \"$3\" = snapshot ]; then echo '{snapshot}'; \
                 else cat >/dev/null; printf 'x\\n' >> \"$2\"; echo '{apply}'; fi\n"
            ),
        )
        .unwrap();
        let cfg = crate::config::RekordboxDbCfg {
            enabled: true,
            db_path: db,
            ..Default::default()
        };
        Arc::new(RekordboxLibrary::with_parts(
            cfg,
            dir.join("state"),
            crate::rekordbox_db::Helper {
                program: "/bin/sh".into(),
                prefix_args: vec![script.into()],
            },
            Arc::new(|| false),
        ))
    }

    #[tokio::test]
    async fn shares_the_library_and_applies_playlist_jobs() {
        let tmp = tempfile::tempdir().unwrap();
        let track = tmp.path().join("music/T.mp3");
        std::fs::create_dir_all(track.parent().unwrap()).unwrap();
        std::fs::copy(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3"),
            &track,
        )
        .unwrap();
        let lib = fake_library(tmp.path(), &track);
        let fake: Shared = Arc::new(Mutex::new(Fake {
            protocol: "1.1.0".into(),
            ..Fake::default()
        }));
        fake.lock().unwrap().queued.push(json!({
            "job_id": "11b000000001", "kind": "library", "playlist": "Sat",
            "summary": "Create “Sat” with 1 track", "urls": [], "attempt": 1,
            "ops": [{"op": "ensure_playlist", "name": "Sat"},
                    {"op": "add_to_playlist", "playlist": "Sat", "content_id": "101"}]
        }));
        let base = fake_worker(fake.clone()).await;
        let cfg = DownloadCfg {
            dir: tmp.path().join("dl"),
            import_xml: tmp.path().join("import.xml"),
            ..DownloadCfg::default()
        };
        let fetcher = CopyFixture {
            gate: Arc::new(tokio::sync::Semaphore::new(9)),
        };
        let (jobs, _) = JobQueue::start_with(cfg.clone(), fetcher, Some(lib.clone())).unwrap();
        let mut agent = CloudAgent::new(&base, "agent-token".into(), jobs)
            .unwrap()
            .with_library(Some(lib.clone()));

        // First tick: snapshot built, shared (without paths), job claimed.
        assert_eq!(agent.tick().await.unwrap().as_deref(), Some("11b000000001"));
        {
            let f = fake.lock().unwrap();
            assert_eq!(f.uploads.len(), 1);
            let up = &f.uploads[0];
            assert_eq!(up["tracks"][0]["id"], "101");
            assert!(
                up["tracks"][0].get("path").is_none(),
                "paths stay on the Mac"
            );
            assert_eq!(up["playlists"][0]["name"], "Old");
        }
        // Wait for the local job (XML mirror + queued library batch).
        for _ in 0..200 {
            agent.tick().await.unwrap();
            if lib.status().pending.len() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            fake.lock().unwrap().completed.is_empty(),
            "not done until it's in the library"
        );
        let xml = crate::rekordbox_xml::RekordboxLib::load(&cfg.import_xml).unwrap();
        assert_eq!(
            xml.lookup("Sat").unwrap().track_ids.len(),
            1,
            "mirrored into the XML"
        );

        // Rekordbox is closed: the batch is applied, then reported.
        lib.apply_pending().unwrap().expect("applied");
        agent.tick().await.unwrap();
        let f = fake.lock().unwrap();
        assert_eq!(f.uploads.len(), 1, "unchanged snapshot isn't re-sent");
        let (id, body) = &f.completed[0];
        assert_eq!(id, "11b000000001");
        assert_eq!(body["state"], "done");
        assert_eq!(body["library_version"], "1.1.0");
        assert!(body["message"]
            .as_str()
            .unwrap()
            .contains("applied to your Rekordbox library"));
    }

    #[tokio::test]
    async fn incompatible_protocol_is_reported_as_such() {
        let tmp = tempfile::tempdir().unwrap();
        let fake: Shared = Arc::new(Mutex::new(Fake {
            protocol: "2.0.0".into(),
            ..Fake::default()
        }));
        let base = fake_worker(fake).await;
        let mut agent = CloudAgent::new(&base, "agent-token".into(), queue(tmp.path())).unwrap();
        assert!(matches!(
            agent.tick().await,
            Err(TickError::Incompatible(_))
        ));
    }

    #[tokio::test]
    async fn wrong_token_and_unreachable_worker_are_transient() {
        let tmp = tempfile::tempdir().unwrap();
        let fake: Shared = Arc::new(Mutex::new(Fake {
            protocol: "1.0.0".into(),
            ..Fake::default()
        }));
        let base = fake_worker(fake).await;
        let mut agent = CloudAgent::new(&base, "nope".into(), queue(tmp.path())).unwrap();
        assert!(matches!(agent.tick().await, Err(TickError::Transient(_))));

        // Nothing listening on this port.
        let mut agent =
            CloudAgent::new("http://127.0.0.1:9", "x".into(), queue(tmp.path())).unwrap();
        assert!(matches!(agent.tick().await, Err(TickError::Transient(_))));
    }

    #[test]
    fn base_url_must_be_https() {
        let tmp = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _g = rt.enter();
        assert!(CloudAgent::new("http://mcp.example.com", "t".into(), queue(tmp.path())).is_err());
    }
}
