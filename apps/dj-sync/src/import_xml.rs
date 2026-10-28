//! The Rekordbox XML file the download lane writes (`~/Music/rekordbox_import.xml`),
//! which Rekordbox reads through Preferences → Advanced → Database →
//! rekordbox xml → Imported Library.
//!
//! dj-sync owns this file: every write is a read-modify-write that keeps
//! existing tracks and playlists, but attributes we don't model are dropped.
//! Don't point this at Rekordbox's own collection export.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::{location_path, location_uri, TrackMeta};

const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
/// `PRODUCT Name` of files dj-sync created itself.
const PRODUCT_NAME: &str = "dj-sync";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename = "DJ_PLAYLISTS")]
struct DjPlaylists {
    #[serde(rename = "@Version")]
    version: String,
    #[serde(rename = "PRODUCT")]
    product: Product,
    #[serde(rename = "COLLECTION")]
    collection: Collection,
    #[serde(rename = "PLAYLISTS")]
    playlists: Playlists,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Product {
    #[serde(rename = "@Name")]
    name: String,
    #[serde(rename = "@Version")]
    version: String,
    #[serde(rename = "@Company")]
    company: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Collection {
    #[serde(rename = "@Entries")]
    entries: usize,
    #[serde(rename = "TRACK", default)]
    tracks: Vec<CollectionTrack>,
}

/// Same attribute set (and order) Rekordbox 7 writes in its own exports.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct CollectionTrack {
    #[serde(rename = "@TrackID")]
    track_id: String,
    #[serde(rename = "@Name")]
    name: String,
    #[serde(rename = "@Artist")]
    artist: String,
    #[serde(rename = "@Composer")]
    composer: String,
    #[serde(rename = "@Album")]
    album: String,
    #[serde(rename = "@Grouping")]
    grouping: String,
    #[serde(rename = "@Genre")]
    genre: String,
    #[serde(rename = "@Kind")]
    kind: String,
    #[serde(rename = "@Size")]
    size: String,
    #[serde(rename = "@TotalTime")]
    total_time: String,
    #[serde(rename = "@DiscNumber")]
    disc_number: String,
    #[serde(rename = "@TrackNumber")]
    track_number: String,
    #[serde(rename = "@Year")]
    year: String,
    #[serde(rename = "@AverageBpm")]
    average_bpm: String,
    #[serde(rename = "@DateAdded")]
    date_added: String,
    #[serde(rename = "@BitRate")]
    bit_rate: String,
    #[serde(rename = "@SampleRate")]
    sample_rate: String,
    #[serde(rename = "@Comments")]
    comments: String,
    #[serde(rename = "@PlayCount")]
    play_count: String,
    #[serde(rename = "@Rating")]
    rating: String,
    #[serde(rename = "@Location")]
    location: String,
    #[serde(rename = "@Remixer")]
    remixer: String,
    #[serde(rename = "@Tonality")]
    tonality: String,
    #[serde(rename = "@Label")]
    label: String,
    #[serde(rename = "@Mix")]
    mix: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Playlists {
    #[serde(rename = "NODE")]
    root: Node,
}

/// `Type="0"` is a folder (has `Count` + child NODEs), `Type="1"` a playlist
/// (has `KeyType` + `Entries` + TRACK refs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Node {
    #[serde(rename = "@Type")]
    node_type: u8,
    #[serde(rename = "@Name")]
    name: String,
    #[serde(rename = "@Count", default, skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
    #[serde(rename = "@KeyType", default, skip_serializing_if = "Option::is_none")]
    key_type: Option<u8>,
    #[serde(rename = "@Entries", default, skip_serializing_if = "Option::is_none")]
    entries: Option<usize>,
    #[serde(rename = "NODE", default, skip_serializing_if = "Vec::is_empty")]
    children: Vec<Node>,
    #[serde(rename = "TRACK", default, skip_serializing_if = "Vec::is_empty")]
    tracks: Vec<TrackRef>,
}

/// With `KeyType="0"`, `Key` is a COLLECTION `TrackID`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct TrackRef {
    #[serde(rename = "@Key")]
    key: String,
}

const FOLDER: u8 = 0;
const PLAYLIST: u8 = 1;

#[derive(Debug, Clone, PartialEq)]
pub struct ImportDoc {
    doc: DjPlaylists,
}

impl Default for ImportDoc {
    fn default() -> Self {
        Self::new()
    }
}

impl ImportDoc {
    pub fn new() -> Self {
        Self {
            doc: DjPlaylists {
                version: "1.0.0".into(),
                product: Product {
                    name: PRODUCT_NAME.into(),
                    version: env!("CARGO_PKG_VERSION").into(),
                    company: "dj-sync".into(),
                },
                collection: Collection {
                    entries: 0,
                    tracks: Vec::new(),
                },
                playlists: Playlists {
                    root: Node {
                        node_type: FOLDER,
                        name: "ROOT".into(),
                        count: Some(0),
                        key_type: None,
                        entries: None,
                        children: Vec::new(),
                        tracks: Vec::new(),
                    },
                },
            },
        }
    }

    /// Load the existing file, or start empty if it doesn't exist (or is
    /// blank). A file that exists but doesn't parse is an error — we never
    /// overwrite something we can't read.
    pub fn load_or_new(path: &Path) -> anyhow::Result<Self> {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::new()),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        if raw.trim().is_empty() {
            return Ok(Self::new());
        }
        Self::parse(&raw).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn parse(xml: &str) -> anyhow::Result<Self> {
        let doc: DjPlaylists = quick_xml::de::from_str(xml)?;
        Ok(Self { doc })
    }

    pub fn to_xml(&self) -> anyhow::Result<String> {
        let mut body = String::new();
        let mut ser = quick_xml::se::Serializer::new(&mut body);
        ser.indent(' ', 2);
        self.doc
            .serialize(ser)
            .context("serializing rekordbox xml")?;
        Ok(format!("{XML_DECL}{body}\n"))
    }

    /// If `path` holds a file dj-sync didn't create (e.g. something Rekordbox's
    /// Imported Library already pointed at), copy it once to
    /// `<name>.pre-dj-sync.bak` before we ever rewrite it. Returns the backup
    /// path when one was made. An existing backup is never overwritten, so it
    /// always holds the true original.
    pub fn backup_foreign(path: &Path) -> anyhow::Result<Option<PathBuf>> {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        if raw.trim().is_empty() {
            return Ok(None);
        }
        let ours = Self::parse(&raw).is_ok_and(|d| d.doc.product.name == PRODUCT_NAME);
        let backup = path.with_extension("xml.pre-dj-sync.bak");
        if ours || backup.exists() {
            return Ok(None);
        }
        std::fs::copy(path, &backup)
            .with_context(|| format!("backing up {} -> {}", path.display(), backup.display()))?;
        Ok(Some(backup))
    }

    /// Write via a temp file + rename so Rekordbox never sees a half-written
    /// file; the previous version is kept as `<name>.bak`.
    pub fn save_atomic(&self, path: &Path) -> anyhow::Result<()> {
        let xml = self.to_xml()?;
        if path.exists() {
            std::fs::copy(path, path.with_extension("xml.bak"))
                .with_context(|| format!("backing up {}", path.display()))?;
        }
        let tmp = path.with_extension("xml.tmp");
        std::fs::write(&tmp, xml).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, path)
            .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }

    /// Add `meta` to the COLLECTION unless a track with the same file is
    /// already there. Returns the TrackID either way.
    pub fn upsert_track(&mut self, meta: &TrackMeta, date_added: &str, comment: &str) -> String {
        let tracks = &mut self.doc.collection.tracks;
        if let Some(existing) = tracks
            .iter()
            .find(|t| location_path(&t.location) == meta.path)
        {
            return existing.track_id.clone();
        }

        let next_id = tracks
            .iter()
            .filter_map(|t| t.track_id.parse::<u64>().ok())
            .max()
            .unwrap_or(0)
            + 1;
        let name = if meta.title.trim().is_empty() {
            meta.path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string()
        } else {
            meta.title.clone()
        };

        tracks.push(CollectionTrack {
            track_id: next_id.to_string(),
            name,
            artist: meta.artist.clone(),
            album: meta.album.clone(),
            genre: meta.genre.clone(),
            kind: meta.kind.clone(),
            size: meta.size_bytes.to_string(),
            total_time: ((meta.duration_ms + 500) / 1000).to_string(),
            disc_number: "0".into(),
            track_number: "0".into(),
            year: meta.year.unwrap_or(0).to_string(),
            average_bpm: "0.00".into(),
            date_added: date_added.into(),
            bit_rate: meta.bitrate_kbps.unwrap_or(0).to_string(),
            sample_rate: meta.sample_rate.unwrap_or(0).to_string(),
            comments: comment.into(),
            play_count: "0".into(),
            rating: "0".into(),
            location: location_uri(&meta.path),
            ..CollectionTrack::default()
        });
        self.doc.collection.entries = tracks.len();
        next_id.to_string()
    }

    /// Find or create a top-level playlist called `name` and append the given
    /// TrackIDs it doesn't already contain. Returns how many were appended.
    pub fn upsert_playlist(&mut self, name: &str, track_ids: &[String]) -> usize {
        let root = &mut self.doc.playlists.root;
        let idx = match root
            .children
            .iter()
            .position(|n| n.node_type == PLAYLIST && n.name == name)
        {
            Some(i) => i,
            None => {
                root.children.push(Node {
                    node_type: PLAYLIST,
                    name: name.into(),
                    count: None,
                    key_type: Some(0),
                    entries: Some(0),
                    children: Vec::new(),
                    tracks: Vec::new(),
                });
                root.children.len() - 1
            }
        };
        root.count = Some(root.children.len());

        let playlist = &mut root.children[idx];
        let mut added = 0;
        for id in track_ids {
            if !playlist.tracks.iter().any(|t| &t.key == id) {
                playlist.tracks.push(TrackRef { key: id.clone() });
                added += 1;
            }
        }
        playlist.entries = Some(playlist.tracks.len());
        added
    }

    pub fn track_count(&self) -> usize {
        self.doc.collection.tracks.len()
    }

    pub fn playlist_len(&self, name: &str) -> Option<usize> {
        self.doc
            .playlists
            .root
            .children
            .iter()
            .find(|n| n.node_type == PLAYLIST && n.name == name)
            .map(|n| n.tracks.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rekordbox_xml::RekordboxLib;
    use std::path::PathBuf;

    fn meta(path: &str, title: &str, artist: &str) -> TrackMeta {
        TrackMeta {
            path: PathBuf::from(path),
            title: title.into(),
            artist: artist.into(),
            album: "Alb".into(),
            genre: "Amapiano".into(),
            year: Some(2024),
            duration_ms: 215_600,
            bitrate_kbps: Some(320),
            sample_rate: Some(44_100),
            size_bytes: 8_765_432,
            kind: "MP3 File".into(),
            ..TrackMeta::default()
        }
    }

    #[test]
    fn new_doc_serialises_with_declaration_and_empty_root() {
        let xml = ImportDoc::new().to_xml().unwrap();
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DJ_PLAYLISTS"));
        assert!(xml.contains(r#"<COLLECTION Entries="0"/>"#), "{xml}");
        assert!(
            xml.contains(r#"<NODE Type="0" Name="ROOT" Count="0"/>"#),
            "{xml}"
        );
        // And it parses back.
        assert_eq!(ImportDoc::parse(&xml).unwrap(), ImportDoc::new());
    }

    #[test]
    fn upsert_writes_rekordbox_shaped_track_and_playlist() {
        let mut doc = ImportDoc::new();
        let id = doc.upsert_track(
            &meta(
                "/Users/dj/Music/DJ_Downloads/A & B - Don't Stop [Mix].mp3",
                "Don't Stop",
                "A & B",
            ),
            "2026-10-28",
            "https://open.spotify.com/track/x",
        );
        assert_eq!(id, "1");
        assert_eq!(doc.upsert_playlist("Friday", std::slice::from_ref(&id)), 1);

        let xml = doc.to_xml().unwrap();
        assert!(
            xml.contains(r#"TrackID="1" Name="Don&apos;t Stop" Artist="A &amp; B""#),
            "{xml}"
        );
        assert!(
            xml.contains(r#"Kind="MP3 File" Size="8765432" TotalTime="216""#),
            "{xml}"
        );
        assert!(xml.contains(r#"Year="2024" AverageBpm="0.00" DateAdded="2026-10-28" BitRate="320" SampleRate="44100""#), "{xml}");
        assert!(xml.contains(
            r#"Location="file://localhost/Users/dj/Music/DJ_Downloads/A%20%26%20B%20-%20Don%27t%20Stop%20%5bMix%5d.mp3""#
        ), "{xml}");
        assert!(
            xml.contains(r#"<NODE Type="0" Name="ROOT" Count="1">"#),
            "{xml}"
        );
        assert!(
            xml.contains(r#"<NODE Type="1" Name="Friday" KeyType="0" Entries="1">"#),
            "{xml}"
        );
        assert!(xml.contains(r#"<TRACK Key="1"/>"#), "{xml}");
    }

    #[test]
    fn reload_and_append_preserves_existing_tracks_and_playlists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rekordbox_import.xml");

        let mut doc = ImportDoc::load_or_new(&path).unwrap();
        let a = doc.upsert_track(&meta("/m/a.mp3", "A", "X"), "2026-10-27", "");
        let b = doc.upsert_track(&meta("/m/b.mp3", "B", "X"), "2026-10-27", "");
        doc.upsert_playlist("Thursday", &[a.clone(), b.clone()]);
        doc.save_atomic(&path).unwrap();
        assert!(!dir.path().join("rekordbox_import.xml.tmp").exists());

        let mut doc = ImportDoc::load_or_new(&path).unwrap();
        let b_again =
            doc.upsert_track(&meta("/m/b.mp3", "B (changed tags)", "X"), "2026-10-28", "");
        let c = doc.upsert_track(&meta("/m/c.mp3", "C", "Y"), "2026-10-28", "");
        assert_eq!(b_again, b, "same file keeps its TrackID");
        assert_eq!(c, "3");
        assert_eq!(doc.upsert_playlist("Thursday", &[b.clone(), c.clone()]), 1);
        doc.upsert_playlist("Friday", std::slice::from_ref(&c));
        doc.save_atomic(&path).unwrap();
        assert!(dir.path().join("rekordbox_import.xml.bak").exists());

        let doc = ImportDoc::load_or_new(&path).unwrap();
        assert_eq!(doc.track_count(), 3);
        assert_eq!(doc.playlist_len("Thursday"), Some(3));
        assert_eq!(doc.playlist_len("Friday"), Some(1));

        // The existing read-only parser (used by the Telegram browser) agrees.
        let lib = RekordboxLib::load(&path).unwrap();
        assert_eq!(lib.tracks.len(), 3);
        assert_eq!(lib.flat().len(), 2);
        assert_eq!(
            lib.lookup("Thursday").unwrap().track_ids,
            vec!["1", "2", "3"]
        );
        assert_eq!(lib.tracks["2"].name, "B", "existing track not rewritten");
        assert_eq!(lib.tracks["3"].path, PathBuf::from("/m/c.mp3"));
    }

    #[test]
    fn dedupe_matches_on_decoded_path_not_encoding_case() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.11" Company="AlphaTheta"/>
  <COLLECTION Entries="1">
    <TRACK TrackID="69735716" Name="Âme" Location="file://localhost/m/%C3%82me%20x.mp3"/>
  </COLLECTION>
  <PLAYLISTS><NODE Type="0" Name="ROOT" Count="0"/></PLAYLISTS>
</DJ_PLAYLISTS>"#;
        let mut doc = ImportDoc::parse(xml).unwrap();
        let id = doc.upsert_track(&meta("/m/Âme x.mp3", "Âme", ""), "2026-10-28", "");
        assert_eq!(id, "69735716");
        assert_eq!(doc.track_count(), 1);
        // New ids continue after the largest existing one.
        assert_eq!(
            doc.upsert_track(&meta("/m/new.mp3", "N", ""), "d", ""),
            "69735717"
        );
    }

    #[test]
    fn untitled_track_falls_back_to_file_stem() {
        let mut doc = ImportDoc::new();
        doc.upsert_track(
            &meta("/m/Some Upload (Official Audio).mp3", "  ", ""),
            "d",
            "",
        );
        let xml = doc.to_xml().unwrap();
        assert!(
            xml.contains(r#"Name="Some Upload (Official Audio)""#),
            "{xml}"
        );
    }

    #[test]
    fn foreign_file_is_backed_up_once_and_ours_never() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rekordbox.xml");
        let backup = dir.path().join("rekordbox.xml.pre-dj-sync.bak");

        assert_eq!(
            ImportDoc::backup_foreign(&path).unwrap(),
            None,
            "missing file"
        );

        let original = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.11" Company="AlphaTheta"/>
  <COLLECTION Entries="1">
    <TRACK TrackID="9" Name="Old" Location="file://localhost/m/old.mp3"/>
  </COLLECTION>
  <PLAYLISTS><NODE Type="0" Name="ROOT" Count="1">
    <NODE Name="Mine" Type="1" KeyType="0" Entries="1"><TRACK Key="9"/></NODE>
  </NODE></PLAYLISTS>
</DJ_PLAYLISTS>"#;
        std::fs::write(&path, original).unwrap();
        assert_eq!(
            ImportDoc::backup_foreign(&path).unwrap(),
            Some(backup.clone())
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);

        // Later writes don't replace the original backup.
        let mut doc = ImportDoc::load_or_new(&path).unwrap();
        doc.upsert_track(&meta("/m/new.mp3", "New", ""), "d", "");
        doc.save_atomic(&path).unwrap();
        assert_eq!(ImportDoc::backup_foreign(&path).unwrap(), None);
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
        // And adopting it kept the existing track and playlist.
        let doc = ImportDoc::load_or_new(&path).unwrap();
        assert_eq!(doc.track_count(), 2);
        assert_eq!(doc.playlist_len("Mine"), Some(1));

        // A file dj-sync created is never "foreign".
        let ours = dir.path().join("ours.xml");
        ImportDoc::new().save_atomic(&ours).unwrap();
        assert_eq!(ImportDoc::backup_foreign(&ours).unwrap(), None);
        assert!(!dir.path().join("ours.xml.pre-dj-sync.bak").exists());
    }

    #[test]
    fn unreadable_existing_file_is_an_error_not_a_reset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.xml");
        std::fs::write(&path, "<not-rekordbox/>").unwrap();
        assert!(ImportDoc::load_or_new(&path).is_err());
        std::fs::write(&path, "  \n").unwrap();
        assert_eq!(ImportDoc::load_or_new(&path).unwrap(), ImportDoc::new());
    }
}
