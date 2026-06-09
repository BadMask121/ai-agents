use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{anyhow, Context};
use serde::Deserialize;
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub struct RekordboxLib {
    pub tracks: HashMap<String, Track>,
    pub root: PlaylistNode,
    pub xml_path: PathBuf,
    pub loaded_at: SystemTime,
    pub source_mtime: SystemTime,
    flat_index: Vec<FlatEntry>,
}

#[derive(Debug, Clone)]
pub struct Track {
    pub track_id: String,
    pub file_name: String,
    pub name: String,
    pub artist: String,
    pub bpm: Option<f32>,
    pub key: Option<String>,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub enum PlaylistNode {
    Folder {
        name: String,
        children: Vec<PlaylistNode>,
    },
    Playlist {
        name: String,
        track_ids: Vec<String>,
    },
}

#[derive(Debug, Clone)]
pub struct FlatEntry {
    pub number: usize,
    pub name: String,
    pub path_segments: Vec<String>,
    pub track_ids: Vec<String>,
}

impl RekordboxLib {
    pub fn load(xml_path: &Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(xml_path)
            .with_context(|| format!("reading {}", xml_path.display()))?;
        let mtime = std::fs::metadata(xml_path)?.modified()?;

        let doc: DjPlaylists = quick_xml::de::from_reader(&bytes[..])
            .with_context(|| format!("parsing {}", xml_path.display()))?;

        let mut tracks: HashMap<String, Track> = HashMap::with_capacity(doc.collection.tracks.len());
        for t in doc.collection.tracks {
            let path = decode_location(&t.location);
            let file_name = path
                .file_name()
                .and_then(|f| f.to_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
            tracks.insert(
                t.track_id.clone(),
                Track {
                    track_id: t.track_id,
                    file_name,
                    name: t.name,
                    artist: t.artist,
                    bpm: parse_bpm(&t.average_bpm),
                    key: non_empty(t.tonality),
                    path,
                },
            );
        }

        let root = build_node(doc.playlists.root)
            .ok_or_else(|| anyhow!("playlists root missing"))?;

        let mut flat_index = Vec::new();
        let mut counter = 0usize;
        flatten(&root, &mut Vec::new(), &mut counter, &mut flat_index);

        info!(
            tracks = tracks.len(),
            playlists = flat_index.len(),
            "loaded rekordbox xml"
        );

        Ok(Self {
            tracks,
            root,
            xml_path: xml_path.to_path_buf(),
            loaded_at: SystemTime::now(),
            source_mtime: mtime,
            flat_index,
        })
    }

    pub fn reload_if_changed(&mut self) -> anyhow::Result<bool> {
        let mtime = std::fs::metadata(&self.xml_path)?.modified()?;
        if mtime <= self.source_mtime {
            return Ok(false);
        }
        let fresh = Self::load(&self.xml_path)?;
        *self = fresh;
        Ok(true)
    }

    pub fn flat(&self) -> &[FlatEntry] {
        &self.flat_index
    }

    pub fn lookup(&self, query: &str) -> Option<&FlatEntry> {
        if let Ok(n) = query.trim().parse::<usize>() {
            return self.flat_index.iter().find(|e| e.number == n);
        }
        let q = query.trim().to_lowercase();
        self.flat_index
            .iter()
            .find(|e| e.name.to_lowercase() == q)
            .or_else(|| {
                self.flat_index
                    .iter()
                    .find(|e| e.name.to_lowercase().contains(&q))
            })
    }

    pub fn folder_count(&self) -> usize {
        let mut n = 0;
        count_folders(&self.root, &mut n);
        n
    }
}

fn count_folders(node: &PlaylistNode, n: &mut usize) {
    if let PlaylistNode::Folder { children, .. } = node {
        *n += 1;
        for c in children {
            count_folders(c, n);
        }
    }
}

fn parse_bpm(s: &str) -> Option<f32> {
    let v: f32 = s.parse().ok()?;
    if v <= 0.0 {
        None
    } else {
        Some(v)
    }
}

fn non_empty(s: String) -> Option<String> {
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

fn decode_location(loc: &str) -> PathBuf {
    if let Ok(url) = url::Url::parse(loc) {
        if let Ok(p) = url.to_file_path() {
            return p;
        }
    }
    PathBuf::from(loc)
}

fn build_node(n: NodeXml) -> Option<PlaylistNode> {
    match n.type_ {
        0 => Some(PlaylistNode::Folder {
            name: n.name,
            children: n.children.into_iter().filter_map(build_node).collect(),
        }),
        1 => Some(PlaylistNode::Playlist {
            name: n.name,
            track_ids: n.track_refs.into_iter().map(|t| t.key).collect(),
        }),
        other => {
            warn!(node_type = other, "unknown rekordbox NODE type, skipping");
            None
        }
    }
}

fn flatten(
    node: &PlaylistNode,
    path: &mut Vec<String>,
    counter: &mut usize,
    out: &mut Vec<FlatEntry>,
) {
    match node {
        PlaylistNode::Folder { name, children } => {
            // The synthetic "ROOT" folder has no display value.
            let push = name != "ROOT";
            if push {
                path.push(name.clone());
            }
            for c in children {
                flatten(c, path, counter, out);
            }
            if push {
                path.pop();
            }
        }
        PlaylistNode::Playlist { name, track_ids } => {
            *counter += 1;
            out.push(FlatEntry {
                number: *counter,
                name: name.clone(),
                path_segments: path.clone(),
                track_ids: track_ids.clone(),
            });
        }
    }
}

// ---------- rendering ----------

pub fn render_playlists_listing(lib: &RekordboxLib) -> Vec<String> {
    if lib.flat_index.is_empty() {
        return vec!["no playlists found in rekordbox.xml".to_string()];
    }
    let mut buf = String::from("PLAYLISTS\n\n");
    let mut last_path: Vec<String> = Vec::new();
    for e in &lib.flat_index {
        // Print any folder headers that just opened.
        for (depth, seg) in e.path_segments.iter().enumerate() {
            if last_path.get(depth) != Some(seg) {
                let indent = "  ".repeat(depth);
                buf.push_str(&format!("{indent}{seg}/\n"));
            }
        }
        let indent = "  ".repeat(e.path_segments.len());
        buf.push_str(&format!("{indent}{}. {}\n", e.number, e.name));
        last_path = e.path_segments.clone();
    }
    buf.push_str("\n→ /playlist <number>");
    chunk(buf, 3500)
}

pub fn render_playlist(lib: &RekordboxLib, entry: &FlatEntry) -> Vec<String> {
    let breadcrumb = if entry.path_segments.is_empty() {
        String::new()
    } else {
        format!("{}/", entry.path_segments.join("/"))
    };
    let header = format!(
        "🎧 {}{}  —  {} tracks\n\n",
        breadcrumb,
        entry.name,
        entry.track_ids.len()
    );
    let mut buf = header;
    for (i, tid) in entry.track_ids.iter().enumerate() {
        let line = match lib.tracks.get(tid) {
            Some(t) => render_track(i + 1, t),
            None => format!("{}. (track id {} not in collection)\n\n", i + 1, tid),
        };
        buf.push_str(&line);
    }
    chunk(buf, 3500)
}

fn render_track(idx: usize, t: &Track) -> String {
    let title_line = if t.artist.trim().is_empty() {
        if t.name.trim().is_empty() {
            "(untitled)".to_string()
        } else {
            t.name.clone()
        }
    } else if t.name.trim().is_empty() {
        t.artist.clone()
    } else {
        format!("{} — {}", t.artist, t.name)
    };

    let mut tail = String::new();
    if let Some(bpm) = t.bpm {
        tail.push_str(&format!("{:.0} BPM", bpm));
    }
    if let Some(key) = &t.key {
        if !tail.is_empty() {
            tail.push_str(" · ");
        }
        tail.push_str(key);
    }

    let mut out = format!("{idx}. {}\n   {}\n", t.file_name, title_line);
    if !tail.is_empty() {
        out.push_str(&format!("   {tail}\n"));
    }
    out.push('\n');
    out
}

pub fn render_lib_stats(lib: &RekordboxLib) -> String {
    let elapsed = SystemTime::now()
        .duration_since(lib.loaded_at)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let when = if elapsed < 60 {
        format!("{}s ago", elapsed)
    } else if elapsed < 3600 {
        format!("{}m ago", elapsed / 60)
    } else {
        format!("{}h ago", elapsed / 3600)
    };
    format!(
        "{} tracks · {} playlists · {} folders\nxml: {}\nloaded {}",
        lib.tracks.len(),
        lib.flat_index.len(),
        lib.folder_count().saturating_sub(1), // subtract ROOT
        lib.xml_path.display(),
        when
    )
}

/// Split a long string into Telegram-safe chunks, breaking on newlines when possible.
fn chunk(s: String, max: usize) -> Vec<String> {
    if s.len() <= max {
        return vec![s];
    }
    let mut out = Vec::new();
    let mut buf = String::new();
    for line in s.split_inclusive('\n') {
        if buf.len() + line.len() > max && !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
        }
        // Single line longer than max — hard split.
        if line.len() > max {
            for c in line.chars().collect::<Vec<_>>().chunks(max) {
                let s: String = c.iter().collect();
                out.push(s);
            }
            continue;
        }
        buf.push_str(line);
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    let total = out.len();
    if total > 1 {
        for (i, part) in out.iter_mut().enumerate() {
            part.push_str(&format!("\n(part {}/{})", i + 1, total));
        }
    }
    out
}

// ---------- XML schema ----------

#[derive(Deserialize)]
struct DjPlaylists {
    #[serde(rename = "COLLECTION")]
    collection: CollectionXml,
    #[serde(rename = "PLAYLISTS")]
    playlists: PlaylistsXml,
}

#[derive(Deserialize)]
struct CollectionXml {
    #[serde(rename = "TRACK", default)]
    tracks: Vec<TrackXml>,
}

#[derive(Deserialize)]
struct TrackXml {
    #[serde(rename = "@TrackID")]
    track_id: String,
    #[serde(rename = "@Name", default)]
    name: String,
    #[serde(rename = "@Artist", default)]
    artist: String,
    #[serde(rename = "@AverageBpm", default)]
    average_bpm: String,
    #[serde(rename = "@Tonality", default)]
    tonality: String,
    #[serde(rename = "@Location", default)]
    location: String,
}

#[derive(Deserialize)]
struct PlaylistsXml {
    #[serde(rename = "NODE")]
    root: NodeXml,
}

#[derive(Deserialize)]
struct NodeXml {
    #[serde(rename = "@Type", default)]
    type_: u8,
    #[serde(rename = "@Name", default)]
    name: String,
    #[serde(rename = "NODE", default)]
    children: Vec<NodeXml>,
    #[serde(rename = "TRACK", default)]
    track_refs: Vec<TrackRefXml>,
}

#[derive(Deserialize)]
struct TrackRefXml {
    #[serde(rename = "@Key")]
    key: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="3">
    <TRACK TrackID="1" Name="One" Artist="A" AverageBpm="124.00" Tonality="Am"
           Location="file://localhost/tmp/one.mp3"/>
    <TRACK TrackID="2" Name="Two" Artist="B" AverageBpm="0.00" Tonality=""
           Location="file://localhost/tmp/two.mp3"/>
    <TRACK TrackID="3" Name="Three" Artist="" AverageBpm="128.00" Tonality="8B"
           Location="file://localhost/tmp/three.mp3"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="2">
      <NODE Type="0" Name="House">
        <NODE Type="1" Name="Saturday" Entries="2" KeyType="0">
          <TRACK Key="1"/>
          <TRACK Key="2"/>
        </NODE>
      </NODE>
      <NODE Type="1" Name="Wedding" Entries="1" KeyType="0">
        <TRACK Key="3"/>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>"#;

    fn write_fixture() -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(FIXTURE.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parses_tracks_and_tree() {
        let f = write_fixture();
        let lib = RekordboxLib::load(f.path()).unwrap();
        assert_eq!(lib.tracks.len(), 3);
        assert_eq!(lib.flat().len(), 2);
        assert_eq!(lib.flat()[0].name, "Saturday");
        assert_eq!(lib.flat()[0].path_segments, vec!["House"]);
        assert_eq!(lib.flat()[1].name, "Wedding");
        assert!(lib.flat()[1].path_segments.is_empty());
    }

    #[test]
    fn track_bpm_zero_becomes_none() {
        let f = write_fixture();
        let lib = RekordboxLib::load(f.path()).unwrap();
        assert!(lib.tracks.get("2").unwrap().bpm.is_none());
        assert_eq!(lib.tracks.get("1").unwrap().bpm, Some(124.0));
    }

    #[test]
    fn track_empty_tonality_becomes_none() {
        let f = write_fixture();
        let lib = RekordboxLib::load(f.path()).unwrap();
        assert!(lib.tracks.get("2").unwrap().key.is_none());
        assert_eq!(lib.tracks.get("3").unwrap().key.as_deref(), Some("8B"));
    }

    #[test]
    fn lookup_by_number_and_name() {
        let f = write_fixture();
        let lib = RekordboxLib::load(f.path()).unwrap();
        assert_eq!(lib.lookup("1").unwrap().name, "Saturday");
        assert_eq!(lib.lookup("Wedding").unwrap().name, "Wedding");
        assert_eq!(lib.lookup("wedding").unwrap().name, "Wedding");
        assert!(lib.lookup("nonexistent").is_none());
    }

    #[test]
    fn renders_listing_with_folders() {
        let f = write_fixture();
        let lib = RekordboxLib::load(f.path()).unwrap();
        let chunks = render_playlists_listing(&lib);
        let combined = chunks.join("");
        assert!(combined.contains("House/"));
        assert!(combined.contains("1. Saturday"));
        assert!(combined.contains("2. Wedding"));
    }

    #[test]
    fn renders_playlist_tracks() {
        let f = write_fixture();
        let lib = RekordboxLib::load(f.path()).unwrap();
        let entry = lib.lookup("1").unwrap().clone();
        let chunks = render_playlist(&lib, &entry);
        let s = chunks.join("");
        assert!(s.contains("Saturday"));
        assert!(s.contains("A — One"));
        assert!(s.contains("124 BPM · Am"));
        assert!(s.contains("B — Two"));
    }
}
