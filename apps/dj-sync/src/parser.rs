use once_cell::sync::Lazy;
use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpotifyKind {
    Playlist,
    Album,
    Track,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpotifyRef {
    pub kind: SpotifyKind,
    pub id: String,
}

static SPOTIFY_URL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"https?://open\.spotify\.com/(?:intl-[a-z]+/)?(playlist|album|track)/([A-Za-z0-9]+)",
    )
    .expect("static regex")
});

static SPOTIFY_URI: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"spotify:(playlist|album|track):([A-Za-z0-9]+)").expect("static regex"));

pub fn extract_spotify_ref(text: &str) -> Option<SpotifyRef> {
    if let Some(caps) = SPOTIFY_URL.captures(text).or_else(|| SPOTIFY_URI.captures(text)) {
        let kind = match &caps[1] {
            "playlist" => SpotifyKind::Playlist,
            "album" => SpotifyKind::Album,
            "track" => SpotifyKind::Track,
            _ => return None,
        };
        return Some(SpotifyRef {
            kind,
            id: caps[2].to_string(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_spotify_playlist_url() {
        let r = extract_spotify_ref("sync this https://open.spotify.com/playlist/37i9dQZF1DX?si=x")
            .unwrap();
        assert_eq!(r.kind, SpotifyKind::Playlist);
        assert_eq!(r.id, "37i9dQZF1DX");
    }

    #[test]
    fn parses_intl_prefix() {
        let r = extract_spotify_ref("https://open.spotify.com/intl-fr/album/4abc").unwrap();
        assert_eq!(r.kind, SpotifyKind::Album);
        assert_eq!(r.id, "4abc");
    }

    #[test]
    fn parses_spotify_uri() {
        let r = extract_spotify_ref("spotify:track:abc123").unwrap();
        assert_eq!(r.kind, SpotifyKind::Track);
        assert_eq!(r.id, "abc123");
    }

    #[test]
    fn ignores_non_spotify_text() {
        assert!(extract_spotify_ref("hello world").is_none());
    }
}
