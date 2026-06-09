use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lofty::{Accessor, AudioFile, ItemKey, Probe, TaggedFileExt};
use tracing::{debug, warn};
use walkdir::WalkDir;

use crate::LocalTrack;

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
    let tagged = Probe::open(path)?.guess_file_type()?.read()?;
    let primary = tagged.primary_tag().or_else(|| tagged.first_tag());
    let (artist, title, isrc) = match primary {
        Some(t) => (
            t.artist().map(|s| s.to_string()).unwrap_or_default(),
            t.title().map(|s| s.to_string()).unwrap_or_default(),
            t.get_string(&ItemKey::Isrc).map(|s| s.to_string()),
        ),
        None => (String::new(), String::new(), None),
    };

    let duration_ms = tagged.properties().duration().as_millis().try_into().ok();

    Ok(LocalTrack {
        path: path.to_path_buf(),
        isrc,
        artist,
        title,
        duration_ms,
    })
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
