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
/// Only `https` links to Spotify tracks/albums/playlists, YouTube
/// videos/playlists and SoundCloud tracks/sets are accepted. Rebuilding
/// (rather than passing the input through) drops tracking params and
/// `&list=RD…` "Mix" playlists, and means the argv we hand to spotdl / yt-dlp
/// always starts with `https://`.
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
        "soundcloud.com" | "www.soundcloud.com" | "m.soundcloud.com" => {
            soundcloud_ref(&segs, &url, input)
        }
        "on.soundcloud.com" => Err(
            "SoundCloud share links can't be checked; open the link and send the full soundcloud.com address"
                .into(),
        ),
        _ => Err(format!(
            "unsupported site {host:?}: send a Spotify, YouTube or SoundCloud link"
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

/// SoundCloud artist/track/set slugs: the URL-safe words its paths are built
/// from. Case is kept — the link is passed to yt-dlp as shared.
fn is_soundcloud_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Profile tabs that share the `/artist/<word>` shape with tracks.
fn is_soundcloud_tab(s: &str) -> bool {
    matches!(
        s,
        "sets"
            | "tracks"
            | "albums"
            | "likes"
            | "spotlight"
            | "reposts"
            | "followers"
            | "following"
            | "stats"
            | "playlists"
            | "groups"
            | "posts"
            | "permalink"
    )
}

/// SoundCloud track and set links: `/artist/track` or `/artist/sets/set-name`.
/// A trailing `/s-<token>` segment or `?secret_token=` param unlocks a private
/// track — kept either way, since the link is useless without its secret.
fn soundcloud_ref(segs: &[&str], url: &url::Url, input: &str) -> Result<MediaRef, String> {
    // A token is only ever a third-or-later segment: `artist/s-foo` is a track
    // whose slug happens to start with "s-".
    let has_token = match segs {
        [rest @ .., last] => {
            rest.len() >= 2 && last.len() > 2 && last.starts_with("s-") && is_soundcloud_slug(last)
        }
        _ => false,
    };
    let path_segs = if has_token {
        &segs[..segs.len() - 1]
    } else {
        segs
    };
    match path_segs {
        [artist, track]
            if !is_soundcloud_tab(track)
                && is_soundcloud_slug(artist)
                && is_soundcloud_slug(track) => {}
        [artist, "sets", set] if is_soundcloud_slug(artist) && is_soundcloud_slug(set) => {}
        _ => return Err(format!("not a SoundCloud track or set link: {input}")),
    }
    let mut out = url::Url::parse("https://soundcloud.com/").expect("static base");
    out.set_path(&segs.join("/"));
    if !has_token {
        if let Some((_, v)) = url.query_pairs().find(|(k, _)| k == "secret_token") {
            out.query_pairs_mut().append_pair("secret_token", &v);
        }
    }
    Ok(MediaRef::SoundCloud(out))
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
    fn media_ref_canonicalises_soundcloud_links() {
        assert_eq!(
            ok("https://soundcloud.com/artist/some-track?si=abc"),
            "https://soundcloud.com/artist/some-track"
        );
        assert_eq!(
            ok("https://www.soundcloud.com/artist/some-track"),
            "https://soundcloud.com/artist/some-track"
        );
        assert_eq!(
            ok("https://m.soundcloud.com/artist/sets/warehouse-march"),
            "https://soundcloud.com/artist/sets/warehouse-march"
        );
        assert!(matches!(
            extract_media_ref("https://soundcloud.com/artist/some-track").unwrap(),
            MediaRef::SoundCloud(_)
        ));
    }

    #[test]
    fn soundcloud_private_tracks_keep_their_secret() {
        // Either secret form rides along: without it the link is useless.
        assert_eq!(
            ok("https://soundcloud.com/artist/some-track/s-Ab12Cd34"),
            "https://soundcloud.com/artist/some-track/s-Ab12Cd34"
        );
        assert_eq!(
            ok("https://soundcloud.com/artist/some-track?secret_token=s-Ab12Cd34"),
            "https://soundcloud.com/artist/some-track?secret_token=s-Ab12Cd34"
        );
        // …and a track whose slug starts with "s-" isn't mistaken for a token.
        assert_eq!(
            ok("https://soundcloud.com/artist/s-wave"),
            "https://soundcloud.com/artist/s-wave"
        );
    }

    #[test]
    fn soundcloud_rejects_non_track_pages() {
        for bad in [
            "https://soundcloud.com/artist",
            "https://soundcloud.com/artist/sets",
            "https://soundcloud.com/artist/sets/",
            "https://soundcloud.com/discover/sets/charts-top:all-music",
            "https://soundcloud.com/artist/tracks",
            "https://soundcloud.com/artist/abc;rm",
            "https://on.soundcloud.com/xYz12",
        ] {
            assert!(extract_media_ref(bad).is_err(), "should reject {bad}");
        }
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
