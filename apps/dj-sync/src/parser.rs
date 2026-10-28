use once_cell::sync::Lazy;
use regex::Regex;

use crate::MediaRef;

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

static SPOTIFY_URI: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"spotify:(playlist|album|track):([A-Za-z0-9]+)").expect("static regex")
});

pub fn extract_spotify_ref(text: &str) -> Option<SpotifyRef> {
    if let Some(caps) = SPOTIFY_URL
        .captures(text)
        .or_else(|| SPOTIFY_URI.captures(text))
    {
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

/// Validate a link for the download lane and rebuild it in canonical form.
///
/// Only `https` links to Spotify tracks/albums/playlists and YouTube
/// videos/playlists are accepted. Rebuilding (rather than passing the input
/// through) drops tracking params and `&list=RD…` "Mix" playlists, and means
/// the argv we hand to spotdl / yt-dlp always starts with `https://`.
pub fn extract_media_ref(input: &str) -> Result<MediaRef, String> {
    let input = input.trim();
    if let Some(rest) = input.strip_prefix("spotify:") {
        let (kind, id) = rest
            .split_once(':')
            .ok_or_else(|| format!("unrecognised Spotify URI: {input}"))?;
        return spotify_ref(kind, id);
    }

    let url = url::Url::parse(input).map_err(|_| format!("not a URL: {input}"))?;
    if url.scheme() != "https" {
        return Err(format!("only https links are accepted: {input}"));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let segs: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();
    let query = |k: &str| {
        url.query_pairs()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.into_owned())
    };

    match host.as_str() {
        "open.spotify.com" => {
            // Optional locale prefix: /intl-fr/track/<id>
            let segs = match segs.first() {
                Some(s) if s.starts_with("intl-") => &segs[1..],
                _ => &segs[..],
            };
            match segs {
                [kind, id, ..] => spotify_ref(kind, id),
                _ => Err(format!(
                    "not a Spotify track, album or playlist link: {input}"
                )),
            }
        }
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            match segs.as_slice() {
                ["watch"] => youtube_video(&query("v").unwrap_or_default(), input),
                ["shorts", id] | ["live", id] => youtube_video(id, input),
                ["playlist"] => youtube_playlist(&query("list").unwrap_or_default(), input),
                _ => Err(format!("not a YouTube video or playlist link: {input}")),
            }
        }
        "youtu.be" => match segs.as_slice() {
            [id] => youtube_video(id, input),
            _ => Err(format!("not a YouTube video link: {input}")),
        },
        _ => Err(format!(
            "unsupported site {host:?}: send a Spotify or YouTube link"
        )),
    }
}

fn spotify_ref(kind: &str, id: &str) -> Result<MediaRef, String> {
    if !matches!(kind, "track" | "album" | "playlist") {
        return Err(format!(
            "Spotify {kind} links aren't supported; send a track, album or playlist"
        ));
    }
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(format!("invalid Spotify {kind} id: {id:?}"));
    }
    let url = url::Url::parse(&format!("https://open.spotify.com/{kind}/{id}"))
        .map_err(|e| e.to_string())?;
    Ok(MediaRef::Spotify(url))
}

fn is_youtube_id(id: &str, len: std::ops::RangeInclusive<usize>) -> bool {
    len.contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn youtube_video(id: &str, input: &str) -> Result<MediaRef, String> {
    // Video ids are always 11 chars of [A-Za-z0-9_-] (and may start with '-').
    if !is_youtube_id(id, 11..=11) {
        return Err(format!("no valid YouTube video id in {input}"));
    }
    let url = url::Url::parse(&format!("https://www.youtube.com/watch?v={id}"))
        .map_err(|e| e.to_string())?;
    Ok(MediaRef::YouTube(url))
}

fn youtube_playlist(list: &str, input: &str) -> Result<MediaRef, String> {
    if !is_youtube_id(list, 2..=64) {
        return Err(format!("no valid YouTube playlist id in {input}"));
    }
    if list.starts_with("RD") {
        // Auto-generated "Mix" playlists never end.
        return Err("YouTube Mix playlists aren't supported; send the video link".into());
    }
    let url = url::Url::parse(&format!("https://www.youtube.com/playlist?list={list}"))
        .map_err(|e| e.to_string())?;
    Ok(MediaRef::YouTube(url))
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

    fn ok(input: &str) -> String {
        extract_media_ref(input)
            .unwrap_or_else(|e| panic!("{input}: {e}"))
            .url()
            .to_string()
    }

    #[test]
    fn media_ref_canonicalises_spotify_links() {
        assert_eq!(
            ok("https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC?si=abc"),
            "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
        );
        assert_eq!(
            ok(" spotify:playlist:37i9dQZF1DXcBWIGoYBM5M "),
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
        );
        assert!(matches!(
            extract_media_ref("https://open.spotify.com/album/abc123").unwrap(),
            MediaRef::Spotify(_)
        ));
    }

    #[test]
    fn media_ref_canonicalises_youtube_links_and_drops_mix_lists() {
        let want = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        assert_eq!(
            ok("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&t=42"),
            want
        );
        assert_eq!(ok("https://youtu.be/dQw4w9WgXcQ?si=x"), want);
        assert_eq!(ok("https://m.youtube.com/watch?v=dQw4w9WgXcQ"), want);
        assert_eq!(
            ok("https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share"),
            want
        );
        assert_eq!(ok("https://www.youtube.com/shorts/dQw4w9WgXcQ"), want);
        assert_eq!(
            ok("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"),
            "https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
        );
    }

    #[test]
    fn media_ref_rejects_everything_else() {
        for bad in [
            "http://open.spotify.com/track/abc",
            "https://open.spotify.com/artist/abc",
            "https://open.spotify.com/track/abc;rm",
            "https://evil.example/watch?v=dQw4w9WgXcQ",
            "https://open.spotify.com.evil.example/track/abc",
            "https://www.youtube.com/watch",
            "https://www.youtube.com/watch?v=--exec",
            "https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ",
            "https://www.youtube.com/@channel",
            "--exec=rm -rf ~",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(extract_media_ref(bad).is_err(), "should reject {bad}");
        }
    }
}
