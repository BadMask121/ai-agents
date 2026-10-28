//! Download jobs: a bounded queue drained by ONE worker, so spotdl / yt-dlp
//! never run concurrently and only one task ever writes the import XML.
//!
//! Jobs live in memory (last `KEEP_JOBS`); a restart forgets history but
//! never loses files — anything already moved into the download dir and
//! written to the XML stays there.

use std::collections::VecDeque;
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

#[derive(Debug, Clone, Serialize)]
pub struct JobStatus {
    pub job_id: JobId,
    pub state: JobState,
    pub playlist: String,
    pub urls: Vec<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub tracks: Vec<JobTrack>,
    pub errors: Vec<JobError>,
    pub message: String,
}

struct Entry {
    status: JobStatus,
    media: Vec<MediaRef>,
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
        cfg.prepare()?;
        // Jobs don't survive a restart, so anything still staged is debris.
        let _ = std::fs::remove_dir_all(cfg.dir.join(".staging"));
        if cfg.import_xml.exists() {
            if let Some(backup) = ImportDoc::backup_foreign(&cfg.import_xml)? {
                info!(
                    original = %cfg.import_xml.display(),
                    backup = %backup.display(),
                    "backed up the existing import xml before dj-sync writes to it"
                );
            }
        } else {
            if let Some(parent) = cfg.import_xml.parent() {
                std::fs::create_dir_all(parent)?;
            }
            ImportDoc::new()
                .save_atomic(&cfg.import_xml)
                .context("creating empty import xml")?;
            info!(path = %cfg.import_xml.display(), "created rekordbox import xml");
        }

        let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
        let store = Arc::new(Mutex::new(VecDeque::new()));
        let queue = Self {
            tx,
            store: store.clone(),
            default_playlist: cfg.default_playlist.clone(),
        };
        let worker = tokio::spawn(worker(rx, store, cfg, fetcher));
        Ok((queue, worker))
    }

    pub fn submit(
        &self,
        media: Vec<MediaRef>,
        playlist: Option<&str>,
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

        let job_id = new_job_id();
        let status = JobStatus {
            job_id: job_id.clone(),
            state: JobState::Queued,
            playlist,
            urls,
            created_at: now_rfc3339(),
            started_at: None,
            finished_at: None,
            tracks: Vec::new(),
            errors: Vec::new(),
            message: "Queued.".into(),
        };
        self.tx
            .try_send(job_id.clone())
            .map_err(|_| anyhow::anyhow!("download queue is full; try again later"))?;
        store.push_back(Entry {
            status: status.clone(),
            media,
        });
        trim(&mut store);
        let position = position_of(&store, &job_id);
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
) {
    while let Some(job_id) = rx.recv().await {
        let Some((media, playlist)) = ({
            let store = store.lock().expect("job store");
            store
                .iter()
                .find(|e| e.status.job_id == job_id)
                .map(|e| (e.media.clone(), e.status.playlist.clone()))
        }) else {
            continue;
        };

        update(&store, &job_id, |s| {
            s.state = JobState::Running;
            s.started_at = Some(now_rfc3339());
            s.message = format!("Downloading {} link(s)…", media.len());
        });
        info!(%job_id, links = media.len(), %playlist, "download job started");

        let outcome = run_job(&cfg, &fetcher, &job_id, &media, &playlist).await;

        update(&store, &job_id, |s| {
            s.finished_at = Some(now_rfc3339());
            match outcome {
                Ok(JobOutcome { tracks, errors }) => {
                    s.state = if tracks.is_empty() {
                        JobState::Failed
                    } else {
                        JobState::Done
                    };
                    s.message = summary(&tracks, &errors, &playlist);
                    s.tracks = tracks;
                    s.errors = errors;
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

fn summary(tracks: &[JobTrack], errors: &[JobError], playlist: &str) -> String {
    let mut msg = if tracks.is_empty() {
        "No tracks were downloaded.".to_string()
    } else {
        format!(
            "Added {} track(s) to the Rekordbox playlist \"{playlist}\". In Rekordbox, reload the \
             \"rekordbox xml\" tree and drag the playlist into your collection.",
            tracks.len()
        )
    };
    if !errors.is_empty() {
        msg.push_str(&format!(" {} link(s) failed — see errors.", errors.len()));
    }
    msg
}

struct JobOutcome {
    tracks: Vec<JobTrack>,
    errors: Vec<JobError>,
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
    let (tracks, mut file_errors) = tokio::task::spawn_blocking(move || {
        let result = finalize(&cfg, &staged, &playlist);
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

    errors.append(&mut file_errors);
    Ok(JobOutcome { tracks, errors })
}

/// Move staged audio into the download dir, read tags, and upsert the XML.
fn finalize(
    cfg: &DownloadCfg,
    staged: &[Staged],
    playlist: &str,
) -> anyhow::Result<(Vec<JobTrack>, Vec<JobError>)> {
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
        return Ok((Vec::new(), errors));
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut doc = ImportDoc::load_or_new(&cfg.import_xml)?;
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
    doc.upsert_playlist(playlist, &ids);
    doc.save_atomic(&cfg.import_xml)
        .with_context(|| format!("saving {}", cfg.import_xml.display()))?;
    Ok((tracks, errors))
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
        assert_eq!(done.playlist, "ChatGPT Downloads");
        assert_eq!(done.tracks.len(), 1);
        assert_eq!(done.errors.len(), 1);
        assert!(done.errors[0].url.ends_with("fail1"));
        assert!(done.errors[0].error.contains("ERROR: unavailable"));
        assert!(done.message.contains("1 link(s) failed"));
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
