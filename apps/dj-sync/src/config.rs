use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context};
use serde::Deserialize;
use tracing::info;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub library: LibraryCfg,
    pub rekordbox: RekordboxCfg,
    #[serde(default)]
    pub matcher: MatcherCfg,
    #[serde(default)]
    pub usb: UsbCfg,
    #[serde(default)]
    pub mcp: McpCfg,
    #[serde(default)]
    pub download: DownloadCfg,
    #[serde(default)]
    pub cloud: CloudCfg,
    #[serde(default)]
    pub rekordbox_db: RekordboxDbCfg,
}

/// Write downloads and playlist edits into Rekordbox's own library
/// (master.db) as well as the import XML. Applied only while Rekordbox is
/// closed, with semver backups of master.db before and after each write.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct RekordboxDbCfg {
    pub enabled: bool,
    pub db_path: PathBuf,
    /// Python of the managed venv that has pyrekordbox (created on demand).
    pub python: PathBuf,
    pub uv_bin: PathBuf,
    pub pyrekordbox_version: String,
    pub keep_backups: usize,
    /// How often to check whether Rekordbox has closed.
    pub check_secs: u64,
}

impl Default for RekordboxDbCfg {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        Self {
            enabled: false,
            db_path: home.join("Library/Pioneer/rekordbox/master.db"),
            python: home.join(".dj-sync/pyenv/bin/python"),
            uv_bin: PathBuf::from("uv"),
            pyrekordbox_version: "0.5.0".to_string(),
            keep_backups: 12,
            check_secs: 10,
        }
    }
}

/// Cloud lane: poll the Cloudflare Worker queue (apps/dj-sync-cloud) so
/// ChatGPT requests made while this Mac was offline still get processed.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct CloudCfg {
    pub enabled: bool,
    pub base_url: String,
    /// Agent protocol MAJOR: 2 = WebSocket + registration (default), 1 = the
    /// legacy HTTP poll with CLOUD_AGENT_TOKEN (rollback only).
    pub protocol: u8,
    /// v1 only: seconds between polls.
    pub poll_secs: u64,
    /// v2 only: seconds between keep-alive pings on the agent socket.
    pub ping_secs: u64,
}

impl Default for CloudCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: "https://mcp.triplejmusic.art".to_string(),
            protocol: 2,
            poll_secs: 15,
            ping_secs: 60,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct LibraryCfg {
    pub roots: Vec<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RekordboxCfg {
    pub autoimport_dir: PathBuf,
    #[serde(default)]
    pub xml_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MatcherCfg {
    #[serde(default = "default_fuzzy_accept")]
    pub fuzzy_accept: f64,
    #[serde(default = "default_ai_budget")]
    pub ai_budget_per_playlist: usize,
}

impl Default for MatcherCfg {
    fn default() -> Self {
        Self {
            fuzzy_accept: default_fuzzy_accept(),
            ai_budget_per_playlist: default_ai_budget(),
        }
    }
}

fn default_fuzzy_accept() -> f64 {
    0.92
}
fn default_ai_budget() -> usize {
    20
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UsbCfg {
    pub mount: Option<PathBuf>,
}

/// HTTP lane: MCP endpoint for ChatGPT (+ optional Shortcut REST).
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct McpCfg {
    pub enabled: bool,
    pub bind: SocketAddr,
    pub public_base_url: Option<String>,
}

impl Default for McpCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: SocketAddr::from(([127, 0, 0, 1], 8000)),
            public_base_url: None,
        }
    }
}

/// Where downloads land and how spotdl / yt-dlp are invoked.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct DownloadCfg {
    pub dir: PathBuf,
    /// Left unset (empty), `Config::load` uses the file Rekordbox's own
    /// *Imported Library* setting points at, so Rekordbox needs no setup.
    pub import_xml: PathBuf,
    pub default_playlist: String,
    pub spotdl_bin: PathBuf,
    pub ytdlp_bin: PathBuf,
    pub ffmpeg_bin: PathBuf,
    /// Prepended to the child PATH (launchd starts us with a bare PATH).
    pub extra_path: Option<String>,
    pub format: String,
    pub bitrate: String,
    pub spotdl_use_official_api: bool,
    pub job_timeout_secs: u64,
    pub max_urls_per_job: usize,
    /// Semver snapshots of the import XML to keep (every X.0.0 is kept too).
    pub keep_versions: usize,
    /// `~/.dj-sync/settings.json` (written by the menu bar app), consulted
    /// per job. `None` (tests, or no state dir) means config.toml only.
    #[serde(skip)]
    pub settings_file: Option<PathBuf>,
}

impl Default for DownloadCfg {
    fn default() -> Self {
        let music = dirs::home_dir().unwrap_or_default().join("Music");
        Self {
            dir: music.join("DJ_Downloads"),
            import_xml: PathBuf::new(),
            default_playlist: "ChatGPT Downloads".to_string(),
            spotdl_bin: PathBuf::from("spotdl"),
            ytdlp_bin: PathBuf::from("yt-dlp"),
            ffmpeg_bin: PathBuf::from("ffmpeg"),
            extra_path: None,
            format: "mp3".to_string(),
            bitrate: "320k".to_string(),
            spotdl_use_official_api: false,
            job_timeout_secs: 1800,
            max_urls_per_job: 25,
            keep_versions: 100,
            settings_file: None,
        }
    }
}

/// Formats both spotdl and yt-dlp can produce that Rekordbox can also play.
const REKORDBOX_FORMATS: &[&str] = &["mp3", "m4a", "flac", "wav"];

impl DownloadCfg {
    /// The download folder right now: the menu bar app's choice if set,
    /// else `[download].dir`. Read fresh each call.
    pub fn current_dir(&self) -> (PathBuf, crate::settings::Source) {
        crate::settings::download_dir(self.settings_file.as_deref(), &self.dir)
    }

    fn expand_paths(&mut self) {
        for p in [
            &mut self.dir,
            &mut self.import_xml,
            &mut self.spotdl_bin,
            &mut self.ytdlp_bin,
            &mut self.ffmpeg_bin,
        ] {
            *p = expand_tilde(p);
        }
    }

    /// Creates the download dir and the XML's parent dir if missing.
    pub fn prepare(&self) -> anyhow::Result<()> {
        if self.import_xml.as_os_str().is_empty() {
            return Err(anyhow!("config: download.import_xml was not resolved"));
        }
        if !REKORDBOX_FORMATS.contains(&self.format.as_str()) {
            return Err(anyhow!(
                "config: download.format must be one of {REKORDBOX_FORMATS:?}, got {:?}",
                self.format
            ));
        }
        if self.max_urls_per_job == 0 {
            return Err(anyhow!("config: download.max_urls_per_job must be > 0"));
        }
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("creating {}", self.dir.display()))?;
        if let Some(parent) = self.import_xml.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        Ok(())
    }
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let path = config_path()?;
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let mut cfg: Config =
            toml::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;
        cfg.download.expand_paths();
        for p in [
            &mut cfg.rekordbox_db.db_path,
            &mut cfg.rekordbox_db.python,
            &mut cfg.rekordbox_db.uv_bin,
        ] {
            *p = expand_tilde(p);
        }
        cfg.download.settings_file = crate::settings::settings_path().ok();
        cfg.resolve_import_xml(rekordbox_settings_path().as_deref());
        cfg.validate()?;
        Ok(cfg)
    }

    /// Fill in `download.import_xml` when the config leaves it unset: prefer
    /// the path in Rekordbox's own settings, then `~/Music/rekordbox_import.xml`.
    /// Never adopts the bot's `rekordbox.xml_path` (your real collection export).
    fn resolve_import_xml(&mut self, rekordbox_settings: Option<&Path>) {
        if !self.download.import_xml.as_os_str().is_empty() {
            return;
        }
        let detected = rekordbox_settings
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|raw| rekordbox_imported_library(&raw))
            .filter(|p| Some(p) != self.rekordbox.xml_path.as_ref());
        self.download.import_xml = match detected {
            Some(p) => {
                info!(path = %p.display(), "import_xml: using Rekordbox's Imported Library path");
                p
            }
            None => {
                let p = dirs::home_dir()
                    .unwrap_or_default()
                    .join("Music")
                    .join("rekordbox_import.xml");
                info!(
                    path = %p.display(),
                    "import_xml: Rekordbox has no Imported Library set; point it at this file"
                );
                p
            }
        };
    }

    fn validate(&self) -> anyhow::Result<()> {
        if self.library.roots.is_empty() {
            return Err(anyhow!("config: library.roots must be non-empty"));
        }
        for root in &self.library.roots {
            ensure_dir(root, "library.roots entry")?;
        }
        ensure_dir(&self.rekordbox.autoimport_dir, "rekordbox.autoimport_dir")?;
        Ok(())
    }

    /// An empty value (e.g. `TELEGRAM_BOT_TOKEN=` copied from .env.example)
    /// counts as unset, so the bot lane stays off.
    pub fn telegram_bot_token() -> anyhow::Result<String> {
        std::env::var("TELEGRAM_BOT_TOKEN")
            .ok()
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| anyhow!("TELEGRAM_BOT_TOKEN not set"))
    }

    /// Secret path segment for the MCP endpoint (`/<secret>/mcp`). Behind TLS
    /// this acts as the bearer token, same model as mail-mcp.
    pub fn mcp_secret_path() -> anyhow::Result<String> {
        let s = std::env::var("MCP_SECRET_PATH").map_err(|_| anyhow!("MCP_SECRET_PATH not set"))?;
        validate_secret_path(&s)?;
        Ok(s)
    }

    /// Optional bearer key for the iOS Shortcut REST routes. Unset (or empty)
    /// leaves `/api/*` switched off.
    pub fn shortcut_api_key() -> anyhow::Result<Option<String>> {
        match std::env::var("SHORTCUT_API_KEY") {
            Ok(k) if k.trim().is_empty() => Ok(None),
            Ok(k) if k.trim().len() < 24 => Err(anyhow!(
                "SHORTCUT_API_KEY must be at least 24 characters (try `openssl rand -hex 24`)"
            )),
            Ok(k) => Ok(Some(k.trim().to_string())),
            Err(_) => Ok(None),
        }
    }

    /// Bearer token the cloud lane presents to the Worker's /agent/* routes.
    pub fn cloud_agent_token() -> anyhow::Result<String> {
        std::env::var("CLOUD_AGENT_TOKEN")
            .ok()
            .filter(|t| t.trim().len() >= 24)
            .map(|t| t.trim().to_string())
            .ok_or_else(|| anyhow!("CLOUD_AGENT_TOKEN not set (or shorter than 24 chars)"))
    }

    pub fn allowed_user_ids() -> Vec<i64> {
        std::env::var("DJ_SYNC_ALLOWED_USER_IDS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| s.trim().parse::<i64>().ok())
            .collect()
    }
}

/// Rekordbox 6 and 7 both keep their preferences here (macOS: ~/Library/
/// Application Support/…, Windows: %APPDATA%\…).
fn rekordbox_settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| {
        d.join("Pioneer")
            .join("rekordbox6")
            .join("rekordbox3.settings")
    })
}

/// Preferences → Advanced → Database → rekordbox xml → Imported Library is
/// stored as `<VALUE name="bridgeImportedLibraryFile" val="…"/>`.
pub fn rekordbox_imported_library(settings_xml: &str) -> Option<PathBuf> {
    static RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r#"name="bridgeImportedLibraryFile"\s+val="([^"]*)""#)
            .expect("static regex")
    });
    let raw = RE.captures(settings_xml)?.get(1)?.as_str();
    let path = PathBuf::from(quick_xml::escape::unescape(raw).ok()?.into_owned());
    path.is_absolute().then_some(path)
}

fn validate_secret_path(s: &str) -> anyhow::Result<()> {
    if s.len() < 32 {
        return Err(anyhow!(
            "MCP_SECRET_PATH must be at least 32 characters (try `openssl rand -hex 24`)"
        ));
    }
    if !s
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(anyhow!("MCP_SECRET_PATH may only contain [A-Za-z0-9_-]"));
    }
    Ok(())
}

/// TOML has no `~`; expand a leading `~/` against the home directory.
fn expand_tilde(p: &Path) -> PathBuf {
    match p.strip_prefix("~") {
        Ok(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        Err(_) => p.to_path_buf(),
    }
}

fn ensure_dir(p: &Path, label: &str) -> anyhow::Result<()> {
    if !p.exists() {
        return Err(anyhow!("{}: {} does not exist", label, p.display()));
    }
    if !p.is_dir() {
        return Err(anyhow!("{}: {} is not a directory", label, p.display()));
    }
    Ok(())
}

pub fn config_path() -> anyhow::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not resolve home directory"))?;
    Ok(home.join(".dj-sync").join("config.toml"))
}

pub fn state_dir() -> anyhow::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not resolve home directory"))?;
    let dir = home.join(".dj-sync");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
[library]
roots = ["/tmp"]
[rekordbox]
autoimport_dir = "/tmp"
"#;

    #[test]
    fn mcp_and_download_sections_default_when_absent() {
        let cfg: Config = toml::from_str(MINIMAL).unwrap();
        assert!(!cfg.mcp.enabled);
        assert_eq!(cfg.mcp.bind.to_string(), "127.0.0.1:8000");
        assert!(cfg.download.dir.ends_with("Music/DJ_Downloads"));
        assert!(
            cfg.download.import_xml.as_os_str().is_empty(),
            "unset until resolved"
        );
        assert_eq!(cfg.download.format, "mp3");
    }

    #[test]
    fn partial_download_section_keeps_other_defaults_and_expands_tilde() {
        let raw = format!(
            "{MINIMAL}\n[mcp]\nenabled = true\n[download]\ndir = \"~/DJ\"\nformat = \"flac\"\n"
        );
        let mut cfg: Config = toml::from_str(&raw).unwrap();
        cfg.download.expand_paths();
        assert!(cfg.mcp.enabled);
        assert_eq!(cfg.download.dir, dirs::home_dir().unwrap().join("DJ"));
        assert_eq!(cfg.download.format, "flac");
        assert_eq!(cfg.download.job_timeout_secs, 1800);
    }

    #[test]
    fn prepare_rejects_formats_rekordbox_cannot_play() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = DownloadCfg {
            dir: dir.path().join("dl"),
            import_xml: dir.path().join("x/import.xml"),
            format: "opus".into(),
            ..DownloadCfg::default()
        };
        assert!(cfg.prepare().is_err());
        let cfg = DownloadCfg {
            format: "mp3".into(),
            ..cfg
        };
        cfg.prepare().unwrap();
        assert!(dir.path().join("dl").is_dir());
        assert!(dir.path().join("x").is_dir());
    }

    #[test]
    fn shipped_example_config_parses() {
        let raw = include_str!("../config.example.toml");
        let mut cfg: Config = toml::from_str(raw).unwrap();
        cfg.download.expand_paths();
        assert!(!cfg.mcp.enabled);
        assert!(
            cfg.download.import_xml.as_os_str().is_empty(),
            "example leaves import_xml to auto-detection"
        );
        assert_eq!(cfg.download.max_urls_per_job, 25);
    }

    const SETTINGS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<PROPERTIES>
  <VALUE name="itunesLibraryFile" val="/Users/dj/Music/iTunes/iTunes Music Library.xml"/>
  <VALUE name="bridgeImportedLibraryFile" val="/Users/dj/Music/A &amp; B/rekordbox.xml"/>
</PROPERTIES>"#;

    #[test]
    fn reads_imported_library_from_rekordbox_settings() {
        assert_eq!(
            rekordbox_imported_library(SETTINGS),
            Some(PathBuf::from("/Users/dj/Music/A & B/rekordbox.xml"))
        );
        assert_eq!(
            rekordbox_imported_library(r#"<VALUE name="bridgeImportedLibraryFile" val=""/>"#),
            None
        );
        assert_eq!(rekordbox_imported_library("<PROPERTIES/>"), None);
    }

    fn resolve(toml_src: &str, settings: Option<&str>) -> PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let settings_path = dir.path().join("rekordbox3.settings");
        if let Some(s) = settings {
            std::fs::write(&settings_path, s).unwrap();
        }
        let mut cfg: Config = toml::from_str(toml_src).unwrap();
        cfg.download.expand_paths();
        cfg.resolve_import_xml(Some(&settings_path));
        cfg.download.import_xml
    }

    #[test]
    fn import_xml_resolution_order() {
        let detected = PathBuf::from("/Users/dj/Music/A & B/rekordbox.xml");
        let fallback = dirs::home_dir().unwrap().join("Music/rekordbox_import.xml");

        // Rekordbox's own setting wins when the config is silent…
        assert_eq!(resolve(MINIMAL, Some(SETTINGS)), detected);
        // …an explicit config value always wins…
        let explicit = format!("{MINIMAL}\n[download]\nimport_xml = \"/x/mine.xml\"\n");
        assert_eq!(
            resolve(&explicit, Some(SETTINGS)),
            PathBuf::from("/x/mine.xml")
        );
        // …no settings file falls back to ~/Music…
        assert_eq!(resolve(MINIMAL, None), fallback);
        // …and the bot's collection export is never adopted.
        let with_export = MINIMAL.replace(
            "autoimport_dir = \"/tmp\"",
            "autoimport_dir = \"/tmp\"\nxml_path = \"/Users/dj/Music/A & B/rekordbox.xml\"",
        );
        assert_eq!(resolve(&with_export, Some(SETTINGS)), fallback);
    }

    #[test]
    fn secret_path_rules() {
        assert!(validate_secret_path("short").is_err());
        assert!(validate_secret_path(&"a/".repeat(20)).is_err());
        assert!(validate_secret_path(&"ab12_-".repeat(6)).is_ok());
    }
}
