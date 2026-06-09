use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub library: LibraryCfg,
    pub rekordbox: RekordboxCfg,
    #[serde(default)]
    pub matcher: MatcherCfg,
    #[serde(default)]
    pub usb: UsbCfg,
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

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let path = config_path()?;
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let cfg: Config = toml::from_str(&raw)
            .with_context(|| format!("parsing {}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
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

    pub fn telegram_bot_token() -> anyhow::Result<String> {
        std::env::var("TELEGRAM_BOT_TOKEN")
            .map_err(|_| anyhow!("TELEGRAM_BOT_TOKEN not set"))
    }

    pub fn allowed_user_ids() -> Vec<i64> {
        std::env::var("DJ_SYNC_ALLOWED_USER_IDS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| s.trim().parse::<i64>().ok())
            .collect()
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
