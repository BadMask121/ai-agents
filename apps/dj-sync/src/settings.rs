//! User-facing settings, written by the DJ Sync menu bar app
//! (`apps/dj-sync/macos`) to `~/.dj-sync/settings.json`:
//!
//! ```json
//! { "download_dir": "/Users/me/Music/DJ" }
//! ```
//!
//! They override `config.toml` and are re-read at the start of every job,
//! so changing the folder takes effect on the next download — no restart.
//! Unknown keys are ignored, so the app can grow without breaking us.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context};
use serde::Deserialize;
use tracing::warn;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub download_dir: Option<PathBuf>,
    /// Where the menu app lives, written at every launch. The service stops
    /// itself once it's been gone a while (`uninstall::watch_app`).
    #[serde(default)]
    pub app_path: Option<PathBuf>,
}

impl Settings {
    /// Missing file → defaults. A file that doesn't parse is logged and
    /// ignored rather than stopping downloads.
    pub fn load_from(path: &Path) -> Settings {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
            Err(e) => {
                warn!(file = %path.display(), error = %e, "can't read settings; using config.toml");
                return Settings::default();
            }
        };
        match serde_json::from_str::<Settings>(&raw) {
            Ok(s) => s,
            Err(e) => {
                warn!(file = %path.display(), error = %e, "invalid settings.json; using config.toml");
                Settings::default()
            }
        }
    }
}

pub fn settings_path() -> anyhow::Result<PathBuf> {
    Ok(crate::config::state_dir()?.join("settings.json"))
}

/// Where a value came from, for the status endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Settings,
    Config,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Settings => "settings",
            Source::Config => "config",
        }
    }
}

/// The download folder to use right now: an absolute `download_dir` from
/// settings.json wins over `[download].dir`.
pub fn download_dir(settings_file: Option<&Path>, config_dir: &Path) -> (PathBuf, Source) {
    let chosen = settings_file
        .map(Settings::load_from)
        .and_then(|s| s.download_dir)
        .filter(|p| {
            let ok = p.is_absolute();
            if !ok {
                warn!(dir = %p.display(), "settings.json download_dir must be absolute; ignoring");
            }
            ok
        });
    match chosen {
        Some(p) => (p, Source::Settings),
        None => (config_dir.to_path_buf(), Source::Config),
    }
}

/// Create the folder if needed and prove this process can write to it.
///
/// dj-sync runs as a background LaunchAgent, which macOS's privacy controls
/// (TCC) block from Desktop, Documents, Downloads, iCloud Drive and external
/// volumes unless it has been granted access — so check for real.
pub fn ensure_writable(dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir).map_err(|e| denied_hint(dir, e))?;
    let probe = dir.join(".dj-sync-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| denied_hint(dir, e))?;
    std::fs::remove_file(&probe).with_context(|| format!("cleaning up {}", probe.display()))?;
    Ok(())
}

fn denied_hint(dir: &Path, e: std::io::Error) -> anyhow::Error {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        anyhow!(
            "macOS won't let dj-sync write to {} ({e}). Pick a folder under ~/Music, or give \
             dj-sync Full Disk Access in System Settings → Privacy & Security.",
            dir.display()
        )
    } else {
        anyhow!("can't use download folder {}: {e}", dir.display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_override_config_only_when_absolute() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        let config_dir = Path::new("/cfg/DJ_Downloads");

        // No file, no override.
        assert_eq!(
            download_dir(Some(&file), config_dir),
            (config_dir.to_path_buf(), Source::Config)
        );
        assert_eq!(download_dir(None, config_dir).1, Source::Config);

        std::fs::write(
            &file,
            r#"{"download_dir":"/Volumes/DJ/Incoming","future_key":1}"#,
        )
        .unwrap();
        assert_eq!(
            download_dir(Some(&file), config_dir),
            (PathBuf::from("/Volumes/DJ/Incoming"), Source::Settings)
        );

        std::fs::write(&file, r#"{"download_dir":"relative/dir"}"#).unwrap();
        assert_eq!(download_dir(Some(&file), config_dir).1, Source::Config);

        std::fs::write(&file, "not json").unwrap();
        assert_eq!(download_dir(Some(&file), config_dir).1, Source::Config);
    }

    #[test]
    fn ensure_writable_creates_and_probes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("new/nested");
        ensure_writable(&dir).unwrap();
        assert!(dir.is_dir());
        assert!(!dir.join(".dj-sync-write-test").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_dir_explains_itself() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("locked");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let err = ensure_writable(&dir).unwrap_err().to_string();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(err.contains("Full Disk Access"), "{err}");
    }
}
