//! Fetches audio for one link into a staging directory by running spotdl
//! (Spotify) or yt-dlp (YouTube) as a child process.
//!
//! Arguments are always passed as a separate argv — never through a shell —
//! and the URL has already been canonicalised by `parser::extract_media_ref`,
//! so it always starts with `https://`.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tracing::debug;

use crate::config::DownloadCfg;
use crate::MediaRef;

const LOG_TAIL_LINES: usize = 40;

/// Something that can turn a link into audio files under `staging`.
/// Used as a generic parameter so tests can swap in a fake.
pub trait Fetcher: Send + Sync + 'static {
    fn fetch(
        &self,
        media: &MediaRef,
        staging: &Path,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;
}

pub struct ProcessFetcher {
    cfg: DownloadCfg,
    spotify_creds: Option<(String, String)>,
}

impl ProcessFetcher {
    pub fn from_config(cfg: &DownloadCfg) -> anyhow::Result<Self> {
        let spotify_creds = if cfg.spotdl_use_official_api {
            let id = std::env::var("SPOTIFY_CLIENT_ID")
                .map_err(|_| anyhow!("spotdl_use_official_api needs SPOTIFY_CLIENT_ID"))?;
            let secret = std::env::var("SPOTIFY_CLIENT_SECRET")
                .map_err(|_| anyhow!("spotdl_use_official_api needs SPOTIFY_CLIENT_SECRET"))?;
            Some((id, secret))
        } else {
            None
        };
        Ok(Self {
            cfg: cfg.clone(),
            spotify_creds,
        })
    }

    /// The exact program + argv for a link. Pure, so it's unit-testable.
    pub fn command_for(&self, media: &MediaRef, staging: &Path) -> (PathBuf, Vec<OsString>) {
        let c = &self.cfg;
        let os = |s: &str| OsString::from(s);
        match media {
            MediaRef::Spotify(url) => {
                let mut args = vec![
                    os("download"),
                    os(url.as_str()),
                    // Relative to the child's cwd (the staging dir): spotdl
                    // sanitises every path component of --output, which
                    // turns ".staging" into "staging".
                    os("--output"),
                    os("{artists} - {title}.{output-ext}"),
                    os("--format"),
                    os(&c.format),
                    os("--bitrate"),
                    os(&c.bitrate),
                    os("--ffmpeg"),
                    c.ffmpeg_bin.clone().into(),
                    os("--print-errors"),
                    os("--log-level"),
                    os("INFO"),
                ];
                if let Some((id, secret)) = &self.spotify_creds {
                    args.extend([
                        os("--use-official-api"),
                        os("--client-id"),
                        os(id),
                        os("--client-secret"),
                        os(secret),
                    ]);
                }
                (c.spotdl_bin.clone(), args)
            }
            MediaRef::YouTube(url) => {
                let playlist_flag = if url.path() == "/playlist" {
                    "--yes-playlist"
                } else {
                    "--no-playlist"
                };
                let args = vec![
                    os("--extract-audio"),
                    os("--audio-format"),
                    os(&c.format),
                    os("--audio-quality"),
                    os(&ytdlp_audio_quality(&c.bitrate)),
                    os("--embed-metadata"),
                    os("--embed-thumbnail"),
                    os("--convert-thumbnails"),
                    os("jpg"),
                    // "Artist - Title" uploads → proper artist/title tags; if the
                    // pattern doesn't match yt-dlp just warns and moves on.
                    os("--parse-metadata"),
                    os("title:%(artist)s - %(title)s"),
                    os(playlist_flag),
                    os("--no-progress"),
                    os("--ffmpeg-location"),
                    c.ffmpeg_bin.clone().into(),
                    os("--output"),
                    staging
                        .join("%(artist,uploader)s - %(title)s.%(ext)s")
                        .into(),
                    os(url.as_str()),
                ];
                (c.ytdlp_bin.clone(), args)
            }
        }
    }

    fn child_path(&self) -> OsString {
        let current = std::env::var_os("PATH").unwrap_or_default();
        match &self.cfg.extra_path {
            Some(extra) if !extra.is_empty() => {
                let mut p = OsString::from(extra);
                p.push(":");
                p.push(current);
                p
            }
            _ => current,
        }
    }
}

impl Fetcher for ProcessFetcher {
    async fn fetch(&self, media: &MediaRef, staging: &Path) -> anyhow::Result<()> {
        let (program, args) = self.command_for(media, staging);
        run_logged(
            &program,
            &args,
            staging,
            self.child_path(),
            Duration::from_secs(self.cfg.job_timeout_secs),
        )
        .await
        .with_context(|| format!("{} failed for {}", program_name(&program), media.url()))
    }
}

/// yt-dlp wants `320K`-style bitrates (or 0–10 VBR); spotdl's `auto` maps to best VBR.
fn ytdlp_audio_quality(bitrate: &str) -> String {
    let digits = bitrate.trim_end_matches(['k', 'K']);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        format!("{digits}K")
    } else {
        "0".to_string()
    }
}

fn program_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.display().to_string())
}

/// Run a child to completion with a timeout, streaming its output to the
/// debug log and keeping the last few lines for the error message.
pub async fn run_logged(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    path_env: OsString,
    timeout: Duration,
) -> anyhow::Result<()> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("PATH", path_env)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting {} (is it installed?)", program.display()))?;

    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_TAIL_LINES)));
    let name = program_name(program);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let run = async {
        tokio::join!(pump(stdout, &tail, &name), pump(stderr, &tail, &name));
        child.wait().await
    };
    let status = match tokio::time::timeout(timeout, run).await {
        Ok(status) => status.context("waiting for child")?,
        Err(_) => {
            let _ = child.kill().await;
            bail!(
                "timed out after {}s{}",
                timeout.as_secs(),
                render_tail(&tail)
            );
        }
    };
    if !status.success() {
        bail!("exited with {status}{}", render_tail(&tail));
    }
    Ok(())
}

async fn pump<R: AsyncRead + Unpin>(stream: Option<R>, tail: &Mutex<VecDeque<String>>, name: &str) {
    let Some(stream) = stream else { return };
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim_end().to_string();
        if line.is_empty() {
            continue;
        }
        debug!(target: "dj_sync::downloader", "{name}: {line}");
        let mut t = tail.lock().expect("tail lock");
        if t.len() == LOG_TAIL_LINES {
            t.pop_front();
        }
        t.push_back(line);
    }
}

fn render_tail(tail: &Mutex<VecDeque<String>>) -> String {
    let t = tail.lock().expect("tail lock");
    if t.is_empty() {
        return String::new();
    }
    // The last handful of lines is what explains a failure.
    let skip = t.len().saturating_sub(8);
    let lines: Vec<&str> = t.iter().skip(skip).map(String::as_str).collect();
    format!(":\n{}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::extract_media_ref;

    fn fetcher() -> ProcessFetcher {
        ProcessFetcher {
            cfg: DownloadCfg {
                spotdl_bin: "/opt/bin/spotdl".into(),
                ytdlp_bin: "/opt/bin/yt-dlp".into(),
                ffmpeg_bin: "/opt/bin/ffmpeg".into(),
                ..DownloadCfg::default()
            },
            spotify_creds: None,
        }
    }

    fn argv(media: &str) -> (PathBuf, Vec<String>) {
        let m = extract_media_ref(media).unwrap();
        let (p, a) = fetcher().command_for(&m, Path::new("/stage"));
        (p, a.into_iter().map(|s| s.into_string().unwrap()).collect())
    }

    #[test]
    fn spotify_goes_to_spotdl_with_template_and_ffmpeg() {
        let (prog, a) = argv("https://open.spotify.com/track/abc123?si=z");
        assert_eq!(prog, PathBuf::from("/opt/bin/spotdl"));
        assert_eq!(
            &a[..2],
            ["download", "https://open.spotify.com/track/abc123"]
        );
        let joined = a.join(" ");
        // Relative template: run_logged sets cwd to the staging dir.
        assert!(joined.contains("--output {artists} - {title}.{output-ext} --format"));
        assert!(joined.contains("--format mp3 --bitrate 320k --ffmpeg /opt/bin/ffmpeg"));
        assert!(!joined.contains("--client-secret"));
    }

    #[test]
    fn official_api_creds_only_when_enabled() {
        let mut f = fetcher();
        f.spotify_creds = Some(("id".into(), "sec".into()));
        let m = extract_media_ref("https://open.spotify.com/album/abc").unwrap();
        let (_, a) = f.command_for(&m, Path::new("/s"));
        let joined: Vec<String> = a.into_iter().map(|s| s.into_string().unwrap()).collect();
        assert!(joined
            .join(" ")
            .ends_with("--use-official-api --client-id id --client-secret sec"));
    }

    #[test]
    fn youtube_video_goes_to_ytdlp_without_playlist_and_url_last() {
        let (prog, a) = argv("https://youtu.be/dQw4w9WgXcQ");
        assert_eq!(prog, PathBuf::from("/opt/bin/yt-dlp"));
        assert!(a.contains(&"--no-playlist".to_string()));
        assert!(a.contains(&"--embed-metadata".to_string()));
        assert_eq!(
            a.last().unwrap(),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        let joined = a.join(" ");
        assert!(joined.contains("--audio-format mp3 --audio-quality 320K"));
        assert!(joined.contains("--ffmpeg-location /opt/bin/ffmpeg"));
        assert!(joined.contains("--output /stage/%(artist,uploader)s - %(title)s.%(ext)s"));
    }

    #[test]
    fn youtube_playlist_opts_in_to_playlist() {
        let (_, a) = argv("https://www.youtube.com/playlist?list=PLabc");
        assert!(a.contains(&"--yes-playlist".to_string()));
        assert!(!a.contains(&"--no-playlist".to_string()));
    }

    #[test]
    fn ytdlp_quality_mapping() {
        assert_eq!(ytdlp_audio_quality("320k"), "320K");
        assert_eq!(ytdlp_audio_quality("auto"), "0");
        assert_eq!(ytdlp_audio_quality("disable"), "0");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_logged_reports_exit_code_and_output_tail() {
        let dir = tempfile::tempdir().unwrap();
        let err = run_logged(
            Path::new("/bin/sh"),
            &[
                "-c".into(),
                "echo fine; echo 'ERROR: no such video' >&2; exit 3".into(),
            ],
            dir.path(),
            std::env::var_os("PATH").unwrap_or_default(),
            Duration::from_secs(10),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("exit status: 3"), "{err}");
        assert!(err.contains("ERROR: no such video"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_logged_kills_on_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        let err = run_logged(
            Path::new("/bin/sh"),
            &["-c".into(), "echo starting; sleep 30".into()],
            dir.path(),
            std::env::var_os("PATH").unwrap_or_default(),
            Duration::from_millis(300),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_logged_missing_program_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let err = run_logged(
            Path::new("/definitely/not/spotdl"),
            &[],
            dir.path(),
            OsString::new(),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(format!("{err:#}").contains("is it installed?"));
    }
}
