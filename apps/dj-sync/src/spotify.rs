use anyhow::{anyhow, bail, Context};
use reqwest::{Client, Response};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::warn;

use crate::SpotifyTrack;

async fn ok_or_spotify_err(resp: Response, label: &str) -> anyhow::Result<Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let snippet: String = body.chars().take(300).collect();
    bail!("{label}: HTTP {status} — {snippet}");
}

#[derive(Clone)]
pub struct SpotifyClient {
    http: Client,
    client_id: String,
    client_secret: String,
    token: Arc<Mutex<Option<CachedToken>>>,
}

#[derive(Clone)]
struct CachedToken {
    access_token: String,
    expires_at: std::time::Instant,
}

impl SpotifyClient {
    pub fn from_env() -> anyhow::Result<Self> {
        let client_id =
            std::env::var("SPOTIFY_CLIENT_ID").map_err(|_| anyhow!("SPOTIFY_CLIENT_ID not set"))?;
        let client_secret = std::env::var("SPOTIFY_CLIENT_SECRET")
            .map_err(|_| anyhow!("SPOTIFY_CLIENT_SECRET not set"))?;
        Ok(Self {
            http: Client::builder()
                .user_agent("dj-sync/0.1")
                .build()
                .context("building http client")?,
            client_id,
            client_secret,
            token: Arc::new(Mutex::new(None)),
        })
    }

    async fn token(&self) -> anyhow::Result<String> {
        let mut slot = self.token.lock().await;
        if let Some(t) = slot.as_ref() {
            if t.expires_at > std::time::Instant::now() {
                return Ok(t.access_token.clone());
            }
        }

        #[derive(Deserialize)]
        struct TokenResp {
            access_token: String,
            expires_in: u64,
        }

        let raw = self
            .http
            .post("https://accounts.spotify.com/api/token")
            .basic_auth(&self.client_id, Some(&self.client_secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await
            .context("requesting spotify token")?;
        let resp: TokenResp = ok_or_spotify_err(raw, "spotify token request rejected")
            .await?
            .json()
            .await
            .context("parsing spotify token response")?;

        let cached = CachedToken {
            access_token: resp.access_token.clone(),
            expires_at: std::time::Instant::now()
                + std::time::Duration::from_secs(resp.expires_in.saturating_sub(60)),
        };
        *slot = Some(cached);
        Ok(resp.access_token)
    }

    pub async fn fetch_playlist(&self, playlist_id: &str) -> anyhow::Result<Vec<SpotifyTrack>> {
        let token = self.token().await?;
        let mut tracks = Vec::new();
        let mut url = format!(
            "https://api.spotify.com/v1/playlists/{}/tracks?limit=100&fields=items(track(id,name,duration_ms,artists(name),album(name),external_ids)),next",
            playlist_id
        );

        loop {
            let raw = self
                .http
                .get(&url)
                .bearer_auth(&token)
                .send()
                .await
                .context("fetching playlist page")?;
            let resp: PlaylistPage = ok_or_spotify_err(raw, "playlist request rejected")
                .await?
                .json()
                .await
                .context("parsing playlist page")?;

            for item in resp.items {
                if let Some(t) = item.track {
                    tracks.push(SpotifyTrack {
                        spotify_id: t.id.unwrap_or_default(),
                        isrc: t.external_ids.and_then(|e| e.isrc),
                        artist: t
                            .artists
                            .into_iter()
                            .map(|a| a.name)
                            .collect::<Vec<_>>()
                            .join(", "),
                        title: t.name,
                        album: t.album.map(|a| a.name).unwrap_or_default(),
                        duration_ms: t.duration_ms.unwrap_or(0),
                    });
                }
            }

            match resp.next {
                Some(n) => url = n,
                None => break,
            }
        }

        Ok(tracks)
    }

    pub async fn fetch_album(&self, album_id: &str) -> anyhow::Result<Vec<SpotifyTrack>> {
        let token = self.token().await?;

        // Album endpoint gives us album name + simplified tracks (no ISRC).
        let raw = self
            .http
            .get(format!("https://api.spotify.com/v1/albums/{}", album_id))
            .bearer_auth(&token)
            .send()
            .await
            .context("fetching album")?;
        let album: AlbumFull = ok_or_spotify_err(raw, "album request rejected")
            .await?
            .json()
            .await
            .context("parsing album")?;

        let album_name = album.name.clone();
        let mut tracks: Vec<SpotifyTrack> = album
            .tracks
            .items
            .into_iter()
            .map(|t| SpotifyTrack {
                spotify_id: t.id.unwrap_or_default(),
                isrc: None,
                artist: t.artists.into_iter().map(|a| a.name).collect::<Vec<_>>().join(", "),
                title: t.name,
                album: album_name.clone(),
                duration_ms: t.duration_ms.unwrap_or(0),
            })
            .collect();

        // Best-effort ISRC enrichment: Spotify restricted /v1/tracks for some new
        // apps (403). If the batch fails, drop ISRCs and let the fuzzy matcher take over.
        for chunk in tracks.chunks_mut(50) {
            let ids: String = chunk
                .iter()
                .map(|t| t.spotify_id.as_str())
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>()
                .join(",");
            if ids.is_empty() {
                continue;
            }
            let resp = self
                .http
                .get(format!(
                    "https://api.spotify.com/v1/tracks?ids={}&market=from_token",
                    ids
                ))
                .bearer_auth(&token)
                .send()
                .await;
            let parsed: Option<TracksBatch> = match resp {
                Ok(r) => match r.error_for_status() {
                    Ok(ok) => ok.json().await.ok(),
                    Err(e) => {
                        warn!(error = %e, "tracks batch rejected; continuing without ISRCs");
                        None
                    }
                },
                Err(e) => {
                    warn!(error = %e, "tracks batch network error; continuing without ISRCs");
                    None
                }
            };
            if let Some(p) = parsed {
                for (slot, full) in chunk.iter_mut().zip(p.tracks.into_iter()) {
                    if let Some(full) = full {
                        slot.isrc = full.external_ids.and_then(|e| e.isrc);
                    }
                }
            }
        }

        Ok(tracks)
    }

    pub async fn fetch_track(&self, track_id: &str) -> anyhow::Result<Vec<SpotifyTrack>> {
        let token = self.token().await?;
        let raw = self
            .http
            .get(format!(
                "https://api.spotify.com/v1/tracks/{}?market=from_token",
                track_id
            ))
            .bearer_auth(&token)
            .send()
            .await
            .context("fetching track")?;
        let t: TrackObj = ok_or_spotify_err(
            raw,
            "track request rejected by Spotify (endpoint is restricted for some new apps — try a playlist URL instead)",
        )
        .await?
        .json()
        .await
        .context("parsing track")?;
        Ok(vec![SpotifyTrack {
            spotify_id: t.id.unwrap_or_default(),
            isrc: t.external_ids.and_then(|e| e.isrc),
            artist: t.artists.into_iter().map(|a| a.name).collect::<Vec<_>>().join(", "),
            title: t.name,
            album: t.album.map(|a| a.name).unwrap_or_default(),
            duration_ms: t.duration_ms.unwrap_or(0),
        }])
    }
}

#[derive(Deserialize)]
struct AlbumFull {
    name: String,
    tracks: AlbumTracksPage,
}

#[derive(Deserialize)]
struct AlbumTracksPage {
    items: Vec<TrackObj>,
}

#[derive(Deserialize)]
struct TracksBatch {
    tracks: Vec<Option<TrackObj>>,
}

#[derive(Deserialize)]
struct PlaylistPage {
    items: Vec<PlaylistItem>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct PlaylistItem {
    track: Option<TrackObj>,
}

#[derive(Deserialize)]
struct TrackObj {
    id: Option<String>,
    name: String,
    duration_ms: Option<u32>,
    artists: Vec<ArtistObj>,
    album: Option<AlbumObj>,
    external_ids: Option<ExternalIds>,
}

#[derive(Deserialize)]
struct ArtistObj {
    name: String,
}

#[derive(Deserialize)]
struct AlbumObj {
    name: String,
}

#[derive(Deserialize)]
struct ExternalIds {
    isrc: Option<String>,
}
