//! Download jobs: a bounded queue drained by ONE worker, so spotdl / yt-dlp
//! never run concurrently and only one task ever writes the import XML.
//!
//! Jobs live in memory (last `KEEP_JOBS`); a restart forgets history but
//! never loses files — anything already moved into the download dir and
//! written to the XML stays there.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Context;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::config::DownloadCfg;
use crate::downloader::Fetcher;
use crate::import_xml::ImportDoc;
use crate::library::{is_audio_file, read_meta};
use crate::rekordbox_db::RekordboxLibrary;
use crate::xml_versions::Version;
use crate::xml_versions::{Bump, Versions};
use crate::{unique_name, MediaRef};

const KEEP_JOBS: usize = 50;
const QUEUE_CAPACITY: usize = 64;
const MAX_PLAYLIST_NAME: usize = 100;

pub type JobId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
}

impl JobState {
    pub fn is_active(self) -> bool {
        matches!(self, JobState::Queued | JobState::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JobTrack {
    pub artist: String,
    pub title: String,
    pub file: String,
    /// True when an identical file was already in the download dir.
    pub already_downloaded: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JobError {
    pub url: String,
    pub error: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    /// Download links into a playlist.
    Download,
    /// Change Rekordbox playlists (from ChatGPT).
    Library,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobStatus {
    pub job_id: JobId,
    pub kind: JobKind,
    pub state: JobState,
    pub playlist: String,
    pub urls: Vec<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub tracks: Vec<JobTrack>,
    pub errors: Vec<JobError>,
    pub message: String,
    /// Semver of the import XML after this job (see `xml_versions`).
    pub xml_version: Option<String>,
    /// The Rekordbox library batch this job queued, if any.
    pub library_batch: Option<String>,
}

struct Entry {
    status: JobStatus,
    work: Work,
}

#[derive(Clone)]
enum Work {
    /// `playlist_id`: the existing Rekordbox playlist the cloud resolved the
    /// name to (pins the exact one when names repeat).
    Download {
        media: Vec<MediaRef>,
        playlist_id: Option<String>,
    },
    Library(LibraryWork),
}

/// A playlist change for Rekordbox's library, in rbdb.py op form, plus the
/// local paths of the tracks it mentions (to mirror it into the import XML).
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryWork {
    pub summary: String,
    pub playlist: String,
    pub ops: Vec<serde_json::Value>,
    pub paths: HashMap<String, PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Submitted {
    #[serde(flatten)]
    pub job: JobStatus,
    /// Jobs ahead of this one (0 = next / running).
    pub position: usize,
    /// True if an identical job was already queued or running and was reused.
    pub deduplicated: bool,
}

#[derive(Clone)]
pub struct JobQueue {
    tx: mpsc::Sender<JobId>,
    store: Arc<Mutex<VecDeque<Entry>>>,
    default_playlist: String,
}

impl JobQueue {
    /// Create the import XML if it's missing (so Rekordbox's file picker can
    /// see it) and spawn the single worker.
    pub fn start<F: Fetcher>(
        cfg: DownloadCfg,
        fetcher: F,
    ) -> anyhow::Result<(Self, JoinHandle<()>)> {
        Self::start_with(cfg, fetcher, None)
    }

    /// Like `start`, also queueing each download into Rekordbox's own
    /// library (master.db) when `library` is given.
    pub fn start_with<F: Fetcher>(
        cfg: DownloadCfg,
        fetcher: F,
        library: Option<Arc<RekordboxLibrary>>,
    ) -> anyhow::Result<(Self, JoinHandle<()>)> {
        cfg.prepare()?;
        // Jobs don't survive a restart, so anything still staged is debris.
        let _ = std::fs::remove_dir_all(cfg.current_dir().0.join(".staging"));
        if !cfg.import_xml.exists() {
            if let Some(parent) = cfg.import_xml.parent() {
                std::fs::create_dir_all(parent)?;
            }
            ImportDoc::new()
                .save_atomic(&cfg.import_xml)
                .context("creating empty import xml")?;
            info!(path = %cfg.import_xml.display(), "created rekordbox import xml");
        }
        // Snapshot whatever is there now (an adopted original, or an outside
        // edit since the last run) before any job writes to it.
        let version = Versions::for_xml(&cfg.import_xml, cfg.keep_versions)
            .reconcile(&cfg.import_xml)
            .context("snapshotting import xml")?;
        if let Some(v) = version {
            info!(path = %cfg.import_xml.display(), version = %v, "import xml version");
        }

        let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
        let store = Arc::new(Mutex::new(VecDeque::new()));
        let queue = Self {
            tx,
            store: store.clone(),
            default_playlist: cfg.default_playlist.clone(),
        };
        let worker = tokio::spawn(worker(rx, store, cfg, fetcher, library));
        Ok((queue, worker))
    }

    pub fn submit(
        &self,
        media: Vec<MediaRef>,
        playlist: Option<&str>,
    ) -> anyhow::Result<Submitted> {
        self.submit_to(media, playlist, None)
    }

    /// `submit` into a specific existing Rekordbox playlist (by its id).
    pub fn submit_to(
        &self,
        media: Vec<MediaRef>,
        playlist: Option<&str>,
        playlist_id: Option<String>,
    ) -> anyhow::Result<Submitted> {
        anyhow::ensure!(!media.is_empty(), "no links to download");
        let playlist = normalize_playlist_name(playlist, &self.default_playlist)?;
        let urls: Vec<String> = media.iter().map(|m| m.url().to_string()).collect();

        let mut store = self.store.lock().expect("job store");
        // ChatGPT may retry a tool call; don't queue the same work twice.
        if let Some(e) = store.iter().find(|e| {
            e.status.state.is_active() && e.status.urls == urls && e.status.playlist == playlist
        }) {
            let job = e.status.clone();
            let position = position_of(&store, &job.job_id);
            return Ok(Submitted {
                job,
                position,
                deduplicated: true,
            });
        }

        self.push(
            &mut store,
            JobKind::Download,
            playlist,
            urls,
            Work::Download { media, playlist_id },
        )
    }

    /// Queue a playlist change for Rekordbox (mirrored into the import XML).
    pub fn submit_library(&self, work: LibraryWork) -> anyhow::Result<Submitted> {
        anyhow::ensure!(!work.ops.is_empty(), "nothing to change");
        let mut store = self.store.lock().expect("job store");
        if let Some(e) = store.iter().find(|e| {
            e.status.state.is_active() && matches!(&e.work, Work::Library(w) if *w == work)
        }) {
            let job = e.status.clone();
            let position = position_of(&store, &job.job_id);
            return Ok(Submitted {
                job,
                position,
                deduplicated: true,
            });
        }
        let playlist = work.playlist.clone();
        self.push(
            &mut store,
            JobKind::Library,
            playlist,
            Vec::new(),
            Work::Library(work),
        )
    }

    fn push(
        &self,
        store: &mut VecDeque<Entry>,
        kind: JobKind,
        playlist: String,
        urls: Vec<String>,
        work: Work,
    ) -> anyhow::Result<Submitted> {
        let job_id = new_job_id();
        let status = JobStatus {
            job_id: job_id.clone(),
            kind,
            state: JobState::Queued,
            playlist,
            urls,
            created_at: now_rfc3339(),
            started_at: None,
            finished_at: None,
            tracks: Vec::new(),
            errors: Vec::new(),
            message: "Queued.".into(),
            xml_version: None,
            library_batch: None,
        };
        self.tx
            .try_send(job_id.clone())
            .map_err(|_| anyhow::anyhow!("job queue is full; try again later"))?;
        store.push_back(Entry {
            status: status.clone(),
            work,
        });
        trim(store);
        let position = position_of(store, &job_id);
        Ok(Submitted {
            job: status,
            position,
            deduplicated: false,
        })
    }

    pub fn get(&self, job_id: &str) -> Option<JobStatus> {
        let store = self.store.lock().expect("job store");
        store
            .iter()
            .find(|e| e.status.job_id == job_id)
            .map(|e| e.status.clone())
    }

    /// Newest first.
    pub fn recent(&self, n: usize) -> Vec<JobStatus> {
        let store = self.store.lock().expect("job store");
        store
            .iter()
            .rev()
            .take(n)
            .map(|e| e.status.clone())
            .collect()
    }
}

/// Active jobs created before `job_id`.
fn position_of(store: &VecDeque<Entry>, job_id: &str) -> usize {
    store
        .iter()
        .take_while(|e| e.status.job_id != job_id)
        .filter(|e| e.status.state.is_active())
        .count()
}

/// Drop the oldest finished jobs beyond `KEEP_JOBS`; active jobs are never dropped.
fn trim(store: &mut VecDeque<Entry>) {
    while store.len() > KEEP_JOBS {
        match store.iter().position(|e| !e.status.state.is_active()) {
            Some(i) => {
                store.remove(i);
            }
            None => break,
        }
    }
}

pub fn normalize_playlist_name(name: Option<&str>, default: &str) -> anyhow::Result<String> {
    let cleaned: String = name
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let name = if cleaned.is_empty() {
        default.to_string()
    } else {
        cleaned
    };
    anyhow::ensure!(
        name.chars().count() <= MAX_PLAYLIST_NAME,
        "playlist_name must be at most {MAX_PLAYLIST_NAME} characters"
    );
    Ok(name)
}

fn new_job_id() -> JobId {
    // Short enough for a human (or ChatGPT) to repeat back.
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

fn update(store: &Mutex<VecDeque<Entry>>, job_id: &str, f: impl FnOnce(&mut JobStatus)) {
    let mut store = store.lock().expect("job store");
    if let Some(e) = store.iter_mut().find(|e| e.status.job_id == job_id) {
        f(&mut e.status);
    }
}

async fn worker<F: Fetcher>(
    mut rx: mpsc::Receiver<JobId>,
    store: Arc<Mutex<VecDeque<Entry>>>,
    cfg: DownloadCfg,
    fetcher: F,
    library: Option<Arc<RekordboxLibrary>>,
) {
    while let Some(job_id) = rx.recv().await {
        let Some((work, playlist)) = ({
            let store = store.lock().expect("job store");
            store
                .iter()
                .find(|e| e.status.job_id == job_id)
                .map(|e| (e.work.clone(), e.status.playlist.clone()))
        }) else {
            continue;
        };
        let (media, playlist_id) = match work {
            Work::Download { media, playlist_id } => (media, playlist_id),
            Work::Library(work) => {
                run_library_job(&store, &job_id, &cfg, work, library.clone()).await;
                continue;
            }
        };

        update(&store, &job_id, |s| {
            s.state = JobState::Running;
            s.started_at = Some(now_rfc3339());
            s.message = format!("Downloading {} link(s)…", media.len());
        });
        info!(%job_id, links = media.len(), %playlist, "download job started");

        // The folder can change between jobs (menu bar app); pick it up now.
        let (dir, source) = cfg.current_dir();
        let job_cfg = DownloadCfg {
            dir: dir.clone(),
            ..cfg.clone()
        };
        let outcome = match crate::settings::ensure_writable(&dir) {
            Ok(()) => {
                info!(%job_id, dir = %dir.display(), source = source.as_str(), "download folder");
                run_job(
                    &job_cfg,
                    &fetcher,
                    &job_id,
                    &media,
                    &playlist,
                    playlist_id.clone(),
                    library.clone(),
                )
                .await
            }
            Err(e) => Err(e),
        };

        update(&store, &job_id, |s| {
            s.finished_at = Some(now_rfc3339());
            match outcome {
                Ok(JobOutcome {
                    tracks,
                    errors,
                    xml_version,
                    library: library_note,
                }) => {
                    s.state = if tracks.is_empty() {
                        JobState::Failed
                    } else {
                        JobState::Done
                    };
                    s.message = summary(
                        &tracks,
                        &errors,
                        &playlist,
                        xml_version.as_deref(),
                        library_note,
                    );
                    s.tracks = tracks;
                    s.errors = errors;
                    s.xml_version = xml_version;
                }
                Err(e) => {
                    s.state = JobState::Failed;
                    s.message = format!("Job failed: {e:#}");
                }
            }
            info!(%job_id, state = ?s.state, tracks = s.tracks.len(), errors = s.errors.len(), "download job finished");
        });
    }
}

/// When the tracks reach Rekordbox's own library (master.db).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LibraryNote {
    /// Rekordbox is closed: applied within seconds.
    Soon,
    /// Rekordbox is open: applied as soon as it quits.
    WhenRekordboxQuits,
    Failed,
}

fn summary(
    tracks: &[JobTrack],
    errors: &[JobError],
    playlist: &str,
    xml_version: Option<&str>,
    library: Option<LibraryNote>,
) -> String {
    let n = tracks.len();
    let songs = if n == 1 { "1 song".to_string() } else { format!("{n} songs") };
    let _ = xml_version; // internal detail; not worth telling the DJ
    let mut msg = match (n, library) {
        (0, _) => "Nothing was downloaded.".to_string(),
        (_, Some(LibraryNote::Soon)) => format!(
            "Added {songs} to \"{playlist}\". They're on their way into your Rekordbox library."
        ),
        (_, Some(LibraryNote::WhenRekordboxQuits)) => format!(
            "Added {songs} to \"{playlist}\". Rekordbox is open, so they'll show up in your \
             library once you close it."
        ),
        _ => format!(
            "Added {songs} to \"{playlist}\". Open Rekordbox and import the playlist to see them."
        ),
    };
    if !errors.is_empty() {
        let links = if errors.len() == 1 { "1 link".to_string() } else { format!("{} links", errors.len()) };
        msg.push_str(&format!(" Sorry, {links} didn't work."));
    }
    msg
}

struct JobOutcome {
    tracks: Vec<JobTrack>,
    errors: Vec<JobError>,
    xml_version: Option<String>,
    library: Option<LibraryNote>,
}

struct Finalized {
    tracks: Vec<JobTrack>,
    errors: Vec<JobError>,
    xml_version: Option<String>,
    library: Option<LibraryNote>,
}

/// One link's staging dir, and whether its downloader exited cleanly.
struct Staged {
    url: String,
    dir: PathBuf,
    fetched: bool,
}

async fn run_job<F: Fetcher>(
    cfg: &DownloadCfg,
    fetcher: &F,
    job_id: &str,
    media: &[MediaRef],
    playlist: &str,
    playlist_id: Option<String>,
    library: Option<Arc<RekordboxLibrary>>,
) -> anyhow::Result<JobOutcome> {
    // Staging lives inside the download dir so the final move is a same-disk rename.
    let staging = cfg.dir.join(".staging").join(job_id);
    let mut errors = Vec::new();
    let mut staged = Vec::new();

    for (i, m) in media.iter().enumerate() {
        let dir = staging.join(i.to_string());
        tokio::fs::create_dir_all(&dir)
            .await
            .with_context(|| format!("creating {}", dir.display()))?;
        let fetched = match fetcher.fetch(m, &dir).await {
            Ok(()) => true,
            Err(e) => {
                warn!(%job_id, url = %m.url(), error = %format!("{e:#}"), "fetch failed");
                errors.push(JobError {
                    url: m.url().to_string(),
                    error: format!("{e:#}"),
                });
                false
            }
        };
        // Keep whatever a partially failed playlist did produce.
        staged.push(Staged {
            url: m.url().to_string(),
            dir,
            fetched,
        });
    }

    let cfg = cfg.clone();
    let playlist = playlist.to_string();
    let staging_root = staging.clone();
    let finalized = tokio::task::spawn_blocking(move || {
        let result = finalize(
            &cfg,
            &staged,
            &playlist,
            playlist_id.as_deref(),
            library.as_deref(),
        );
        if let Err(e) = std::fs::remove_dir_all(&staging_root) {
            warn!(dir = %staging_root.display(), error = %e, "could not remove staging dir");
        }
        // Drop `.staging` itself once no job is using it (fails harmlessly if one is).
        if let Some(parent) = staging_root.parent() {
            let _ = std::fs::remove_dir(parent);
        }
        result
    })
    .await
    .context("finalize task panicked")??;

    errors.extend(finalized.errors);
    Ok(JobOutcome {
        tracks: finalized.tracks,
        errors,
        xml_version: finalized.xml_version,
        library: finalized.library,
    })
}

/// Move staged audio into the download dir, read tags, and upsert the XML.
fn finalize(
    cfg: &DownloadCfg,
    staged: &[Staged],
    playlist: &str,
    playlist_id: Option<&str>,
    library: Option<&RekordboxLibrary>,
) -> anyhow::Result<Finalized> {
    let mut placed = Vec::new();
    let mut errors = Vec::new();

    for Staged { url, dir, fetched } in staged {
        let files = audio_files_in(dir);
        // A failed fetch has already been reported with its own error.
        if files.is_empty() && *fetched {
            errors.push(JobError {
                url: url.clone(),
                error: "the downloader finished but produced no audio files".into(),
            });
        }
        for src in files {
            match place(&src, &cfg.dir) {
                Ok((dest, reused)) => match read_meta(&dest) {
                    Ok(meta) => placed.push((url.clone(), meta, reused)),
                    Err(e) => errors.push(JobError {
                        url: url.clone(),
                        error: format!("unreadable audio file {}: {e:#}", dest.display()),
                    }),
                },
                Err(e) => errors.push(JobError {
                    url: url.clone(),
                    error: format!("{e:#}"),
                }),
            }
        }
    }

    if placed.is_empty() {
        return Ok(Finalized {
            tracks: Vec::new(),
            errors,
            xml_version: None,
            library: None,
        });
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let versions = Versions::for_xml(&cfg.import_xml, cfg.keep_versions);
    // Catch outside edits since startup before we overwrite them.
    let base = versions.reconcile(&cfg.import_xml)?;
    let mut doc = ImportDoc::load_or_new(&cfg.import_xml)?;
    let tracks_before = doc.track_count();
    let playlist_existed = doc.playlist_len(playlist).is_some();
    let mut ids = Vec::new();
    let mut tracks = Vec::new();
    for (url, meta, reused) in &placed {
        ids.push(doc.upsert_track(meta, &today, url));
        tracks.push(JobTrack {
            artist: meta.artist.clone(),
            title: meta.title.clone(),
            file: meta
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            already_downloaded: *reused,
        });
    }
    let appended = doc.upsert_playlist(playlist, &ids);
    let bump = if !playlist_existed {
        Some(Bump::Minor)
    } else if appended > 0 || doc.track_count() > tracks_before {
        Some(Bump::Patch)
    } else {
        None // everything was already there
    };
    let xml_version = match bump {
        Some(bump) => {
            doc.save_atomic(&cfg.import_xml)
                .with_context(|| format!("saving {}", cfg.import_xml.display()))?;
            Some(versions.record(&cfg.import_xml, base, bump)?)
        }
        None => base,
    };
    let library = library.map(|lib| queue_for_library(lib, &placed, playlist, playlist_id));
    Ok(Finalized {
        tracks,
        errors,
        xml_version: xml_version.map(|v| v.to_string()),
        library,
    })
}

/// Queue the same tracks + playlist for Rekordbox's own library. The XML
/// already has them (usable while Rekordbox is open); this makes them land
/// in the real Collection and Playlists.
fn queue_for_library(
    lib: &RekordboxLibrary,
    placed: &[(String, crate::TrackMeta, bool)],
    playlist: &str,
    playlist_id: Option<&str>,
) -> LibraryNote {
    let ops = library_ops(placed, playlist, playlist_id);
    let summary = format!("Add {} track(s) to “{playlist}”", placed.len());
    match lib.enqueue(summary, ops) {
        Ok(_) if lib.rekordbox_running() => LibraryNote::WhenRekordboxQuits,
        Ok(_) => LibraryNote::Soon,
        Err(e) => {
            warn!(error = %format!("{e:#}"), "couldn't queue rekordbox library update");
            LibraryNote::Failed
        }
    }
}

/// rbdb.py ops for downloaded tracks: add each to the Collection, then to the
/// playlist (pinned by id when the cloud resolved one).
fn library_ops(
    placed: &[(String, crate::TrackMeta, bool)],
    playlist: &str,
    playlist_id: Option<&str>,
) -> Vec<serde_json::Value> {
    let pin = |mut op: serde_json::Value| {
        if let Some(id) = playlist_id {
            op["playlist_id"] = serde_json::json!(id);
        }
        op
    };
    let mut ops: Vec<serde_json::Value> = placed
        .iter()
        .map(|(url, meta, _)| {
            serde_json::json!({
                "op": "add_track",
                "path": meta.path,
                "title": meta.title,
                "artist": meta.artist,
                "album": meta.album,
                "genre": meta.genre,
                "year": meta.year,
                "duration_secs": (meta.duration_ms + 500) / 1000,
                "bitrate_kbps": meta.bitrate_kbps,
                "sample_rate": meta.sample_rate,
                "comment": url,
            })
        })
        .collect();
    ops.push(pin(
        serde_json::json!({"op": "ensure_playlist", "name": playlist}),
    ));
    ops.extend(placed.iter().map(|(_, meta, _)| {
        pin(serde_json::json!({"op": "add_to_playlist", "playlist": playlist, "path": meta.path}))
    }));
    ops
}

/// Audio files directly in `dir`, sorted by name (spotdl downloads in
/// parallel, so there's no better order to recover).
fn audio_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_file() && is_audio_file(p))
            .collect(),
        Err(e) => {
            error!(dir = %dir.display(), error = %e, "reading staging dir");
            Vec::new()
        }
    };
    files.sort();
    files
}

/// Move `src` into `dest_dir`. If a same-named file of the same size is
/// already there it's treated as the same track and reused.
fn place(src: &Path, dest_dir: &Path) -> anyhow::Result<(PathBuf, bool)> {
    let name = src
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("staged file has no name: {}", src.display()))?;
    let mut dest = dest_dir.join(name);
    if dest.exists() {
        if std::fs::metadata(&dest)?.len() == std::fs::metadata(src)?.len() {
            std::fs::remove_file(src)?;
            return Ok((dest, true));
        }
        dest = unique_name(&dest);
    }
    std::fs::rename(src, &dest)
        .with_context(|| format!("moving {} -> {}", src.display(), dest.display()))?;
    Ok((dest, false))
}

/// Run a playlist change: mirror it into the import XML (visible under
/// "rekordbox xml" right away, even with Rekordbox open), then queue it for
/// Rekordbox's own library.
async fn run_library_job(
    store: &Mutex<VecDeque<Entry>>,
    job_id: &str,
    cfg: &DownloadCfg,
    work: LibraryWork,
    library: Option<Arc<RekordboxLibrary>>,
) {
    update(store, job_id, |s| {
        s.state = JobState::Running;
        s.started_at = Some(now_rfc3339());
        s.message = format!("{}…", work.summary);
    });
    info!(%job_id, summary = %work.summary, "library job started");
    let cfg = cfg.clone();
    let result = tokio::task::spawn_blocking(
        move || -> anyhow::Result<(Option<Version>, Option<String>, Option<LibraryNote>)> {
            let xml_version = mirror_into_xml(&cfg, &work)?;
            let (batch, note) = match &library {
                Some(lib) => {
                    let id = lib.enqueue(work.summary.clone(), work.ops.clone())?;
                    let note = if lib.rekordbox_running() {
                        LibraryNote::WhenRekordboxQuits
                    } else {
                        LibraryNote::Soon
                    };
                    (Some(id), Some(note))
                }
                None => (None, None),
            };
            Ok((xml_version, batch, note))
        },
    )
    .await
    .map_err(|e| anyhow::anyhow!("library job panicked: {e}"))
    .and_then(|r| r);

    update(store, job_id, |s| {
        s.finished_at = Some(now_rfc3339());
        match result {
            Ok((xml_version, batch, note)) => {
                s.state = JobState::Done;
                s.xml_version = xml_version.map(|v| v.to_string());
                s.library_batch = batch;
                let when = match note {
                    Some(LibraryNote::Soon) => " Going into your Rekordbox library now.",
                    Some(LibraryNote::WhenRekordboxQuits) => {
                        " It goes into your Rekordbox library when you quit Rekordbox; until then \
                         it's under \"rekordbox xml\" (refresh it)."
                    }
                    _ => " It's under \"rekordbox xml\" in Rekordbox (refresh it).",
                };
                s.message = format!("{}.{when}", s.message.trim_end_matches('…'));
            }
            Err(e) => {
                s.state = JobState::Failed;
                s.message = format!("Playlist change failed: {e:#}");
            }
        }
        info!(%job_id, state = ?s.state, "library job finished");
    });
}

/// Apply library ops to the import XML too. Tracks are matched by local path
/// (from the library snapshot); ones without a known path are skipped here
/// but still change Rekordbox's library.
fn mirror_into_xml(cfg: &DownloadCfg, work: &LibraryWork) -> anyhow::Result<Option<Version>> {
    use crate::xml_versions::{Bump, Versions};
    let versions = Versions::for_xml(&cfg.import_xml, cfg.keep_versions);
    let base = versions.reconcile(&cfg.import_xml)?;
    let mut doc = ImportDoc::load_or_new(&cfg.import_xml)?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut bump: Option<Bump> = None;
    let mut note = |b: Bump| {
        bump = Some(match (bump, b) {
            (Some(Bump::Minor), _) | (_, Bump::Minor) => Bump::Minor,
            _ => Bump::Patch,
        })
    };
    let str_of =
        |op: &serde_json::Value, k: &str| op.get(k).and_then(|v| v.as_str()).map(str::to_string);

    for op in &work.ops {
        let (Some(kind), name) = (
            str_of(op, "op"),
            str_of(op, "name").or_else(|| str_of(op, "playlist")),
        ) else {
            continue;
        };
        let name = name.unwrap_or_default();
        let path = str_of(op, "content_id").and_then(|id| work.paths.get(&id).cloned());
        match kind.as_str() {
            "ensure_playlist" if doc.playlist_len(&name).is_none() => {
                doc.upsert_playlist(&name, &[]);
                note(Bump::Minor);
            }
            "add_to_playlist" => {
                let Some(path) = path else { continue };
                let Ok(meta) = read_meta(&path) else { continue };
                if doc.playlist_len(&name).is_none() {
                    note(Bump::Minor);
                }
                let before = doc.track_count();
                let id = doc.upsert_track(&meta, &today, "");
                if doc.upsert_playlist(&name, &[id]) > 0 || doc.track_count() > before {
                    note(Bump::Patch);
                }
            }
            "remove_from_playlist" => {
                let Some(id) = path.and_then(|p| doc.track_id_for_path(&p)) else {
                    continue;
                };
                if doc.remove_from_playlist(&name, &id) {
                    note(Bump::Patch);
                }
            }
            "rename_playlist" => {
                if let Some(new_name) = str_of(op, "new_name") {
                    if doc.rename_playlist(&name, &new_name) {
                        note(Bump::Patch);
                    }
                }
            }
            "delete_playlist" => {
                if doc.delete_playlist(&name) {
                    note(Bump::Patch);
                }
            }
            _ => {}
        }
    }
    match bump {
        Some(b) => {
            doc.save_atomic(&cfg.import_xml)?;
            Ok(Some(versions.record(&cfg.import_xml, base, b)?))
        }
        None => Ok(base),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::extract_media_ref;
    use crate::rekordbox_xml::RekordboxLib;
    use std::time::Duration;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3")
    }

    /// Copies the fixture under a name derived from the URL; "fail" URLs error out.
    struct FakeFetcher;

    impl Fetcher for FakeFetcher {
        async fn fetch(&self, media: &MediaRef, staging: &Path) -> anyhow::Result<()> {
            let url = media.url().as_str();
            if url.contains("fail") {
                anyhow::bail!("exited with exit status: 1:\nERROR: unavailable");
            }
            let name = url.rsplit(['/', '=']).next().unwrap();
            std::fs::copy(fixture(), staging.join(format!("DJ Test - {name}.mp3")))?;
            Ok(())
        }
    }

    fn cfg(dir: &Path) -> DownloadCfg {
        DownloadCfg {
            dir: dir.join("DJ_Downloads"),
            import_xml: dir.join("rekordbox_import.xml"),
            ..DownloadCfg::default()
        }
    }

    fn media(urls: &[&str]) -> Vec<MediaRef> {
        urls.iter().map(|u| extract_media_ref(u).unwrap()).collect()
    }

    async fn wait_done(q: &JobQueue, id: &str) -> JobStatus {
        for _ in 0..200 {
            let s = q.get(id).unwrap();
            if !s.state.is_active() {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job {id} never finished");
    }

    #[tokio::test]
    async fn job_downloads_places_files_and_writes_playlist() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        let (q, _w) = JobQueue::start(c.clone(), FakeFetcher).unwrap();
        assert!(c.import_xml.exists(), "empty xml created at startup");

        let sub = q
            .submit(
                media(&[
                    "https://open.spotify.com/track/abc123",
                    "https://youtu.be/dQw4w9WgXcQ",
                ]),
                Some("  Friday \n Set "),
            )
            .unwrap();
        assert_eq!(sub.job.playlist, "Friday Set");
        assert!(!sub.deduplicated);

        let done = wait_done(&q, &sub.job.job_id).await;
        assert_eq!(done.state, JobState::Done, "{done:?}");
        assert_eq!(done.tracks.len(), 2);
        assert_eq!(done.tracks[0].title, "Fixture Tune");
        assert!(done.errors.is_empty());
        assert!(c.dir.join("DJ Test - abc123.mp3").exists());
        assert!(c.dir.join("DJ Test - dQw4w9WgXcQ.mp3").exists());
        assert!(!c.dir.join(".staging").join(&done.job_id).exists());

        let lib = RekordboxLib::load(&c.import_xml).unwrap();
        assert_eq!(lib.lookup("Friday Set").unwrap().track_ids.len(), 2);
    }

    #[tokio::test]
    async fn partial_failure_keeps_good_tracks_and_reports_bad_link() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        let (q, _w) = JobQueue::start(c.clone(), FakeFetcher).unwrap();

        let sub = q
            .submit(
                media(&[
                    "https://open.spotify.com/track/fail1",
                    "https://open.spotify.com/track/good1",
                ]),
                None,
            )
            .unwrap();
        let done = wait_done(&q, &sub.job.job_id).await;
        assert_eq!(done.state, JobState::Done);
        assert_eq!(done.playlist, "DJ Sync Downloads");
        assert_eq!(done.tracks.len(), 1);
        assert_eq!(done.errors.len(), 1);
        assert!(done.errors[0].url.ends_with("fail1"));
        assert!(done.errors[0].error.contains("ERROR: unavailable"));
        assert!(done.message.contains("1 link didn't work"));
    }

    #[tokio::test]
    async fn all_links_failing_marks_job_failed_and_leaves_xml_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        let (q, _w) = JobQueue::start(c.clone(), FakeFetcher).unwrap();
        let before = std::fs::read_to_string(&c.import_xml).unwrap();

        let sub = q
            .submit(media(&["https://open.spotify.com/track/fail2"]), None)
            .unwrap();
        let done = wait_done(&q, &sub.job.job_id).await;
        assert_eq!(done.state, JobState::Failed);
        assert_eq!(std::fs::read_to_string(&c.import_xml).unwrap(), before);
    }

    #[tokio::test]
    async fn redownload_reuses_existing_file_and_appends_to_second_playlist() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        let (q, _w) = JobQueue::start(c.clone(), FakeFetcher).unwrap();
        let link = ["https://open.spotify.com/track/same1"];

        let a = q.submit(media(&link), Some("One")).unwrap();
        wait_done(&q, &a.job.job_id).await;
        let b = q.submit(media(&link), Some("Two")).unwrap();
        let done = wait_done(&q, &b.job.job_id).await;

        assert!(done.tracks[0].already_downloaded);
        assert!(!c.dir.join("DJ Test - same1 (1).mp3").exists());
        let lib = RekordboxLib::load(&c.import_xml).unwrap();
        assert_eq!(
            lib.tracks.len(),
            1,
            "one collection entry shared by both playlists"
        );
        assert_eq!(
            lib.lookup("One").unwrap().track_ids,
            lib.lookup("Two").unwrap().track_ids
        );
    }

    #[tokio::test]
    async fn identical_active_submission_is_deduplicated() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        // A fetcher that never finishes keeps the first job active.
        struct Stuck;
        impl Fetcher for Stuck {
            async fn fetch(&self, _: &MediaRef, _: &Path) -> anyhow::Result<()> {
                std::future::pending().await
            }
        }
        let (q, _w) = JobQueue::start(c, Stuck).unwrap();
        let link = ["https://youtu.be/dQw4w9WgXcQ"];
        let a = q.submit(media(&link), Some("X")).unwrap();
        let b = q.submit(media(&link), Some("X")).unwrap();
        let c2 = q.submit(media(&link), Some("Y")).unwrap();
        assert!(b.deduplicated);
        assert_eq!(a.job.job_id, b.job.job_id);
        assert_ne!(a.job.job_id, c2.job.job_id);
        assert_eq!(c2.position, 1);
        assert_eq!(q.recent(5)[0].job_id, c2.job.job_id, "newest first");
    }

    #[tokio::test]
    async fn every_write_is_a_semver_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        let versions = crate::xml_versions::Versions::for_xml(&c.import_xml, 100);
        let (q, _w) = JobQueue::start(c.clone(), FakeFetcher).unwrap();
        let listed =
            || -> Vec<String> { versions.list().iter().map(|(v, _)| v.to_string()).collect() };
        assert_eq!(listed(), ["1.0.0"], "the empty file is the baseline");

        let run = |links: &'static [&'static str], playlist: &'static str| {
            let q = q.clone();
            async move {
                let s = q.submit(media(links), Some(playlist)).unwrap();
                wait_done(&q, &s.job.job_id).await
            }
        };

        // New playlist → MINOR.
        let a = run(&["https://open.spotify.com/track/one1"], "Fri").await;
        assert_eq!(a.xml_version.as_deref(), Some("1.1.0"));
        assert!(a.message.contains("Added 1 song to"), "{}", a.message);
        // Tracks added to an existing playlist → PATCH.
        let b = run(&["https://open.spotify.com/track/two2"], "Fri").await;
        assert_eq!(b.xml_version.as_deref(), Some("1.1.1"));
        // Nothing new → no write, no version.
        let c2 = run(&["https://open.spotify.com/track/two2"], "Fri").await;
        assert_eq!(c2.xml_version.as_deref(), Some("1.1.1"));
        assert_eq!(listed(), ["1.0.0", "1.1.0", "1.1.1"]);

        // An outside edit is preserved as the next MAJOR before the next write.
        let mut edited = std::fs::read_to_string(&c.import_xml).unwrap();
        edited = edited.replace("Name=\"Fri\"", "Name=\"Friday (renamed in Rekordbox)\"");
        std::fs::write(&c.import_xml, &edited).unwrap();
        let d = run(&["https://open.spotify.com/track/thr3"], "Sat").await;
        assert_eq!(d.xml_version.as_deref(), Some("2.1.0"));
        assert_eq!(listed(), ["1.0.0", "1.1.0", "1.1.1", "2.0.0", "2.1.0"]);
        let v2 = versions
            .list()
            .into_iter()
            .find(|(v, _)| v.to_string() == "2.0.0")
            .unwrap()
            .1;
        assert_eq!(std::fs::read_to_string(v2).unwrap(), edited);
        // The renamed playlist survived our write.
        let lib = RekordboxLib::load(&c.import_xml).unwrap();
        assert!(lib.lookup("Friday (renamed in Rekordbox)").is_some());
        assert!(lib.lookup("Sat").is_some());
    }

    #[tokio::test]
    async fn existing_file_is_adopted_as_baseline_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        std::fs::create_dir_all(c.import_xml.parent().unwrap()).unwrap();
        let original = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.11" Company="AlphaTheta"/>
  <COLLECTION Entries="0"/>
  <PLAYLISTS><NODE Type="0" Name="ROOT" Count="1">
    <NODE Name="Mine" Type="1" KeyType="0" Entries="0"/>
  </NODE></PLAYLISTS>
</DJ_PLAYLISTS>"#;
        std::fs::write(&c.import_xml, original).unwrap();
        let (_q, _w) = JobQueue::start(c.clone(), FakeFetcher).unwrap();
        let versions = crate::xml_versions::Versions::for_xml(&c.import_xml, 100);
        let (v, path) = versions.latest().unwrap();
        assert_eq!(v.to_string(), "1.0.0");
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
        assert_eq!(
            std::fs::read_to_string(&c.import_xml).unwrap(),
            original,
            "startup doesn't write"
        );
    }

    #[tokio::test]
    async fn download_folder_change_applies_to_the_next_job_without_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = tmp.path().join("settings.json");
        let c = DownloadCfg {
            settings_file: Some(settings.clone()),
            ..cfg(tmp.path())
        };
        let (q, _w) = JobQueue::start(c.clone(), FakeFetcher).unwrap();

        let a = q
            .submit(media(&["https://open.spotify.com/track/aaa1"]), None)
            .unwrap();
        wait_done(&q, &a.job.job_id).await;
        assert!(
            c.dir.join("DJ Test - aaa1.mp3").exists(),
            "config folder first"
        );

        // The menu bar app picks a new folder while dj-sync keeps running.
        let chosen = tmp.path().join("Chosen/DJ");
        std::fs::write(&settings, format!(r#"{{"download_dir":{:?}}}"#, chosen)).unwrap();
        let b = q
            .submit(media(&["https://open.spotify.com/track/bbb2"]), None)
            .unwrap();
        let done = wait_done(&q, &b.job.job_id).await;
        assert_eq!(done.state, JobState::Done, "{done:?}");
        assert!(
            chosen.join("DJ Test - bbb2.mp3").exists(),
            "new folder, created on demand"
        );
        assert!(!c.dir.join("DJ Test - bbb2.mp3").exists());
        // Rekordbox points at wherever each file actually landed.
        let lib = RekordboxLib::load(&c.import_xml).unwrap();
        let paths: Vec<_> = lib.tracks.values().map(|t| t.path.clone()).collect();
        assert!(paths.contains(&chosen.join("DJ Test - bbb2.mp3")));
        assert!(paths.contains(&c.dir.join("DJ Test - aaa1.mp3")));
    }

    fn library_stub(dir: &Path, running: bool) -> Arc<RekordboxLibrary> {
        let cfg = crate::config::RekordboxDbCfg {
            enabled: true,
            db_path: dir.join("master.db"),
            ..Default::default()
        };
        Arc::new(RekordboxLibrary::with_parts(
            cfg,
            dir.join("state"),
            crate::rekordbox_db::Helper {
                program: "/usr/bin/true".into(),
                prefix_args: vec![],
            },
            Arc::new(move || running),
        ))
    }

    fn library_work(ops: Vec<serde_json::Value>, paths: &[(&str, &Path)]) -> LibraryWork {
        LibraryWork {
            summary: "Change playlists".into(),
            playlist: "Sat".into(),
            ops,
            paths: paths
                .iter()
                .map(|(id, p)| (id.to_string(), p.to_path_buf()))
                .collect(),
        }
    }

    #[tokio::test]
    async fn library_jobs_mirror_into_xml_and_queue_for_rekordbox() {
        use serde_json::json;
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        let lib = library_stub(tmp.path(), true);
        let (q, _w) = JobQueue::start_with(c.clone(), FakeFetcher, Some(lib.clone())).unwrap();
        let track = tmp.path().join("lib/Track One.mp3");
        std::fs::create_dir_all(track.parent().unwrap()).unwrap();
        std::fs::copy(fixture(), &track).unwrap();

        let create = library_work(
            vec![
                json!({"op": "ensure_playlist", "name": "Sat"}),
                json!({"op": "add_to_playlist", "playlist": "Sat", "content_id": "101"}),
                json!({"op": "add_to_playlist", "playlist": "Sat", "content_id": "999"}),
            ],
            &[("101", &track)],
        );
        let s = q.submit_library(create.clone()).unwrap();
        assert_eq!(s.job.kind, JobKind::Library);
        let done = wait_done(&q, &s.job.job_id).await;
        assert_eq!(done.state, JobState::Done, "{done:?}");
        assert_eq!(
            done.xml_version.as_deref(),
            Some("1.1.0"),
            "new playlist → minor"
        );
        assert!(
            done.message.contains("when you quit Rekordbox"),
            "{}",
            done.message
        );
        let batch = done.library_batch.clone().expect("queued for the library");
        assert_eq!(
            lib.batch_outcome(&batch),
            crate::rekordbox_db::BatchOutcome::Pending
        );

        // In the XML: the playlist with the one track whose path we know.
        let lib_xml = RekordboxLib::load(&c.import_xml).unwrap();
        let sat = lib_xml.lookup("Sat").unwrap();
        assert_eq!(sat.track_ids.len(), 1);
        assert_eq!(lib_xml.tracks[&sat.track_ids[0]].path, track);

        // Retrying the same change while it's still active is deduplicated.
        let again = q.submit_library(create).unwrap();
        assert!(!again.deduplicated, "the first one already finished");

        // Rename, remove, delete are mirrored too (patch bumps).
        let edit = library_work(
            vec![
                json!({"op": "remove_from_playlist", "playlist": "Sat", "content_id": "101"}),
                json!({"op": "rename_playlist", "name": "Sat", "new_name": "Saturday"}),
            ],
            &[("101", &track)],
        );
        let s = q.submit_library(edit).unwrap();
        let done = wait_done(&q, &s.job.job_id).await;
        let lib_xml = RekordboxLib::load(&c.import_xml).unwrap();
        // (lookup() also matches substrings, so compare names exactly.)
        let names: Vec<&str> = lib_xml.flat().iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Saturday"]);
        assert!(lib_xml.flat()[0].track_ids.is_empty());
        assert!(done.xml_version.unwrap().starts_with("1.1."), "patch");

        let del = library_work(
            vec![json!({"op": "delete_playlist", "name": "Saturday"})],
            &[],
        );
        let s = q.submit_library(del).unwrap();
        wait_done(&q, &s.job.job_id).await;
        assert!(RekordboxLib::load(&c.import_xml).unwrap().flat().is_empty());
    }

    #[tokio::test]
    async fn library_jobs_without_rekordbox_db_still_update_the_xml() {
        use serde_json::json;
        let tmp = tempfile::tempdir().unwrap();
        let c = cfg(tmp.path());
        let (q, _w) = JobQueue::start(c.clone(), FakeFetcher).unwrap();
        let s = q
            .submit_library(library_work(
                vec![json!({"op": "ensure_playlist", "name": "Sat"})],
                &[],
            ))
            .unwrap();
        let done = wait_done(&q, &s.job.job_id).await;
        assert_eq!(done.state, JobState::Done);
        assert!(done.library_batch.is_none());
        assert!(RekordboxLib::load(&c.import_xml)
            .unwrap()
            .lookup("Sat")
            .is_some());
    }

    #[test]
    fn download_ops_pin_the_resolved_playlist() {
        let meta = crate::library::read_meta(&fixture()).unwrap();
        let placed = vec![("https://youtu.be/x".to_string(), meta, false)];
        let ops = library_ops(&placed, "Gqom", Some("123"));
        let kinds: Vec<&str> = ops.iter().map(|o| o["op"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["add_track", "ensure_playlist", "add_to_playlist"]);
        assert_eq!(ops[1]["playlist_id"], "123");
        assert_eq!(ops[2]["playlist_id"], "123");
        assert!(ops[0].get("playlist_id").is_none());
        let loose = library_ops(&placed, "New One", None);
        assert!(loose.iter().all(|o| o.get("playlist_id").is_none()));
    }

    #[test]
    fn playlist_names_are_cleaned_and_bounded() {
        assert_eq!(normalize_playlist_name(None, "D").unwrap(), "D");
        assert_eq!(normalize_playlist_name(Some(" \t "), "D").unwrap(), "D");
        assert_eq!(
            normalize_playlist_name(Some("a\u{0}b\n c"), "D").unwrap(),
            "a b c"
        );
        assert!(normalize_playlist_name(Some(&"x".repeat(101)), "D").is_err());
    }
}
