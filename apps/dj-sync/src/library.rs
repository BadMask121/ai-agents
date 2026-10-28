use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lofty::{Accessor, AudioFile, ItemKey, Probe, TaggedFileExt};
use tracing::{debug, warn};
use walkdir::WalkDir;

use crate::{LocalTrack, TrackMeta};

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "aac", "m4a", "wav", "aiff", "aif", "ogg"];

pub struct LibraryIndex {
    tracks: Vec<LocalTrack>,
    by_isrc: HashMap<String, usize>,
}

impl LibraryIndex {
    pub fn build<P: AsRef<Path>>(roots: &[P]) -> anyhow::Result<Self> {
        let mut tracks = Vec::new();
        for root in roots {
            for entry in WalkDir::new(root.as_ref())
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path();
                if !is_audio(path) {
                    continue;
                }
                match read_track(path) {
                    Ok(t) => tracks.push(t),
                    Err(e) => warn!(file = %path.display(), error = %e, "skipping unreadable file"),
                }
            }
        }

        let by_isrc = tracks
            .iter()
            .enumerate()
            .filter_map(|(i, t)| t.isrc.as_ref().map(|isrc| (normalize_isrc(isrc), i)))
            .collect();

        debug!(count = tracks.len(), "library index built");
        Ok(Self { tracks, by_isrc })
    }

    pub fn len(&self) -> usize {
        self.tracks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    pub fn lookup_isrc(&self, isrc: &str) -> Option<&LocalTrack> {
        self.by_isrc
            .get(&normalize_isrc(isrc))
            .map(|i| &self.tracks[*i])
    }

    pub fn all(&self) -> &[LocalTrack] {
        &self.tracks
    }

    pub fn from_tracks_for_test(tracks: Vec<LocalTrack>) -> Self {
        let by_isrc = tracks
            .iter()
            .enumerate()
            .filter_map(|(i, t)| t.isrc.as_ref().map(|isrc| (normalize_isrc(isrc), i)))
            .collect();
        Self { tracks, by_isrc }
    }
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.iter().any(|ext| ext.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

fn read_track(path: &Path) -> anyhow::Result<LocalTrack> {
    let meta = read_meta(path)?;
    Ok(LocalTrack {
        path: meta.path,
        isrc: meta.isrc,
        artist: meta.artist,
        title: meta.title,
        duration_ms: Some(meta.duration_ms),
    })
}

/// Read tags and audio properties for one file. Missing tags become empty
/// strings / `None`; only an unreadable file is an error. No display
/// fallbacks here — callers decide what an untitled track should show.
pub fn read_meta(path: &Path) -> anyhow::Result<TrackMeta> {
    let tagged = Probe::open(path)?.guess_file_type()?.read()?;
    let props = tagged.properties();

    let mut meta = TrackMeta {
        path: path.to_path_buf(),
        duration_ms: props.duration().as_millis().try_into().unwrap_or(u32::MAX),
        bitrate_kbps: props.audio_bitrate().or(props.overall_bitrate()),
        sample_rate: props.sample_rate(),
        size_bytes: std::fs::metadata(path)?.len(),
        kind: rekordbox_kind(path).to_string(),
        ..TrackMeta::default()
    };

    if let Some(t) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        let s = |v: Option<std::borrow::Cow<'_, str>>| v.map(|c| c.into_owned());
        meta.title = s(t.title()).unwrap_or_default();
        meta.artist = s(t.artist()).unwrap_or_default();
        meta.album = s(t.album()).unwrap_or_default();
        meta.genre = s(t.genre()).unwrap_or_default();
        meta.isrc = t.get_string(&ItemKey::Isrc).map(|v| v.to_string());
        // yt-dlp writes dates as YYYYMMDD, which lofty doesn't parse as a year.
        meta.year = t.year().filter(|y| *y > 0).or_else(|| {
            t.get_string(&ItemKey::RecordingDate)
                .and_then(|d| d.get(..4))
                .and_then(|y| y.parse().ok())
        });
    }

    Ok(meta)
}

/// Rekordbox's `Kind` strings, as seen in its own XML exports.
fn rekordbox_kind(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => "MP3 File",
        "m4a" | "aac" => "M4A File",
        "mp4" => "MP4 File",
        "flac" => "FLAC File",
        "wav" => "WAV File",
        "aif" | "aiff" => "AIFF File",
        _ => "Unknown Format",
    }
}

pub fn is_audio_file(path: &Path) -> bool {
    is_audio(path)
}

pub fn normalize_isrc(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

pub fn cache_path() -> anyhow::Result<PathBuf> {
    Ok(crate::config::state_dir()?.join("library.index.bin"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3")
    }

    #[test]
    fn read_meta_reads_tags_and_audio_properties() {
        let m = read_meta(&fixture()).unwrap();
        assert_eq!(m.title, "Fixture Tune");
        assert_eq!(m.artist, "DJ Test");
        assert_eq!(m.album, "Fixtures");
        assert_eq!(m.genre, "Amapiano");
        assert_eq!(m.year, Some(2024));
        assert_eq!(m.kind, "MP3 File");
        assert_eq!(m.sample_rate, Some(44_100));
        assert!(m.bitrate_kbps.is_some());
        assert!((900..=1200).contains(&m.duration_ms), "{}", m.duration_ms);
        assert_eq!(m.size_bytes, std::fs::metadata(fixture()).unwrap().len());
    }

    #[test]
    fn rekordbox_kind_matches_export_strings() {
        assert_eq!(rekordbox_kind(Path::new("a.MP3")), "MP3 File");
        assert_eq!(rekordbox_kind(Path::new("a.m4a")), "M4A File");
        assert_eq!(rekordbox_kind(Path::new("a.aiff")), "AIFF File");
        assert_eq!(rekordbox_kind(Path::new("a.opus")), "Unknown Format");
    }
}
