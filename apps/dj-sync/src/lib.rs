pub mod agent_core;
pub mod ai_assist;
pub mod bot;
pub mod cloud;
pub mod cloud_v2;
pub mod config;
pub mod downloader;
pub mod http;
pub mod import_xml;
pub mod jobs;
pub mod library;
pub mod matcher;
pub mod mcp;
pub mod nlu;
pub mod parser;
pub mod rekordbox;
pub mod rekordbox_db;
pub mod rekordbox_xml;
pub mod settings;
pub mod shortcut;
pub mod signing;
pub mod spotify;
pub mod toolbox;
pub mod uninstall;
pub mod usb;
pub mod xml_versions;

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct SpotifyTrack {
    pub spotify_id: String,
    pub isrc: Option<String>,
    pub artist: String,
    pub title: String,
    pub album: String,
    pub duration_ms: u32,
}

#[derive(Debug, Clone)]
pub struct LocalTrack {
    pub path: PathBuf,
    pub isrc: Option<String>,
    pub artist: String,
    pub title: String,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    Isrc,
    FuzzyHigh,
    FuzzyLow,
    AiAssisted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissReason {
    NotInLibrary,
    AmbiguousFuzzy,
    AiUncertain,
}

#[derive(Debug, Clone)]
pub enum MatchResult {
    Hit {
        spotify: SpotifyTrack,
        local: LocalTrack,
        confidence: Confidence,
    },
    Miss {
        spotify: SpotifyTrack,
        reason: MissReason,
    },
}

impl MatchResult {
    pub fn spotify(&self) -> &SpotifyTrack {
        match self {
            MatchResult::Hit { spotify, .. } | MatchResult::Miss { spotify, .. } => spotify,
        }
    }
}

/// A link the download lane knows how to fetch audio for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaRef {
    Spotify(url::Url),
    YouTube(url::Url),
    SoundCloud(url::Url),
}

impl MediaRef {
    pub fn url(&self) -> &url::Url {
        match self {
            MediaRef::Spotify(u) | MediaRef::YouTube(u) | MediaRef::SoundCloud(u) => u,
        }
    }

    pub fn source(&self) -> &'static str {
        match self {
            MediaRef::Spotify(_) => "spotify",
            MediaRef::YouTube(_) => "youtube",
            MediaRef::SoundCloud(_) => "soundcloud",
        }
    }
}

/// Tags + file properties of one audio file, in the shape Rekordbox's XML wants.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TrackMeta {
    pub path: PathBuf,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub year: Option<u32>,
    pub isrc: Option<String>,
    pub duration_ms: u32,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate: Option<u32>,
    pub size_bytes: u64,
    /// Rekordbox `Kind`, e.g. "MP3 File".
    pub kind: String,
}

// ---------- Rekordbox Location URIs ----------
//
// Rekordbox writes `Location` as `file://localhost/<path>` with a narrower
// encode set than RFC 3986: in a real 7.2.11 export only space, `"`, `%`,
// `&`, `'`, `[`, `]` and non-ASCII bytes are escaped (lowercase hex), while
// `! # $ ( ) * + , : ; = ? @` stay raw. We mirror that, and additionally
// escape the few characters that are never safe in a URI.

const LOCATION_PREFIX: &str = "file://localhost";

fn location_needs_escape(b: u8) -> bool {
    !b.is_ascii()
        || b.is_ascii_control()
        || matches!(
            b,
            b' ' | b'"'
                | b'%'
                | b'&'
                | b'\''
                | b'<'
                | b'>'
                | b'['
                | b'\\'
                | b']'
                | b'^'
                | b'`'
                | b'{'
                | b'|'
                | b'}'
        )
}

/// Encode a local file path the way Rekordbox's XML `Location` attribute expects.
pub fn location_uri(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    let raw = raw.replace('\\', "/");

    let mut out = String::with_capacity(LOCATION_PREFIX.len() + raw.len() + 1);
    out.push_str(LOCATION_PREFIX);
    if !raw.starts_with('/') {
        // Windows drive paths: file://localhost/C:/...
        out.push('/');
    }
    for b in raw.bytes() {
        if location_needs_escape(b) {
            out.push_str(&format!("%{b:02x}"));
        } else {
            out.push(b as char);
        }
    }
    out
}

/// Decode a Rekordbox `Location` back into a local path. `?` and `#` are part
/// of the file name here, so this must not go through a general URL parser.
pub fn location_path(loc: &str) -> PathBuf {
    let rest = match loc.get(..LOCATION_PREFIX.len()) {
        Some(p) if p.eq_ignore_ascii_case(LOCATION_PREFIX) => &loc[LOCATION_PREFIX.len()..],
        _ => match loc.get(..7) {
            Some(p) if p.eq_ignore_ascii_case("file://") => &loc[7..],
            _ => return PathBuf::from(loc),
        },
    };
    let decoded = percent_encoding::percent_decode_str(rest).decode_utf8_lossy();
    #[cfg(windows)]
    {
        // "/C:/Users/..." -> "C:/Users/..."
        let b = decoded.as_bytes();
        if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
            return PathBuf::from(&decoded[1..]);
        }
    }
    PathBuf::from(decoded.into_owned())
}

/// `dir/name.ext` if free, else the first free `dir/name (n).ext`.
pub fn unique_name(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track");
    let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("");
    for n in 1..1000 {
        let candidate = if ext.is_empty() {
            parent.join(format!("{stem} ({n})"))
        } else {
            parent.join(format!("{stem} ({n}).{ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}-{}.{}", std::process::id(), ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shapes taken from a real Rekordbox 7.2.11 export (names changed).
    const CASES: &[(&str, &str)] = &[
        (
            "/Users/dj/Music/Jazz NXT/Ransome, Pt. 1.mp3",
            "file://localhost/Users/dj/Music/Jazz%20NXT/Ransome,%20Pt.%201.mp3",
        ),
        (
            "/Users/dj/Music/Mix 2023🔥/Do You Mind?.mp3",
            "file://localhost/Users/dj/Music/Mix%202023%f0%9f%94%a5/Do%20You%20Mind?.mp3",
        ),
        (
            "/Users/dj/Music/Afro/Âme - Don't Wait [SUPPORTED] (feat. A & B).mp3",
            "file://localhost/Users/dj/Music/Afro/%c3%82me%20-%20Don%27t%20Wait%20%5bSUPPORTED%5d%20(feat.%20A%20%26%20B).mp3",
        ),
        (
            "/Users/dj/Music/odd/#1 100% \"live\" $@!;+=.mp3",
            "file://localhost/Users/dj/Music/odd/#1%20100%25%20%22live%22%20$@!;+=.mp3",
        ),
    ];

    #[cfg(unix)]
    #[test]
    fn location_uri_matches_rekordbox_export() {
        for (path, uri) in CASES {
            assert_eq!(location_uri(Path::new(path)), *uri, "encoding {path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn location_path_round_trips_including_query_and_fragment_chars() {
        for (path, uri) in CASES {
            assert_eq!(location_path(uri), PathBuf::from(path), "decoding {uri}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn location_path_accepts_uppercase_hex_and_bare_file_scheme() {
        assert_eq!(
            location_path("file:///Users/dj/A%20%C3%82.mp3"),
            PathBuf::from("/Users/dj/A Â.mp3")
        );
    }

    #[test]
    fn location_path_passes_through_non_file_strings() {
        assert_eq!(
            location_path("relative/x.mp3"),
            PathBuf::from("relative/x.mp3")
        );
    }

    #[test]
    fn unique_name_skips_taken_names() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.mp3");
        assert_eq!(unique_name(&target), dir.path().join("a (1).mp3"));
        std::fs::write(dir.path().join("a (1).mp3"), b"x").unwrap();
        assert_eq!(unique_name(&target), dir.path().join("a (2).mp3"));
    }
}
