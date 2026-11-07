//! The toolbox: installs and updates the command-line tools dj-sync drives
//! (yt-dlp, deno, uv, ffmpeg, and spotdl in a uv-managed Python), so a DJ
//! never opens a terminal (spec §2.4).
//!
//! - **What to install** comes from a manifest signed with the release key:
//!   fetched from `MANIFEST_URL`, else the last verified copy, else the one
//!   compiled into this binary.
//! - **Every download is checked** against the manifest's sha256 before it
//!   is unpacked, then run once (`--version`) before it goes live.
//! - **Going live** re-points `tools/<name>/current` (an atomic symlink swap);
//!   the previous version is kept, so a running job never loses its binary.
//! - **yt-dlp** follows its own GitHub releases daily (verified against the
//!   release's `SHA2-256SUMS`), since YouTube breaks old versions.
//!
//! Layout under `~/.dj-sync/tools/`: `<name>/<version>/<bin>`,
//! `<name>/current`, `venvs/<name>/`, `python/` and `uv-cache/` (uv's own).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, Notify};
use tracing::{info, warn};

use crate::signing;

pub const MANIFEST_URL: &str = "https://djsync.jeffrey.build/download/tools-manifest.json";
const EMBEDDED_MANIFEST: &str = include_str!("../toolbox/manifest.json");
const MAX_DOWNLOAD_BYTES: u64 = 400 * 1024 * 1024;
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(2 * 60);
/// A stalled or unreachable download is tried this many times (2 s, then 6 s
/// apart) before the pass reports it.
const DOWNLOAD_ATTEMPTS: u32 = 3;
const DAILY: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    #[serde(default)]
    pub generated_at: String,
    pub tools: BTreeMap<String, ToolSpec>,
    #[serde(default)]
    pub python: PythonSpec,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PythonSpec {
    #[serde(default)]
    pub version: String,
    /// venv name → pip requirements.
    #[serde(default)]
    pub venvs: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub version: String,
    pub bin: String,
    /// Smoke test before going live (default `--version`).
    #[serde(default)]
    pub check_args: Option<Vec<String>>,
    #[serde(default)]
    pub universal: Option<Artifact>,
    #[serde(default)]
    pub arm64: Option<Artifact>,
    #[serde(default)]
    pub x86_64: Option<Artifact>,
    /// `github-release:<owner>/<repo>:<asset>:<sums file>`
    #[serde(default)]
    pub auto_update: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    /// `zip`, `tar.gz`, or absent for a bare binary.
    #[serde(default)]
    pub archive: Option<String>,
}

impl ToolSpec {
    fn artifact(&self) -> Option<&Artifact> {
        let native = match std::env::consts::ARCH {
            "aarch64" => self.arm64.as_ref(),
            "x86_64" => self.x86_64.as_ref(),
            _ => None,
        };
        native.or(self.universal.as_ref())
    }

    fn check_args(&self) -> Vec<String> {
        self.check_args
            .clone()
            .unwrap_or_else(|| vec!["--version".into()])
    }
}

/// Where the toolbox keeps things; also used for config defaults.
#[derive(Debug, Clone)]
pub struct ToolPaths {
    root: PathBuf,
}

impl ToolPaths {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// `~/.dj-sync/tools`
    pub fn default_root() -> PathBuf {
        dirs::home_dir().unwrap_or_default().join(".dj-sync/tools")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `tools/<tool>/current/<bin>`
    pub fn bin(&self, tool: &str, bin: &str) -> PathBuf {
        self.current_dir(tool).join(bin)
    }

    pub fn current_dir(&self, tool: &str) -> PathBuf {
        self.root.join(tool).join("current")
    }

    pub fn venv(&self, name: &str) -> PathBuf {
        self.root.join("venvs").join(name)
    }

    /// Keeps uv's Pythons and cache inside the toolbox, and ignores any
    /// system Python or user uv config.
    pub fn uv_env(&self) -> Vec<(&'static str, PathBuf)> {
        vec![
            ("UV_PYTHON_INSTALL_DIR", self.root.join("python")),
            ("UV_CACHE_DIR", self.root.join("uv-cache")),
            ("UV_PYTHON_PREFERENCE", "only-managed".into()),
            ("UV_NO_CONFIG", "1".into()),
        ]
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    pub installing: bool,
    pub step: Option<String>,
    /// 0–1 while installing.
    pub progress: Option<f64>,
    pub error: Option<String>,
    /// `remote`, `cached` or `built-in`.
    pub manifest: Option<String>,
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolReport {
    pub name: String,
    pub installed: Option<String>,
    pub wanted: String,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub tools: Vec<ToolReport>,
    pub venvs: Vec<ToolReport>,
    #[serde(flatten)]
    pub status: Status,
}

pub struct Toolbox {
    paths: ToolPaths,
    http: reqwest::Client,
    manifest_url: Option<String>,
    github_api: String,
    key: VerifyingKey,
    manifest: RwLock<Option<Manifest>>,
    status: StdMutex<Status>,
    busy: tokio::sync::Mutex<()>,
    wake: Notify,
    /// Flips to true once the first install pass has finished (ok or not).
    first_pass: watch::Sender<bool>,
}

impl Toolbox {
    pub fn new(paths: ToolPaths, manifest_url: Option<String>) -> anyhow::Result<Arc<Self>> {
        Self::with_parts(
            paths,
            manifest_url,
            signing::release_key(),
            "https://api.github.com".into(),
        )
    }

    pub fn with_parts(
        paths: ToolPaths,
        manifest_url: Option<String>,
        key: VerifyingKey,
        github_api: String,
    ) -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            paths,
            http: reqwest::Client::builder()
                .user_agent(concat!("dj-sync/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(30))
                .build()
                .context("building http client")?,
            manifest_url,
            github_api: github_api.trim_end_matches('/').to_string(),
            key,
            manifest: RwLock::new(None),
            status: StdMutex::new(Status::default()),
            busy: tokio::sync::Mutex::new(()),
            wake: Notify::new(),
            first_pass: watch::channel(false).0,
        }))
    }

    pub fn paths(&self) -> &ToolPaths {
        &self.paths
    }

    /// Resolves once the first install pass is over, so the cloud lane
    /// doesn't take jobs before the tools exist (they wait in the cloud).
    pub async fn wait_first_pass(&self) {
        let mut rx = self.first_pass.subscribe();
        let _ = rx.wait_for(|done| *done).await;
    }

    /// Ask the background loop to (re)install now (the menu app's Repair).
    pub fn request_install(&self) {
        self.wake.notify_one();
    }

    pub fn installed_version(&self, tool: &str) -> Option<String> {
        let target = std::fs::read_link(self.paths.current_dir(tool)).ok()?;
        target.file_name().map(|n| n.to_string_lossy().into_owned())
    }

    pub fn report(&self) -> Report {
        let manifest = self
            .manifest
            .read()
            .ok()
            .and_then(|m| m.clone())
            .unwrap_or_else(builtin_manifest);
        let tools = manifest
            .tools
            .iter()
            .map(|(name, spec)| {
                let installed = self.installed_version(name);
                let ready = self.paths.bin(name, &spec.bin).is_file();
                ToolReport {
                    name: name.clone(),
                    installed,
                    wanted: spec.version.clone(),
                    ready,
                }
            })
            .collect();
        let venvs = manifest
            .python
            .venvs
            .iter()
            .map(|(name, reqs)| {
                let marker = std::fs::read_to_string(self.paths.venv(name).join(MARKER)).ok();
                let wanted = reqs.join(" ");
                ToolReport {
                    name: name.clone(),
                    ready: marker.as_deref() == Some(wanted.as_str()),
                    installed: marker,
                    wanted,
                }
            })
            .collect();
        Report {
            tools,
            venvs,
            status: self.status.lock().map(|s| s.clone()).unwrap_or_default(),
        }
    }

    fn set_status(&self, f: impl FnOnce(&mut Status)) {
        if let Ok(mut s) = self.status.lock() {
            f(&mut s);
        }
    }

    // ---------- manifest ----------

    /// Remote (verified) → last verified copy → built-in. Never fails.
    pub async fn load_manifest(&self) -> Manifest {
        let cache = self.paths.root.join("manifest.json");
        let (manifest, source) = match self.fetch_manifest().await {
            Ok((m, bytes, sig)) => {
                let saved = std::fs::create_dir_all(&self.paths.root)
                    .and_then(|_| std::fs::write(&cache, &bytes))
                    .and_then(|_| std::fs::write(cache.with_extension("json.sig"), &sig));
                if let Err(e) = saved {
                    warn!(error = %e, "couldn't cache the tools manifest");
                }
                (m, "remote")
            }
            Err(e) => {
                if self.manifest_url.is_some() {
                    warn!(error = %format!("{e:#}"), "couldn't fetch the tools manifest; using a local copy");
                }
                match self.cached_manifest(&cache) {
                    Some(m) => (m, "cached"),
                    None => (builtin_manifest(), "built-in"),
                }
            }
        };
        if let Ok(mut slot) = self.manifest.write() {
            *slot = Some(manifest.clone());
        }
        self.set_status(|s| s.manifest = Some(source.into()));
        manifest
    }

    async fn fetch_manifest(&self) -> anyhow::Result<(Manifest, Vec<u8>, String)> {
        let url = self
            .manifest_url
            .as_deref()
            .ok_or_else(|| anyhow!("no manifest URL"))?;
        let get = |u: String| async move {
            self.http
                .get(&u)
                .timeout(Duration::from_secs(30))
                .send()
                .await?
                .error_for_status()?
                .bytes()
                .await
        };
        let bytes = get(url.to_string()).await?.to_vec();
        let sig = String::from_utf8(get(format!("{url}.sig")).await?.to_vec())?;
        signing::verify(&self.key, &bytes, &sig).context("tools manifest signature")?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes).context("parsing tools manifest")?;
        Ok((manifest, bytes, sig))
    }

    fn cached_manifest(&self, cache: &Path) -> Option<Manifest> {
        let bytes = std::fs::read(cache).ok()?;
        let sig = std::fs::read_to_string(cache.with_extension("json.sig")).ok()?;
        signing::verify(&self.key, &bytes, &sig).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    // ---------- install ----------

    /// Install whatever the manifest wants and isn't here yet.
    pub async fn ensure(&self) -> anyhow::Result<()> {
        let _busy = self.busy.lock().await;
        self.set_status(|s| {
            s.installing = true;
            s.error = None;
            s.progress = Some(0.0);
        });
        let result = self.ensure_inner().await;
        self.set_status(|s| {
            s.installing = false;
            s.step = None;
            s.progress = None;
            s.checked_at = Some(chrono::Utc::now().to_rfc3339());
            s.error = result.as_ref().err().map(|e| format!("{e:#}"));
        });
        result
    }

    async fn ensure_inner(&self) -> anyhow::Result<()> {
        let manifest = self.load_manifest().await;
        let tool_steps: Vec<(&String, &ToolSpec)> = manifest
            .tools
            .iter()
            .filter(|(name, spec)| !self.is_current(name, spec))
            .collect();
        let venv_steps: Vec<(&String, &Vec<String>)> = manifest
            .python
            .venvs
            .iter()
            .filter(|(name, reqs)| !self.venv_is_current(name, reqs))
            .collect();
        let total = (tool_steps.len() + venv_steps.len()).max(1) as f64;
        let mut failures = Vec::new();
        let mut unreachable = std::collections::BTreeSet::new();

        for (i, (name, spec)) in tool_steps.iter().enumerate() {
            let Some(artifact) = spec.artifact() else {
                failures.push(format!("{name}: no build for this Mac"));
                continue;
            };
            self.set_status(|s| s.step = Some(format!("Installing {name} {}", spec.version)));
            let progress = |f: f64| self.set_status(|s| s.progress = Some((i as f64 + f) / total));
            if let Err(e) = self
                .install(
                    name,
                    &spec.version,
                    &spec.bin,
                    artifact,
                    &spec.check_args(),
                    progress,
                )
                .await
            {
                warn!(tool = %name, error = %format!("{e:#}"), "tool install failed");
                match network_host(&e) {
                    Some(host) => {
                        unreachable.insert(host);
                    }
                    None => failures.push(format!("{name}: {e:#}")),
                }
            }
        }
        for (j, (name, reqs)) in venv_steps.iter().enumerate() {
            self.set_status(|s| {
                s.step = Some(format!("Setting up {name}"));
                s.progress = Some((tool_steps.len() + j) as f64 / total);
            });
            if let Err(e) = self.ensure_venv(name, reqs, &manifest.python.version).await {
                warn!(venv = %name, error = %format!("{e:#}"), "python environment failed");
                // Just a knock-on of uv not having downloaded.
                if !(!unreachable.is_empty() && format!("{e:#}").contains("uv isn't installed yet")) {
                    failures.push(format!("{name}: {e:#}"));
                }
            }
        }
        if !unreachable.is_empty() {
            let hosts = unreachable.into_iter().collect::<Vec<_>>().join(", ");
            failures.insert(
                0,
                format!(
                    "Couldn't reach {hosts}. Check your internet connection (or a VPN or firewall). DJ Sync will try again by itself."
                ),
            );
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(anyhow!(failures.join("; ")))
        }
    }

    fn is_current(&self, name: &str, spec: &ToolSpec) -> bool {
        if !self.paths.bin(name, &spec.bin).is_file() {
            return false;
        }
        match self.installed_version(name) {
            Some(v) if v == spec.version => true,
            // A self-updating tool may already be newer than the manifest.
            Some(v) => spec.auto_update.is_some() && newer_or_equal(&v, &spec.version),
            None => false,
        }
    }

    /// Download, verify, unpack, smoke-test, then go live.
    async fn install(
        &self,
        name: &str,
        version: &str,
        bin: &str,
        artifact: &Artifact,
        check_args: &[String],
        progress: impl Fn(f64),
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            safe_component(name) && safe_component(version),
            "unsafe tool name or version"
        );
        let downloads = self.paths.root.join(".downloads");
        tokio::fs::create_dir_all(&downloads).await?;
        let file = downloads.join(format!("{name}-{version}.part"));
        info!(tool = name, version, url = %artifact.url, "downloading");
        self.download_retrying(&artifact.url, &file, &artifact.sha256, &progress)
            .await?;

        let staging = self
            .paths
            .root
            .join(".staging")
            .join(format!("{name}-{version}"));
        let tool_dir = self.paths.root.join(name);
        let final_dir = tool_dir.join(version);
        let (archive, bin_owned) = (artifact.archive.clone(), bin.to_string());
        let (file2, staging2, final2) = (file.clone(), staging.clone(), final_dir.clone());
        tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(&staging2);
            std::fs::create_dir_all(&staging2)?;
            unpack(archive.as_deref(), &file2, &staging2, &bin_owned)?;
            let found = find_file(&staging2, &bin_owned)
                .ok_or_else(|| anyhow!("{bin_owned} not found in the download"))?;
            let _ = std::fs::remove_dir_all(&final2);
            std::fs::create_dir_all(&final2)?;
            let dest = final2.join(&bin_owned);
            std::fs::rename(&found, &dest)?;
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
            let _ = std::fs::remove_dir_all(&staging2);
            anyhow::Ok(())
        })
        .await
        .context("unpack task")??;
        let _ = tokio::fs::remove_file(&file).await;

        let exe = final_dir.join(bin);
        if let Err(e) = smoke_test(&exe, check_args).await {
            let _ = tokio::fs::remove_dir_all(&final_dir).await;
            return Err(e.context(format!("{name} {version} didn't run on this Mac")));
        }
        point_current(&tool_dir, version)?;
        prune(&tool_dir, version);
        progress(1.0);
        info!(tool = name, version, "tool ready");
        Ok(())
    }

    /// `download`, tried again after a stall or a failed connection (a bad
    /// checksum or an HTTP error isn't going to get better).
    async fn download_retrying(
        &self,
        url: &str,
        dest: &Path,
        sha256: &str,
        progress: &impl Fn(f64),
    ) -> anyhow::Result<()> {
        let mut attempt = 1;
        let mut wait = Duration::from_secs(2);
        loop {
            match self.download(url, dest, sha256, progress).await {
                Err(e) if attempt < DOWNLOAD_ATTEMPTS && network_host(&e).is_some() => {
                    warn!(url, attempt, error = %format!("{e:#}"), "download failed; retrying");
                    tokio::time::sleep(wait).await;
                    attempt += 1;
                    wait *= 3;
                }
                result => return result,
            }
        }
    }

    async fn download(
        &self,
        url: &str,
        dest: &Path,
        sha256: &str,
        progress: &impl Fn(f64),
    ) -> anyhow::Result<()> {
        let mut res = self
            .http
            .get(url)
            .send()
            .await
            .with_context(|| format!("downloading {url}"))?
            .error_for_status()?;
        let total = res.content_length();
        if total.is_some_and(|t| t > MAX_DOWNLOAD_BYTES) {
            bail!("{url} is unexpectedly large");
        }
        let mut file = tokio::fs::File::create(dest).await?;
        let mut hasher = Sha256::new();
        let mut done: u64 = 0;
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(60), res.chunk())
            .await
            .map_err(|_| anyhow!("download stalled: {url}"))??
        {
            done += chunk.len() as u64;
            if done > MAX_DOWNLOAD_BYTES {
                bail!("{url} is unexpectedly large");
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            if let Some(t) = total {
                progress(0.9 * done as f64 / t as f64);
            }
        }
        file.flush().await?;
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(sha256.trim()) {
            let _ = tokio::fs::remove_file(dest).await;
            bail!("checksum mismatch for {url} (expected {sha256}, got {got})");
        }
        Ok(())
    }

    fn venv_is_current(&self, name: &str, reqs: &[String]) -> bool {
        let marker = std::fs::read_to_string(self.paths.venv(name).join(MARKER)).ok();
        marker.as_deref() == Some(reqs.join(" ").as_str())
            && self.paths.venv(name).join("bin/python").exists()
    }

    async fn ensure_venv(&self, name: &str, reqs: &[String], python: &str) -> anyhow::Result<()> {
        anyhow::ensure!(safe_component(name), "unsafe venv name");
        let uv = self.paths.bin("uv", "uv");
        anyhow::ensure!(uv.is_file(), "uv isn't installed yet");
        let venv = self.paths.venv(name);
        let py = venv.join("bin/python");
        if !py.exists() {
            let mut args = vec!["venv".to_string()];
            if !python.is_empty() {
                args.extend(["--python".into(), python.into()]);
            }
            args.push(venv.to_string_lossy().into_owned());
            self.uv(&uv, &args).await.context("creating the venv")?;
        }
        let mut args = vec![
            "pip".to_string(),
            "install".into(),
            "--python".into(),
            py.to_string_lossy().into_owned(),
        ];
        args.extend(reqs.iter().cloned());
        self.uv(&uv, &args).await.context("installing packages")?;
        tokio::fs::write(venv.join(MARKER), reqs.join(" ")).await?;
        // The wheels are in the venv now; the cache is ~100 MB of leftovers.
        let _ = tokio::fs::remove_dir_all(self.paths.root.join("uv-cache")).await;
        info!(venv = name, "python environment ready");
        Ok(())
    }

    async fn uv(&self, uv: &Path, args: &[String]) -> anyhow::Result<()> {
        let mut cmd = tokio::process::Command::new(uv);
        cmd.args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        for (k, v) in self.paths.uv_env() {
            cmd.env(k, v);
        }
        let out = tokio::time::timeout(Duration::from_secs(20 * 60), cmd.output())
            .await
            .map_err(|_| anyhow!("uv timed out"))??;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let tail: Vec<&str> = err.lines().rev().take(5).collect();
            bail!(
                "uv {} failed: {}",
                args.first().map_or("", |s| s),
                tail.into_iter().rev().collect::<Vec<_>>().join(" / ")
            );
        }
        Ok(())
    }

    // ---------- self-updating tools ----------

    /// Follow each `auto_update` tool's own releases. Returns what changed.
    pub async fn update_auto(&self) -> anyhow::Result<Vec<String>> {
        let _busy = self.busy.lock().await;
        let manifest = self
            .manifest
            .read()
            .ok()
            .and_then(|m| m.clone())
            .unwrap_or_else(builtin_manifest);
        let mut updated = Vec::new();
        for (name, spec) in &manifest.tools {
            let Some(rule) = spec.auto_update.as_deref() else {
                continue;
            };
            match self.update_one(name, spec, rule).await {
                Ok(Some(v)) => updated.push(format!("{name} {v}")),
                Ok(None) => {}
                Err(e) => {
                    warn!(tool = %name, error = %format!("{e:#}"), "auto-update failed; keeping the current version")
                }
            }
        }
        Ok(updated)
    }

    async fn update_one(
        &self,
        name: &str,
        spec: &ToolSpec,
        rule: &str,
    ) -> anyhow::Result<Option<String>> {
        let parts: Vec<&str> = rule.split(':').collect();
        let ["github-release", repo, asset, sums] = parts.as_slice() else {
            bail!("unknown auto_update rule {rule}");
        };
        #[derive(Deserialize)]
        struct Release {
            tag_name: String,
            assets: Vec<Asset>,
        }
        #[derive(Deserialize)]
        struct Asset {
            name: String,
            browser_download_url: String,
        }
        let release: Release = self
            .http
            .get(format!("{}/repos/{repo}/releases/latest", self.github_api))
            .header("accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let version = release.tag_name.trim_start_matches('v').to_string();
        let installed = self.installed_version(name);
        if installed
            .as_deref()
            .is_some_and(|v| newer_or_equal(v, &version))
        {
            return Ok(None);
        }
        let url_of = |n: &str| {
            release
                .assets
                .iter()
                .find(|a| a.name == n)
                .map(|a| a.browser_download_url.clone())
                .ok_or_else(|| anyhow!("release {version} has no {n}"))
        };
        let sums_text = self
            .http
            .get(url_of(sums)?)
            .timeout(Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        let sha256 = sums_text
            .lines()
            .filter_map(|l| l.split_once(char::is_whitespace))
            .find(|(_, file)| file.trim().trim_start_matches('*') == *asset)
            .map(|(hash, _)| hash.to_string())
            .ok_or_else(|| anyhow!("{sums} doesn't list {asset}"))?;
        let artifact = Artifact {
            url: url_of(asset)?,
            sha256,
            archive: None,
        };
        self.install(
            name,
            &version,
            &spec.bin,
            &artifact,
            &spec.check_args(),
            |_| {},
        )
        .await?;
        Ok(Some(version))
    }
}

/// Install now, then re-check daily (manifest changes + yt-dlp releases);
/// retry sooner after a failure, and on `request_install`.
pub async fn run(toolbox: Arc<Toolbox>, mut shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    loop {
        let next = match toolbox.ensure().await {
            Ok(()) => {
                match toolbox.update_auto().await {
                    Ok(updated) if !updated.is_empty() => info!(?updated, "tools updated"),
                    _ => {}
                }
                DAILY
            }
            Err(e) => {
                warn!(error = %format!("{e:#}"), "toolbox isn't complete; will retry");
                RETRY_AFTER_FAILURE
            }
        };
        toolbox.first_pass.send_replace(true);
        tokio::select! {
            _ = shutdown.wait_for(|s| *s) => return Ok(()),
            _ = tokio::time::sleep(next) => {}
            _ = toolbox.wake.notified() => info!("toolbox install requested"),
        }
    }
}

const MARKER: &str = ".djsync-requirements";

pub fn builtin_manifest() -> Manifest {
    serde_json::from_str(EMBEDDED_MANIFEST).expect("built-in manifest is valid")
}

/// Compare dotted versions numerically (`2026.10.3` < `2026.10.26`).
fn newer_or_equal(a: &str, b: &str) -> bool {
    let nums = |s: &str| -> Vec<u64> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    nums(a) >= nums(b)
}

/// The host we couldn't reach, when `e` is a connection failure, a timeout or
/// a stalled download (as opposed to a bad checksum or an HTTP error).
fn network_host(e: &anyhow::Error) -> Option<String> {
    for cause in e.chain() {
        if let Some(re) = cause.downcast_ref::<reqwest::Error>() {
            if re.is_connect() || re.is_timeout() {
                return re.url().and_then(|u| u.host_str()).map(str::to_string);
            }
        }
        if let Some(rest) = cause.to_string().strip_prefix("download stalled: ") {
            return url::Url::parse(rest).ok()?.host_str().map(str::to_string);
        }
    }
    None
}

fn safe_component(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.starts_with('.')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c))
}

fn unpack(archive: Option<&str>, file: &Path, dir: &Path, bin: &str) -> anyhow::Result<()> {
    match archive {
        None => {
            std::fs::rename(file, dir.join(bin))?;
        }
        Some("zip") => {
            let mut zip =
                zip::ZipArchive::new(std::fs::File::open(file)?).context("reading zip")?;
            zip.extract(dir).context("unzipping")?;
        }
        Some("tar.gz") => {
            let gz = flate2::read::GzDecoder::new(std::fs::File::open(file)?);
            tar::Archive::new(gz).unpack(dir).context("untarring")?;
        }
        Some(other) => bail!("unsupported archive type {other}"),
    }
    Ok(())
}

/// The shallowest regular file called `name` under `dir`.
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    walkdir::WalkDir::new(dir)
        .sort_by_key(|e| e.depth())
        .into_iter()
        .filter_map(Result::ok)
        .find(|e| e.file_type().is_file() && e.file_name() == name)
        .map(|e| e.into_path())
}

async fn smoke_test(exe: &Path, args: &[String]) -> anyhow::Result<()> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| anyhow!("timed out"))??;
    if !out.status.success() {
        bail!(
            "exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
                .lines()
                .last()
                .unwrap_or("")
        );
    }
    Ok(())
}

/// Atomically re-point `<tool>/current` at `<tool>/<version>`.
fn point_current(tool_dir: &Path, version: &str) -> anyhow::Result<()> {
    let tmp = tool_dir.join(".current.tmp");
    let _ = std::fs::remove_file(&tmp);
    std::os::unix::fs::symlink(version, &tmp)?;
    std::fs::rename(&tmp, tool_dir.join("current"))?;
    Ok(())
}

/// Keep the live version and the newest other one; remove the rest.
fn prune(tool_dir: &Path, live: &str) {
    let Ok(entries) = std::fs::read_dir(tool_dir) else {
        return;
    };
    let mut others: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != live && !n.starts_with('.'))
        .collect();
    others.sort_by(|a, b| {
        if newer_or_equal(a, b) && a != b {
            std::cmp::Ordering::Greater
        } else if a == b {
            std::cmp::Ordering::Equal
        } else {
            std::cmp::Ordering::Less
        }
    });
    others.pop(); // the newest previous version stays as a fallback
    for old in others {
        let _ = std::fs::remove_dir_all(tool_dir.join(old));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Path as AxPath, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::Router;
    use std::collections::HashMap;
    use std::io::Write as _;

    type Files = Arc<StdMutex<HashMap<String, Vec<u8>>>>;

    async fn serve_file(State(files): State<Files>, AxPath(path): AxPath<String>) -> Response {
        match files.lock().unwrap().get(&path) {
            Some(b) => b.clone().into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn server(files: Files) -> String {
        let app = Router::new()
            .route("/{*path}", get(serve_file))
            .with_state(files);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    const OK_TOOL: &[u8] = b"#!/bin/sh\necho \"$0 ok\"\n";
    const BROKEN_TOOL: &[u8] = b"#!/bin/sh\necho broken >&2\nexit 3\n";

    fn sha(b: &[u8]) -> String {
        format!("{:x}", Sha256::digest(b))
    }

    fn zip_of(name: &str, body: &[u8]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        w.start_file(name, opts).unwrap();
        w.write_all(body).unwrap();
        w.finish().unwrap().into_inner()
    }

    fn targz_of(path: &str, body: &[u8]) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tar = tar::Builder::new(gz);
        let mut h = tar::Header::new_gnu();
        h.set_size(body.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        tar.append_data(&mut h, path, body).unwrap();
        tar.into_inner().unwrap().finish().unwrap()
    }

    struct Rig {
        _tmp: tempfile::TempDir,
        base: String,
        files: Files,
        key: ed25519_dalek::SigningKey,
        toolbox: Arc<Toolbox>,
    }

    impl Rig {
        async fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let files: Files = Arc::default();
            let base = server(files.clone()).await;
            let key = signing::generate().unwrap();
            let toolbox = Toolbox::with_parts(
                ToolPaths::new(tmp.path().join("tools")),
                Some(format!("{base}/manifest.json")),
                key.verifying_key(),
                base.clone(),
            )
            .unwrap();
            Self {
                _tmp: tmp,
                base,
                files,
                key,
                toolbox,
            }
        }

        fn put(&self, path: &str, bytes: Vec<u8>) -> String {
            self.files.lock().unwrap().insert(path.into(), bytes);
            format!("{}/{path}", self.base)
        }

        fn publish(&self, manifest: &Value) {
            let bytes = serde_json::to_vec(manifest).unwrap();
            let sig = signing::sign(&self.key, &bytes);
            self.put("manifest.json", bytes);
            self.put("manifest.json.sig", sig.into_bytes());
        }

        fn artifact(&self, path: &str, bytes: Vec<u8>, archive: Option<&str>) -> Value {
            let sum = sha(&bytes);
            json!({"url": self.put(path, bytes), "sha256": sum, "archive": archive})
        }
    }

    use serde_json::{json, Value};

    fn manifest(tools: Value) -> Value {
        json!({"schema": 1, "generated_at": "now", "tools": tools})
    }

    #[tokio::test]
    async fn installs_zip_targz_and_bare_tools_then_goes_live() {
        let rig = Rig::new().await;
        let m = manifest(json!({
            "alpha": {"version": "1.0", "bin": "alpha",
                      "universal": rig.artifact("a.zip", zip_of("alpha", OK_TOOL), Some("zip"))},
            "beta":  {"version": "2.1", "bin": "beta",
                      "universal": rig.artifact("b.tgz", targz_of("beta-2.1/beta", OK_TOOL), Some("tar.gz"))},
            "gamma": {"version": "3", "bin": "gamma",
                      "universal": rig.artifact("gamma", OK_TOOL.to_vec(), None)},
        }));
        rig.publish(&m);
        rig.toolbox.ensure().await.unwrap();

        let report = rig.toolbox.report();
        assert_eq!(report.status.manifest.as_deref(), Some("remote"));
        assert!(report.tools.iter().all(|t| t.ready), "{report:?}");
        for (tool, version) in [("alpha", "1.0"), ("beta", "2.1"), ("gamma", "3")] {
            assert_eq!(
                rig.toolbox.installed_version(tool).as_deref(),
                Some(version)
            );
            let out = std::process::Command::new(rig.toolbox.paths().bin(tool, tool))
                .output()
                .unwrap();
            assert!(out.status.success(), "{tool} runs");
        }
        assert!(
            rig.toolbox
                .paths()
                .root()
                .join("manifest.json.sig")
                .exists(),
            "verified copy cached"
        );
        // Nothing to do the second time.
        rig.toolbox.ensure().await.unwrap();
    }

    #[tokio::test]
    async fn a_bad_download_or_broken_tool_never_replaces_the_live_one() {
        let rig = Rig::new().await;
        let good = rig.artifact("a1", OK_TOOL.to_vec(), None);
        rig.publish(&manifest(
            json!({"alpha": {"version": "1.0", "bin": "alpha", "universal": good}}),
        ));
        rig.toolbox.ensure().await.unwrap();

        // Wrong checksum.
        let mut tampered = rig.artifact("a2", OK_TOOL.to_vec(), None);
        tampered["sha256"] = json!("00".repeat(32));
        rig.publish(&manifest(
            json!({"alpha": {"version": "2.0", "bin": "alpha", "universal": tampered}}),
        ));
        let err = rig.toolbox.ensure().await.unwrap_err();
        assert!(format!("{err:#}").contains("checksum mismatch"), "{err:#}");
        assert_eq!(
            rig.toolbox.installed_version("alpha").as_deref(),
            Some("1.0")
        );

        // Downloads fine but doesn't run.
        let broken = rig.artifact("a3", BROKEN_TOOL.to_vec(), None);
        rig.publish(&manifest(
            json!({"alpha": {"version": "3.0", "bin": "alpha", "universal": broken}}),
        ));
        let err = rig.toolbox.ensure().await.unwrap_err();
        assert!(format!("{err:#}").contains("didn't run"), "{err:#}");
        assert_eq!(
            rig.toolbox.installed_version("alpha").as_deref(),
            Some("1.0")
        );
        assert!(!rig.toolbox.paths().root().join("alpha/3.0").exists());
        assert!(
            rig.toolbox.report().status.error.is_some(),
            "shown to the app"
        );
    }

    #[tokio::test]
    async fn network_failures_are_told_apart_from_bad_downloads() {
        // Nothing listens on port 1: a refused connection.
        let refused = reqwest::get("http://127.0.0.1:1/ffmpeg.zip").await.unwrap_err();
        let err = anyhow::Error::new(refused).context("downloading http://127.0.0.1:1/ffmpeg.zip");
        assert_eq!(network_host(&err).as_deref(), Some("127.0.0.1"));
        assert_eq!(
            network_host(&anyhow!("download stalled: https://github.com/x/y")).as_deref(),
            Some("github.com")
        );
        assert_eq!(network_host(&anyhow!("checksum mismatch for https://github.com/x")), None);
    }

    #[tokio::test]
    async fn a_tampered_manifest_falls_back_to_the_last_verified_one() {
        let rig = Rig::new().await;
        let good = manifest(json!({"alpha": {"version": "1.0", "bin": "alpha",
                                   "universal": rig.artifact("a1", OK_TOOL.to_vec(), None)}}));
        rig.publish(&good);
        rig.toolbox.ensure().await.unwrap();

        let evil = manifest(json!({"alpha": {"version": "6.6.6", "bin": "alpha",
                                   "universal": rig.artifact("evil", OK_TOOL.to_vec(), None)}}));
        rig.put("manifest.json", serde_json::to_vec(&evil).unwrap()); // old signature
        let loaded = rig.toolbox.load_manifest().await;
        assert_eq!(loaded.tools["alpha"].version, "1.0");
        assert_eq!(
            rig.toolbox.report().status.manifest.as_deref(),
            Some("cached")
        );
    }

    #[tokio::test]
    async fn without_any_manifest_the_built_in_one_is_used() {
        let tmp = tempfile::tempdir().unwrap();
        let toolbox = Toolbox::new(ToolPaths::new(tmp.path().into()), None).unwrap();
        let m = toolbox.load_manifest().await;
        for tool in ["yt-dlp", "deno", "uv", "ffmpeg"] {
            assert!(
                m.tools[tool].artifact().is_some(),
                "{tool} has a build for this Mac"
            );
        }
        assert_eq!(m.python.venvs["spotdl"], vec!["spotdl==4.6.0".to_string()]);
        assert_eq!(
            toolbox.report().status.manifest.as_deref(),
            Some("built-in")
        );
    }

    #[tokio::test]
    async fn auto_update_moves_forward_only() {
        let rig = Rig::new().await;
        let rule = "github-release:o/r:tool_macos:SUMS";
        rig.publish(&manifest(
            json!({"tool": {"version": "2026.1.5", "bin": "tool",
            "universal": rig.artifact("t1", OK_TOOL.to_vec(), None), "auto_update": rule}}),
        ));
        rig.toolbox.ensure().await.unwrap();

        let release = |tag: &str| {
            let url = rig.put(&format!("dl/{tag}/tool_macos"), OK_TOOL.to_vec());
            let sums = rig.put(
                &format!("dl/{tag}/SUMS"),
                format!("{}  other\n{}  tool_macos\n", "11".repeat(32), sha(OK_TOOL)).into_bytes(),
            );
            rig.put(
                "repos/o/r/releases/latest",
                serde_json::to_vec(&json!({"tag_name": tag, "assets": [
                    {"name": "tool_macos", "browser_download_url": url},
                    {"name": "SUMS", "browser_download_url": sums}]}))
                .unwrap(),
            );
        };
        release("2026.1.12");
        assert_eq!(
            rig.toolbox.update_auto().await.unwrap(),
            vec!["tool 2026.1.12"]
        );
        assert_eq!(
            rig.toolbox.installed_version("tool").as_deref(),
            Some("2026.1.12")
        );
        assert!(
            rig.toolbox.paths().root().join("tool/2026.1.5").exists(),
            "previous kept"
        );

        release("2026.1.12");
        assert!(
            rig.toolbox.update_auto().await.unwrap().is_empty(),
            "same version"
        );
        release("2025.12.30");
        assert!(
            rig.toolbox.update_auto().await.unwrap().is_empty(),
            "never downgrades"
        );
        // The manifest's older pin doesn't pull it back either.
        rig.toolbox.ensure().await.unwrap();
        assert_eq!(
            rig.toolbox.installed_version("tool").as_deref(),
            Some("2026.1.12")
        );
    }

    /// `TOOLBOX_E2E_ROOT=<dir> cargo test real_install -- --ignored`
    #[tokio::test]
    #[ignore = "downloads ~300 MB from the real sources"]
    async fn real_install_from_the_built_in_manifest() {
        let root = PathBuf::from(std::env::var("TOOLBOX_E2E_ROOT").expect("TOOLBOX_E2E_ROOT"));
        let toolbox = Toolbox::new(ToolPaths::new(root), None).unwrap();
        toolbox.ensure().await.unwrap();
        let report = toolbox.report();
        assert!(
            report.tools.iter().chain(&report.venvs).all(|t| t.ready),
            "{report:#?}"
        );
        let p = toolbox.paths();
        for (exe, arg) in [
            (p.bin("yt-dlp", "yt-dlp"), "--version"),
            (p.bin("deno", "deno"), "--version"),
            (p.bin("uv", "uv"), "--version"),
            (p.bin("ffmpeg", "ffmpeg"), "-version"),
            (p.venv("spotdl").join("bin/spotdl"), "--version"),
        ] {
            let out = std::process::Command::new(&exe).arg(arg).output().unwrap();
            let first = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            assert!(out.status.success(), "{} failed", exe.display());
            eprintln!("{}: {first}", exe.display());
        }
    }

    #[test]
    fn versions_and_names() {
        assert!(newer_or_equal("2026.10.26", "2026.10.3"));
        assert!(!newer_or_equal("2026.9.30", "2026.10.1"));
        assert!(newer_or_equal("v2.9.8", "2.9.8"));
        assert!(safe_component("2026.10.26") && safe_component("yt-dlp"));
        assert!(!safe_component("..") && !safe_component("a/b") && !safe_component(".hidden"));
    }
}
