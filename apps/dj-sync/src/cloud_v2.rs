//! Cloud lane, protocol v2: the shared, multi-tenant Worker
//! (`apps/dj-sync-cloud` ≥ 1.0.0; spec
//! `docs/superpowers/specs/2026-10-28-dj-sync-public-distribution-design.md` §3).
//!
//! - **No account.** On first start this Mac registers (`POST /v2/register`)
//!   and keeps `{tenant_id, agent_token}` in `~/.dj-sync/cloud.json` (0600).
//! - **Links.** Each assistant (ChatGPT, Claude, the iOS Shortcut) reaches the
//!   Mac through its own revocable link URL. The cloud stores only hashes, so
//!   the URLs live in `~/.dj-sync/links.json` (0600) for the menu app's Copy.
//! - **One WebSocket** to this DJ's Durable Object. Jobs are pushed the moment
//!   an assistant asks; results go back on the same socket and stay pending
//!   (see `AgentCore`) until the Worker acks them, so a dropped connection
//!   resends instead of losing them.

use std::collections::HashSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{watch, Mutex, RwLock};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::{debug, error, info, warn};

use crate::agent_core::{AgentCore, ClaimedJob, Completion};
use crate::cloud::{PROTOCOL_HEADER, VERSION_HEADER};
use crate::config::CloudCfg;
use crate::jobs::JobQueue;
use crate::rekordbox_db::RekordboxLibrary;

/// Bump MAJOR for breaking changes to the v2 agent API, MINOR for additions
/// the agent relies on. Must stay in step with the Worker's.
pub const AGENT_PROTOCOL_V2: &str = "2.0.0";

const TENANT_HEADER: &str = "x-dj-sync-tenant";
const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug)]
pub enum CloudError {
    /// The Worker doesn't know this Mac's token (e.g. purged after 90 days).
    Unauthorized,
    /// Protocol MAJOR mismatch (or our MINOR is newer): wait for an update.
    Incompatible(String),
    /// Over a per-DJ or registration limit.
    Limited(String),
    /// Another connection took over this DJ's socket.
    Replaced,
    /// The cloud refused the request itself (bad kind, too many links, …):
    /// pass its status and message on.
    Rejected(StatusCode, String),
    /// Offline, DNS, 5xx, …: back off and retry.
    Transient(anyhow::Error),
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudError::Unauthorized => write!(f, "the cloud doesn't recognise this Mac"),
            CloudError::Incompatible(b) => write!(f, "incompatible cloud protocol: {b}"),
            CloudError::Limited(b) => write!(f, "over a DJ Sync limit: {b}"),
            CloudError::Replaced => write!(f, "another connection replaced this one"),
            CloudError::Rejected(_, msg) => write!(f, "{msg}"),
            CloudError::Transient(e) => write!(f, "{e:#}"),
        }
    }
}

impl From<reqwest::Error> for CloudError {
    fn from(e: reqwest::Error) -> Self {
        CloudError::Transient(e.into())
    }
}

impl From<anyhow::Error> for CloudError {
    fn from(e: anyhow::Error) -> Self {
        CloudError::Transient(e)
    }
}

/// What registration gave this Mac (`~/.dj-sync/cloud.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Credentials {
    pub base_url: String,
    pub tenant_id: String,
    pub agent_token: String,
}

/// An assistant's way in. `url` is known only on this Mac (and to the
/// assistant it was pasted into).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Shortcut links: the REST endpoint and its bearer token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// This Mac's identity with the shared Worker, shared by the lane and the
/// menu app's `/local/links` routes.
pub struct CloudSession {
    http: reqwest::Client,
    base: String,
    dir: PathBuf,
    creds: RwLock<Option<Credentials>>,
    /// Serialises `cloud.json` / `links.json` rewrites.
    files: Mutex<()>,
    connected: AtomicBool,
}

impl CloudSession {
    /// `dir` is `~/.dj-sync`. Loads `cloud.json` if it was made for `base_url`.
    pub fn new(base_url: &str, dir: PathBuf) -> anyhow::Result<Arc<Self>> {
        let base = base_url.trim_end_matches('/').to_string();
        anyhow::ensure!(
            base.starts_with("https://") || base.starts_with("http://127.0.0.1"),
            "cloud.base_url must be https (got {base})"
        );
        let creds = read_json::<Credentials>(&dir.join("cloud.json"))
            .and_then(|c| adopt_credentials(c, &base, &dir));
        Ok(Arc::new(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("dj-sync/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(30))
                .build()
                .context("building http client")?,
            base,
            dir,
            creds: RwLock::new(creds),
            files: Mutex::new(()),
            connected: AtomicBool::new(false),
        }))
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub async fn tenant_id(&self) -> Option<String> {
        self.creds
            .read()
            .await
            .as_ref()
            .map(|c| c.tenant_id.clone())
    }

    /// Credentials, registering this Mac first if it never has.
    pub async fn ensure_registered(&self) -> Result<Credentials, CloudError> {
        if let Some(c) = self.creds.read().await.clone() {
            return Ok(c);
        }
        let mut slot = self.creds.write().await;
        if let Some(c) = slot.clone() {
            return Ok(c);
        }
        let res = self
            .http
            .post(format!("{}/v2/register", self.base))
            .json(&json!({
                "agent_version": AGENT_VERSION,
                "protocol": AGENT_PROTOCOL_V2,
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
            }))
            .send()
            .await?;
        let res = check(res).await?;
        #[derive(Deserialize)]
        struct Registered {
            tenant_id: String,
            agent_token: String,
            #[serde(default)]
            worker_version: Option<String>,
        }
        let r: Registered = res.json().await.context("parsing registration")?;
        let creds = Credentials {
            base_url: self.base.clone(),
            tenant_id: r.tenant_id,
            agent_token: r.agent_token,
        };
        {
            let _files = self.files.lock().await;
            write_private_json(&self.dir.join("cloud.json"), &creds)?;
        }
        info!(
            tenant = %creds.tenant_id,
            worker = r.worker_version.as_deref().unwrap_or("?"),
            "registered this Mac with DJ Sync cloud"
        );
        *slot = Some(creds.clone());
        Ok(creds)
    }

    /// Drop this Mac's identity (and its now-dead links); the next
    /// `ensure_registered` starts over.
    pub async fn forget_registration(&self) {
        let mut slot = self.creds.write().await;
        let _files = self.files.lock().await;
        for f in ["cloud.json", "links.json"] {
            let _ = std::fs::remove_file(self.dir.join(f));
        }
        *slot = None;
    }

    async fn agent_request(
        &self,
        method: Method,
        path: &str,
    ) -> Result<reqwest::RequestBuilder, CloudError> {
        let c = self.ensure_registered().await?;
        Ok(self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&c.agent_token)
            .header(TENANT_HEADER, &c.tenant_id)
            .header(PROTOCOL_HEADER, AGENT_PROTOCOL_V2)
            .header(VERSION_HEADER, AGENT_VERSION))
    }

    // ---------- links ----------

    /// The cloud's list, with each URL this Mac still knows filled in.
    pub async fn list_links(&self) -> Result<Vec<Link>, CloudError> {
        let res = self
            .agent_request(Method::GET, "/v2/agent/links")
            .await?
            .send()
            .await?;
        let mut links: Vec<Link> = check(res).await?.json().await.context("parsing links")?;
        let _files = self.files.lock().await;
        let mut known = self.local_links();
        known.retain(|k| links.iter().any(|l| l.id == k.id));
        for l in &mut links {
            if let Some(k) = known.iter().find(|k| k.id == l.id) {
                l.url = k.url.clone();
                l.api_url = k.api_url.clone();
                l.token = k.token.clone();
            }
        }
        write_private_json(&self.links_path(), &known)?;
        Ok(links)
    }

    pub async fn create_link(&self, kind: &str, label: Option<&str>) -> Result<Link, CloudError> {
        let res = self
            .agent_request(Method::POST, "/v2/agent/links")
            .await?
            .json(&json!({ "kind": kind, "label": label }))
            .send()
            .await?;
        let link: Link = check(res).await?.json().await.context("parsing link")?;
        self.remember(link.clone()).await?;
        info!(link = %link.id, kind = %link.kind, "created assistant link");
        Ok(link)
    }

    pub async fn rotate_link(&self, id: &str) -> Result<Link, CloudError> {
        let res = self
            .agent_request(Method::POST, &format!("/v2/agent/links/{id}/rotate"))
            .await?
            .send()
            .await?;
        let body: Value = check(res)
            .await?
            .json()
            .await
            .context("parsing rotated link")?;
        let text = |k: &str| body[k].as_str().map(String::from);
        let mut link = {
            let _files = self.files.lock().await;
            self.local_links().into_iter().find(|l| l.id == id)
        }
        .unwrap_or(Link {
            id: id.to_string(),
            kind: text("kind").unwrap_or_else(|| "other".into()),
            label: text("label"),
            created_at: text("created_at"),
            last_used_at: None,
            url: None,
            api_url: None,
            token: None,
        });
        link.url = text("url");
        link.last_used_at = None;
        // Shortcut links get a new bearer token with the new secret.
        if let Some(token) = text("token") {
            link.token = Some(token);
            link.api_url = text("api_url").or(link.api_url);
        }
        self.remember(link.clone()).await?;
        info!(link = %id, "rotated assistant link");
        Ok(link)
    }

    pub async fn delete_link(&self, id: &str) -> Result<(), CloudError> {
        let res = self
            .agent_request(Method::DELETE, &format!("/v2/agent/links/{id}"))
            .await?
            .send()
            .await?;
        if res.status() != StatusCode::NOT_FOUND {
            check(res).await?;
        }
        let _files = self.files.lock().await;
        let mut known = self.local_links();
        known.retain(|l| l.id != id);
        write_private_json(&self.links_path(), &known)?;
        info!(link = %id, "disconnected assistant link");
        Ok(())
    }

    fn links_path(&self) -> PathBuf {
        self.dir.join("links.json")
    }

    fn local_links(&self) -> Vec<Link> {
        read_json(&self.links_path()).unwrap_or_default()
    }

    async fn remember(&self, link: Link) -> anyhow::Result<()> {
        let _files = self.files.lock().await;
        let mut known = self.local_links();
        known.retain(|l| l.id != link.id);
        known.push(link);
        write_private_json(&self.links_path(), &known)
    }

    // ---------- library ----------

    pub async fn upload_library(&self, upload: &Value) -> Result<(), CloudError> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&serde_json::to_vec(upload).context("encoding snapshot")?)
            .context("compressing snapshot")?;
        let body = gz.finish().context("compressing snapshot")?;
        let size = body.len();
        let res = self
            .agent_request(Method::PUT, "/v2/agent/library")
            .await?
            .timeout(Duration::from_secs(120))
            .header("content-type", "application/json")
            .header("content-encoding", "gzip")
            .body(body)
            .send()
            .await?;
        check(res).await?;
        info!(hash = %upload["hash"].as_str().unwrap_or("?"), bytes = size, "shared library snapshot");
        Ok(())
    }

    // ---------- socket ----------

    async fn connect(&self) -> Result<Ws, CloudError> {
        let c = self.ensure_registered().await?;
        let url = if let Some(rest) = self.base.strip_prefix("https://") {
            format!("wss://{rest}/v2/agent")
        } else {
            format!("ws://{}/v2/agent", self.base.trim_start_matches("http://"))
        };
        let mut req = url
            .into_client_request()
            .context("building socket request")?;
        let h = req.headers_mut();
        for (name, value) in [
            ("authorization", format!("Bearer {}", c.agent_token)),
            (TENANT_HEADER, c.tenant_id.clone()),
            (PROTOCOL_HEADER, AGENT_PROTOCOL_V2.to_string()),
            (VERSION_HEADER, AGENT_VERSION.to_string()),
        ] {
            h.insert(name, value.parse().context("socket header")?);
        }
        let connecting = tokio_tungstenite::connect_async(req);
        match tokio::time::timeout(Duration::from_secs(30), connecting).await {
            Err(_) => Err(CloudError::Transient(anyhow!(
                "timed out connecting to the cloud"
            ))),
            Ok(Ok((ws, _))) => Ok(ws),
            Ok(Err(tokio_tungstenite::tungstenite::Error::Http(res))) => {
                let body = res
                    .body()
                    .as_ref()
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default();
                Err(classify(res.status(), body))
            }
            Ok(Err(e)) => Err(CloudError::Transient(e.into())),
        }
    }
}

/// Hostnames of the same cloud (one Worker, one set of DJs): DJ Sync moved
/// from mcp.triplejmusic.art to djsync.jeffrey.build, and both still serve.
const SAME_CLOUD: [&str; 2] = [
    "https://djsync.jeffrey.build",
    "https://mcp.triplejmusic.art",
];

/// Saved credentials for `base`. Ones made on another hostname of the same
/// cloud are carried over (and the saved link URLs re-pointed) instead of
/// registering again, which would replace every assistant link.
fn adopt_credentials(mut c: Credentials, base: &str, dir: &Path) -> Option<Credentials> {
    if c.base_url == base {
        return Some(c);
    }
    if !(SAME_CLOUD.contains(&c.base_url.as_str()) && SAME_CLOUD.contains(&base)) {
        return None;
    }
    let old = format!("{}/", c.base_url);
    c.base_url = base.to_string();
    if let Err(e) = write_private_json(&dir.join("cloud.json"), &c) {
        warn!(error = %format!("{e:#}"), "couldn't update cloud.json for the new hostname");
    }
    let links_path = dir.join("links.json");
    if let Some(mut links) = read_json::<Vec<Link>>(&links_path) {
        for l in &mut links {
            for url in [&mut l.url, &mut l.api_url].into_iter().flatten() {
                if let Some(rest) = url.strip_prefix(&old) {
                    *url = format!("{base}/{rest}");
                }
            }
        }
        if let Err(e) = write_private_json(&links_path, &links) {
            warn!(error = %format!("{e:#}"), "couldn't update links.json for the new hostname");
        }
    }
    info!(from = %old.trim_end_matches('/'), to = base, "DJ Sync cloud moved hosts; kept this Mac's identity and links");
    Some(c)
}

async fn check(res: reqwest::Response) -> Result<reqwest::Response, CloudError> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    Err(classify(status, res.text().await.unwrap_or_default()))
}

fn classify(status: StatusCode, body: String) -> CloudError {
    let snippet: String = body.chars().take(300).collect();
    match status {
        StatusCode::UNAUTHORIZED => CloudError::Unauthorized,
        StatusCode::CONFLICT if body.contains("incompatible_protocol") => {
            CloudError::Incompatible(snippet)
        }
        StatusCode::TOO_MANY_REQUESTS => CloudError::Limited(snippet),
        s if s.is_client_error() => {
            let msg = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| {
                    v["message"]
                        .as_str()
                        .or(v["error"].as_str())
                        .map(String::from)
                })
                .unwrap_or(snippet);
            CloudError::Rejected(s, msg)
        }
        _ => CloudError::Transient(anyhow!("cloud returned {status}: {snippet}")),
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Atomic write, readable only by this user.
fn write_private_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .with_context(|| format!("writing {}", tmp.display()))?;
    f.write_all(&serde_json::to_vec_pretty(value)?)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

// ---------- the lane ----------

/// How often things happen; shortened in tests.
#[derive(Debug, Clone)]
pub struct LaneTiming {
    pub ping: Duration,
    pub tick: Duration,
    pub extend: Duration,
    pub library_check: Duration,
    pub min_backoff: Duration,
    pub max_backoff: Duration,
    pub slow_retry: Duration,
    pub replaced_retry: Duration,
    /// Consecutive 401s before this Mac re-registers (a single one could be
    /// a cloud hiccup, and re-registering changes every assistant link).
    pub unauthorized_before_reregister: u32,
}

impl LaneTiming {
    pub fn from_cfg(cfg: &CloudCfg) -> Self {
        Self {
            ping: Duration::from_secs(cfg.ping_secs.max(10)),
            tick: Duration::from_secs(1),
            extend: Duration::from_secs(300),
            library_check: Duration::from_secs(15),
            min_backoff: Duration::from_secs(2),
            max_backoff: Duration::from_secs(300),
            slow_retry: Duration::from_secs(600),
            replaced_retry: Duration::from_secs(60),
            unauthorized_before_reregister: 3,
        }
    }
}

enum Ended {
    Shutdown,
    Dropped,
}

/// Run the lane until shutdown: register if needed, hold the socket, and
/// reconnect with backoff.
pub async fn run(
    cfg: CloudCfg,
    session: Arc<CloudSession>,
    jobs: JobQueue,
    library: Option<Arc<RekordboxLibrary>>,
    shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    run_with(LaneTiming::from_cfg(&cfg), session, jobs, library, shutdown).await
}

pub async fn run_with(
    t: LaneTiming,
    session: Arc<CloudSession>,
    jobs: JobQueue,
    library: Option<Arc<RekordboxLibrary>>,
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let mut core = AgentCore::new(jobs, None).with_library(library);
    let mut delay = Duration::ZERO;
    let mut offline_since: Option<Instant> = None;
    let mut unauthorized = 0u32;
    info!(base = %session.base, protocol = AGENT_PROTOCOL_V2, "cloud lane (v2) starting");

    loop {
        tokio::select! {
            _ = stopped(&mut shutdown) => return Ok(()),
            _ = tokio::time::sleep(delay) => {}
        }
        let started = Instant::now();
        let outcome = match session.connect().await {
            Ok(ws) => {
                session.connected.store(true, Ordering::Relaxed);
                if let Some(since) = offline_since.take() {
                    info!(after = ?since.elapsed(), "cloud reachable again");
                } else {
                    info!("connected to DJ Sync cloud");
                }
                let r = connection(ws, &session, &mut core, &t, &mut shutdown).await;
                session.connected.store(false, Ordering::Relaxed);
                r
            }
            Err(e) => Err(e),
        };
        // Only back-to-back rejections count (the cloud may also reject
        // right after the upgrade, with close code 4001).
        if !matches!(outcome, Err(CloudError::Unauthorized)) {
            unauthorized = 0;
        }
        delay = match outcome {
            Ok(Ended::Shutdown) => return Ok(()),
            Ok(Ended::Dropped) => {
                debug!("cloud socket closed; reconnecting");
                if started.elapsed() > t.ping * 2 {
                    t.min_backoff
                } else {
                    (delay * 2).clamp(t.min_backoff, t.max_backoff)
                }
            }
            Err(CloudError::Unauthorized) => {
                unauthorized += 1;
                if unauthorized >= t.unauthorized_before_reregister {
                    warn!("the cloud no longer recognises this Mac; registering again (assistant links change)");
                    session.forget_registration().await;
                    unauthorized = 0;
                    t.min_backoff
                } else {
                    warn!(
                        attempt = unauthorized,
                        "cloud rejected this Mac's token; retrying"
                    );
                    (delay * 2).clamp(t.min_backoff * 4, t.max_backoff)
                }
            }
            Err(CloudError::Incompatible(body)) => {
                error!(
                    agent_protocol = AGENT_PROTOCOL_V2,
                    agent_version = AGENT_VERSION,
                    worker = %body,
                    "cloud speaks an incompatible protocol; waiting for an update"
                );
                t.slow_retry
            }
            Err(CloudError::Limited(body)) => {
                warn!(detail = %body, "over a DJ Sync cloud limit; backing off");
                t.slow_retry
            }
            Err(CloudError::Replaced) => {
                warn!("another connection took over this Mac's DJ Sync identity");
                t.replaced_retry
            }
            Err(CloudError::Rejected(status, msg)) => {
                warn!(%status, detail = %msg, "cloud refused the connection");
                t.slow_retry
            }
            Err(CloudError::Transient(e)) => {
                if offline_since.is_none() {
                    warn!(error = %format!("{e:#}"), "cloud unreachable; will keep retrying");
                    offline_since = Some(Instant::now());
                }
                (delay * 2).clamp(t.min_backoff, t.max_backoff)
            }
        };
    }
}

/// Resolves once shutdown is signalled (without holding the watch guard
/// across the select arm's awaits, which would make the lane `!Send`).
async fn stopped(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|s| *s).await;
}

async fn send(ws: &mut Ws, v: Value) -> Result<(), CloudError> {
    ws.send(Message::text(v.to_string()))
        .await
        .map_err(|e| CloudError::Transient(e.into()))
}

/// One socket's life: hello → (job → complete → ack)* until it closes.
async fn connection(
    mut ws: Ws,
    session: &CloudSession,
    core: &mut AgentCore,
    t: &LaneTiming,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Ended, CloudError> {
    core.refresh_library().await;
    let mut hash_sent = core.library_hash();
    let mut ready_sent = core.is_idle();
    send(
        &mut ws,
        json!({
            "type": "hello",
            "protocol": AGENT_PROTOCOL_V2,
            "agent_version": AGENT_VERSION,
            "active": core.active_ids(),
            "can_claim": ready_sent,
            "library_hash": hash_sent,
        }),
    )
    .await?;

    // Results sent on this socket and not acked yet (resent on the next one).
    let mut awaiting_ack: HashSet<String> = HashSet::new();
    let mut last_heard = Instant::now();
    let start = tokio::time::Instant::now();
    let mut tick = tokio::time::interval(t.tick);
    let mut ping = tokio::time::interval_at(start + t.ping, t.ping);
    let mut extend = tokio::time::interval_at(start + t.extend, t.extend);
    let mut library = tokio::time::interval_at(start + t.library_check, t.library_check);

    loop {
        tokio::select! {
            _ = stopped(shutdown) => {
                let _ = ws.close(None).await;
                return Ok(Ended::Shutdown);
            }
            msg = ws.next() => {
                let msg = match msg {
                    None => return Ok(Ended::Dropped),
                    Some(Err(e)) => return Err(CloudError::Transient(e.into())),
                    Some(Ok(m)) => m,
                };
                last_heard = Instant::now();
                let text = match msg {
                    Message::Text(text) => text,
                    Message::Close(frame) => return closed(frame),
                    _ => continue,
                };
                if text.as_str() == "pong" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else {
                    warn!("ignoring a malformed message from the cloud");
                    continue;
                };
                match v["type"].as_str().unwrap_or_default() {
                    "welcome" => {
                        debug!(worker = %v["worker_version"], "cloud says hello");
                        if v["library_wanted"] == true {
                            share_library(session, core).await;
                        }
                    }
                    "job" => match serde_json::from_value::<ClaimedJob>(v) {
                        Ok(job) => {
                            ready_sent = false;
                            core.start(job);
                            report(&mut ws, core, &mut awaiting_ack).await?;
                        }
                        Err(e) => warn!(error = %e, "ignoring a malformed job from the cloud"),
                    },
                    "ack" => {
                        if let Some(id) = v["job_id"].as_str() {
                            awaiting_ack.remove(id);
                            core.reported(id);
                            // After a playlist change, share the new library now.
                            core.refresh_library().await;
                            let hash = core.library_hash();
                            if hash.is_some() && hash != hash_sent {
                                send(&mut ws, json!({ "type": "library_hash", "hash": hash })).await?;
                                hash_sent = hash;
                            }
                        }
                    }
                    "library_wanted" => share_library(session, core).await,
                    "error" => warn!(code = %v["code"], message = %v["message"], "cloud reported an error"),
                    other => debug!(kind = other, "ignoring an unknown cloud message"),
                }
                if core.is_idle() && !ready_sent {
                    send(&mut ws, json!({ "type": "ready" })).await?;
                    ready_sent = true;
                }
            }
            _ = tick.tick() => {
                report(&mut ws, core, &mut awaiting_ack).await?;
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > t.ping * 3 {
                    return Err(CloudError::Transient(anyhow!("cloud socket went quiet")));
                }
                ws.send(Message::text("ping")).await.map_err(|e| CloudError::Transient(e.into()))?;
            }
            _ = extend.tick() => {
                let active = core.active_ids();
                if !active.is_empty() {
                    send(&mut ws, json!({ "type": "extend", "active": active })).await?;
                }
            }
            _ = library.tick() => {
                core.refresh_library().await;
                let hash = core.library_hash();
                if hash.is_some() && hash != hash_sent {
                    send(&mut ws, json!({ "type": "library_hash", "hash": hash })).await?;
                    hash_sent = hash;
                }
            }
        }
    }
}

/// Send each reportable result once per socket.
async fn report(
    ws: &mut Ws,
    core: &AgentCore,
    awaiting_ack: &mut HashSet<String>,
) -> Result<(), CloudError> {
    for (cloud_id, result) in core.finished() {
        if awaiting_ack.contains(&cloud_id) {
            continue;
        }
        send(ws, completion(&cloud_id, &result)).await?;
        info!(cloud_job = %cloud_id, state = result.state, "reported cloud job result");
        awaiting_ack.insert(cloud_id);
    }
    Ok(())
}

fn completion(cloud_id: &str, result: &Completion) -> Value {
    let mut v = serde_json::to_value(result).unwrap_or_else(|_| json!({}));
    v["type"] = json!("complete");
    v["job_id"] = json!(cloud_id);
    v
}

async fn share_library(session: &CloudSession, core: &AgentCore) {
    let Some((_, upload)) = core.library_upload() else {
        return;
    };
    if let Err(e) = session.upload_library(&upload).await {
        warn!(error = %e, "couldn't share the library snapshot; will retry when asked again");
    }
}

fn closed(
    frame: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>,
) -> Result<Ended, CloudError> {
    let Some(frame) = frame else {
        return Ok(Ended::Dropped);
    };
    let reason = frame.reason.to_string();
    match frame.code {
        CloseCode::Library(4001) => Err(CloudError::Unauthorized),
        CloseCode::Library(4009) => Err(CloudError::Incompatible(reason)),
        CloseCode::Library(4010) => Err(CloudError::Replaced),
        CloseCode::Library(4029) => Err(CloudError::Limited(reason)),
        _ => Ok(Ended::Dropped),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DownloadCfg;
    use crate::downloader::Fetcher;
    use crate::MediaRef;
    use axum::extract::ws::{CloseFrame, Message as AxMsg, WebSocket, WebSocketUpgrade};
    use axum::extract::{Path as AxPath, State};
    use axum::http::HeaderMap;
    use axum::response::{IntoResponse, Response};
    use axum::routing::{delete, get, post, put};
    use axum::{Json, Router};
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct Fake {
        registrations: u32,
        token: String,
        tenant: String,
        connects: u32,
        /// Close the next N sockets with 4001 right after they open.
        reject_connects: u32,
        /// Drop the socket after the first `complete` instead of acking it.
        drop_first_complete: bool,
        queued: Vec<Value>,
        hellos: Vec<Value>,
        completed: Vec<Value>,
        readies: u32,
        uploads: Vec<Value>,
        library_hash: Option<String>,
        links: Vec<Value>,
        next_link: u32,
    }
    type Shared = Arc<StdMutex<Fake>>;

    async fn register(State(s): State<Shared>) -> Response {
        let mut f = s.lock().unwrap();
        f.registrations += 1;
        f.tenant = format!("tenant{}", f.registrations);
        f.token = format!("djsa_token{}", f.registrations);
        (
            StatusCode::CREATED,
            Json(json!({"tenant_id": f.tenant, "agent_token": f.token, "worker_version": "1.0.0"})),
        )
            .into_response()
    }

    fn authorised(f: &Fake, h: &HeaderMap) -> bool {
        let bearer = format!("Bearer {}", f.token);
        h.get("authorization").and_then(|v| v.to_str().ok()) == Some(bearer.as_str())
            && h.get(TENANT_HEADER).and_then(|v| v.to_str().ok()) == Some(f.tenant.as_str())
            && h.get(PROTOCOL_HEADER).and_then(|v| v.to_str().ok()) == Some(AGENT_PROTOCOL_V2)
    }

    async fn agent(State(s): State<Shared>, h: HeaderMap, ws: WebSocketUpgrade) -> Response {
        let reject = {
            let mut f = s.lock().unwrap();
            if !authorised(&f, &h) {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            f.connects += 1;
            let reject = f.reject_connects > 0;
            if reject {
                f.reject_connects -= 1;
            }
            reject
        };
        ws.on_upgrade(move |socket| socket_loop(socket, s, reject))
    }

    async fn push_job(socket: &mut WebSocket, s: &Shared) {
        let job = {
            let mut f = s.lock().unwrap();
            (!f.queued.is_empty()).then(|| f.queued.remove(0))
        };
        if let Some(mut job) = job {
            job["type"] = json!("job");
            let _ = socket.send(AxMsg::Text(job.to_string().into())).await;
        }
    }

    async fn socket_loop(mut socket: WebSocket, s: Shared, reject: bool) {
        if reject {
            let _ = socket
                .send(AxMsg::Close(Some(CloseFrame {
                    code: 4001,
                    reason: "unauthorized".into(),
                })))
                .await;
            return;
        }
        while let Some(Ok(msg)) = socket.recv().await {
            let AxMsg::Text(text) = msg else { continue };
            if text.as_str() == "ping" {
                let _ = socket.send(AxMsg::Text("pong".into())).await;
                continue;
            }
            let v: Value = serde_json::from_str(text.as_str()).unwrap();
            match v["type"].as_str().unwrap() {
                "hello" => {
                    let wanted = {
                        let mut f = s.lock().unwrap();
                        f.hellos.push(v.clone());
                        v["library_hash"].as_str().is_some()
                            && v["library_hash"].as_str() != f.library_hash.as_deref()
                    };
                    let welcome = json!({"type": "welcome", "worker_version": "1.0.0",
                                         "protocol": "2.0.0", "library_wanted": wanted});
                    let _ = socket.send(AxMsg::Text(welcome.to_string().into())).await;
                    if v["can_claim"] == true {
                        push_job(&mut socket, &s).await;
                    }
                }
                "ready" => {
                    s.lock().unwrap().readies += 1;
                    push_job(&mut socket, &s).await;
                }
                "complete" => {
                    let drop_it = {
                        let mut f = s.lock().unwrap();
                        f.completed.push(v.clone());
                        std::mem::take(&mut f.drop_first_complete)
                    };
                    if drop_it {
                        return; // vanish without an ack
                    }
                    let ack = json!({"type": "ack", "job_id": v["job_id"]});
                    let _ = socket.send(AxMsg::Text(ack.to_string().into())).await;
                }
                _ => {}
            }
        }
    }

    async fn library(State(s): State<Shared>, h: HeaderMap, body: axum::body::Bytes) -> StatusCode {
        let mut f = s.lock().unwrap();
        if !authorised(&f, &h) || h.get("content-encoding").map(|v| v.as_bytes()) != Some(b"gzip") {
            return StatusCode::BAD_REQUEST;
        }
        let mut json = Vec::new();
        std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&body[..]), &mut json)
            .unwrap();
        let v: Value = serde_json::from_slice(&json).unwrap();
        f.library_hash = v["hash"].as_str().map(String::from);
        f.uploads.push(v);
        StatusCode::NO_CONTENT
    }

    async fn list_links(State(s): State<Shared>, h: HeaderMap) -> Response {
        let f = s.lock().unwrap();
        if !authorised(&f, &h) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        Json(json!(f.links)).into_response()
    }

    async fn create_link(
        State(s): State<Shared>,
        h: HeaderMap,
        Json(body): Json<Value>,
    ) -> Response {
        let mut f = s.lock().unwrap();
        if !authorised(&f, &h) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        f.next_link += 1;
        let id = format!("l{}", f.next_link);
        let link = json!({"id": id, "kind": body["kind"], "label": body["label"],
                          "created_at": "2026-10-28T00:00:00Z", "last_used_at": null});
        f.links.push(link.clone());
        let mut out = link;
        out["url"] = json!(format!(
            "https://mcp.example/{}/secret{}/mcp",
            f.tenant, f.next_link
        ));
        (StatusCode::CREATED, Json(out)).into_response()
    }

    async fn rotate_link(State(s): State<Shared>, AxPath(id): AxPath<String>) -> Json<Value> {
        let f = s.lock().unwrap();
        Json(json!({"id": id, "url": format!("https://mcp.example/{}/rotated-{id}/mcp", f.tenant)}))
    }

    async fn delete_link(State(s): State<Shared>, AxPath(id): AxPath<String>) -> StatusCode {
        s.lock().unwrap().links.retain(|l| l["id"] != id.as_str());
        StatusCode::NO_CONTENT
    }

    async fn fake_worker(fake: Shared) -> String {
        let app = Router::new()
            .route("/v2/register", post(register))
            .route("/v2/agent", get(agent))
            .route("/v2/agent/library", put(library))
            .route("/v2/agent/links", get(list_links).post(create_link))
            .route("/v2/agent/links/{id}/rotate", post(rotate_link))
            .route("/v2/agent/links/{id}", delete(delete_link))
            .with_state(fake);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    struct CopyFixture;
    impl Fetcher for CopyFixture {
        async fn fetch(&self, media: &MediaRef, staging: &Path) -> anyhow::Result<()> {
            let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.mp3");
            let name = media.url().as_str().rsplit(['/', '=']).next().unwrap();
            std::fs::copy(fixture, staging.join(format!("DJ Test - {name}.mp3")))?;
            Ok(())
        }
    }

    fn queue(dir: &Path) -> JobQueue {
        let cfg = DownloadCfg {
            dir: dir.join("dl"),
            import_xml: dir.join("import.xml"),
            ..DownloadCfg::default()
        };
        JobQueue::start(cfg, CopyFixture).unwrap().0
    }

    fn fast() -> LaneTiming {
        LaneTiming {
            ping: Duration::from_millis(300),
            tick: Duration::from_millis(20),
            extend: Duration::from_secs(5),
            library_check: Duration::from_secs(5),
            min_backoff: Duration::from_millis(20),
            max_backoff: Duration::from_millis(200),
            slow_retry: Duration::from_secs(5),
            replaced_retry: Duration::from_secs(5),
            unauthorized_before_reregister: 3,
        }
    }

    fn job(id: &str) -> Value {
        json!({"job_id": id, "kind": "download", "playlist": "Friday",
               "urls": ["https://open.spotify.com/track/abc123"], "attempt": 1})
    }

    /// Start the lane; returns its shutdown switch.
    fn start(base: &str, dir: &Path) -> (Arc<CloudSession>, watch::Sender<bool>) {
        let session = CloudSession::new(base, dir.to_path_buf()).unwrap();
        let (tx, rx) = watch::channel(false);
        tokio::spawn(run_with(fast(), session.clone(), queue(dir), None, rx));
        (session, tx)
    }

    async fn until(fake: &Shared, what: &str, cond: impl Fn(&Fake) -> bool) {
        for _ in 0..500 {
            if cond(&fake.lock().unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    #[tokio::test]
    async fn registers_connects_and_runs_a_pushed_job() {
        let tmp = tempfile::tempdir().unwrap();
        let fake: Shared = Arc::default();
        fake.lock().unwrap().queued.push(job("c0ffee000001"));
        let base = fake_worker(fake.clone()).await;
        let (session, stop) = start(&base, tmp.path());

        until(&fake, "a result", |f| !f.completed.is_empty()).await;
        until(&fake, "ready after the ack", |f| f.readies >= 1).await;
        let f = fake.lock().unwrap();
        assert_eq!(f.registrations, 1);
        assert_eq!(f.hellos[0]["protocol"], AGENT_PROTOCOL_V2);
        assert_eq!(f.hellos[0]["can_claim"], true);
        let done = &f.completed[0];
        assert_eq!(done["job_id"], "c0ffee000001");
        assert_eq!(done["state"], "done", "{done}");
        assert_eq!(done["tracks"].as_array().unwrap().len(), 1);
        assert!(session.is_connected());

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(tmp.path().join("cloud.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "credentials are private");
        let _ = stop.send(true);
    }

    #[tokio::test]
    async fn resends_a_result_that_was_never_acked() {
        let tmp = tempfile::tempdir().unwrap();
        let fake: Shared = Arc::default();
        {
            let mut f = fake.lock().unwrap();
            f.queued.push(job("c0ffee000002"));
            f.drop_first_complete = true;
        }
        let base = fake_worker(fake.clone()).await;
        let (_session, stop) = start(&base, tmp.path());

        until(&fake, "the result twice", |f| f.completed.len() >= 2).await;
        let f = fake.lock().unwrap();
        assert_eq!(f.completed[0]["job_id"], f.completed[1]["job_id"]);
        assert!(f.connects >= 2, "reconnected");
        assert_eq!(
            f.hellos[1]["active"],
            json!(["c0ffee000002"]),
            "still owed on reconnect"
        );
        assert_eq!(f.registrations, 1, "a dropped socket isn't a new identity");
        let _ = stop.send(true);
    }

    #[tokio::test]
    async fn registers_again_only_after_repeated_rejections() {
        let tmp = tempfile::tempdir().unwrap();
        let fake: Shared = Arc::default();
        fake.lock().unwrap().reject_connects = 3;
        std::fs::write(
            tmp.path().join("links.json"),
            r#"[{"id":"old","kind":"chatgpt"}]"#,
        )
        .unwrap();
        let base = fake_worker(fake.clone()).await;
        let (_session, stop) = start(&base, tmp.path());

        until(&fake, "a second registration", |f| f.registrations == 2).await;
        until(&fake, "a hello from the new identity", |f| {
            !f.hellos.is_empty()
        })
        .await;
        assert!(
            !tmp.path().join("links.json").exists(),
            "old links are dead with the old identity"
        );
        let _ = stop.send(true);
    }

    #[tokio::test]
    async fn links_are_created_listed_rotated_and_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let fake: Shared = Arc::default();
        let base = fake_worker(fake.clone()).await;
        let session = CloudSession::new(&base, tmp.path().to_path_buf()).unwrap();

        let made = session
            .create_link("chatgpt", Some("ChatGPT"))
            .await
            .unwrap();
        assert!(made.url.as_deref().unwrap().ends_with("/secret1/mcp"));
        let listed = session.list_links().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].url, made.url,
            "URL comes from this Mac, not the cloud"
        );

        let rotated = session.rotate_link(&made.id).await.unwrap();
        assert!(rotated.url.as_deref().unwrap().contains("rotated-l1"));
        assert_eq!(session.list_links().await.unwrap()[0].url, rotated.url);

        session.delete_link(&made.id).await.unwrap();
        assert!(session.list_links().await.unwrap().is_empty());
        let local: Vec<Link> = read_json(&tmp.path().join("links.json")).unwrap();
        assert!(local.is_empty());
    }

    #[tokio::test]
    async fn library_snapshot_goes_up_gzipped() {
        let tmp = tempfile::tempdir().unwrap();
        let fake: Shared = Arc::default();
        let base = fake_worker(fake.clone()).await;
        let session = CloudSession::new(&base, tmp.path().to_path_buf()).unwrap();
        let upload = json!({"hash": "abc", "playlists": [], "tracks": [{"id": "1", "title": "T"}]});
        session.upload_library(&upload).await.unwrap();
        let f = fake.lock().unwrap();
        assert_eq!(f.uploads, vec![upload]);
    }

    #[test]
    fn close_codes_and_statuses_map_to_errors() {
        use tokio_tungstenite::tungstenite::protocol::CloseFrame as Frame;
        let frame = |code: u16| {
            Some(Frame {
                code: CloseCode::from(code),
                reason: "r".into(),
            })
        };
        assert!(matches!(closed(frame(4001)), Err(CloudError::Unauthorized)));
        assert!(matches!(
            closed(frame(4009)),
            Err(CloudError::Incompatible(_))
        ));
        assert!(matches!(closed(frame(4010)), Err(CloudError::Replaced)));
        assert!(matches!(closed(frame(4029)), Err(CloudError::Limited(_))));
        assert!(matches!(closed(frame(1000)), Ok(Ended::Dropped)));
        assert!(matches!(
            classify(
                StatusCode::CONFLICT,
                r#"{"error":"incompatible_protocol"}"#.into()
            ),
            CloudError::Incompatible(_)
        ));
        assert!(matches!(
            classify(StatusCode::BAD_GATEWAY, String::new()),
            CloudError::Transient(_)
        ));
        match classify(
            StatusCode::CONFLICT,
            r#"{"error":"too_many_links","limit":10}"#.into(),
        ) {
            CloudError::Rejected(s, msg) => {
                assert_eq!((s.as_u16(), msg.as_str()), (409, "too_many_links"))
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn credentials_follow_the_cloud_to_its_new_hostname() {
        let tmp = tempfile::tempdir().unwrap();
        let old = Credentials {
            base_url: "https://mcp.triplejmusic.art".into(),
            tenant_id: "u2dDy37bIx227JDdDMLBoA".into(),
            agent_token: "djsa_x".into(),
        };
        write_private_json(&tmp.path().join("cloud.json"), &old).unwrap();
        let link = |url: &str| Link {
            id: "l1".into(),
            kind: "chatgpt".into(),
            label: None,
            created_at: None,
            last_used_at: None,
            url: Some(url.into()),
            api_url: None,
            token: None,
        };
        write_private_json(
            &tmp.path().join("links.json"),
            &vec![link(
                "https://mcp.triplejmusic.art/u2dDy37bIx227JDdDMLBoA/s3cret/mcp",
            )],
        )
        .unwrap();

        let new =
            adopt_credentials(old.clone(), "https://djsync.jeffrey.build", tmp.path()).unwrap();
        assert_eq!(new.tenant_id, old.tenant_id, "same DJ, no re-registration");
        assert_eq!(new.base_url, "https://djsync.jeffrey.build");
        let saved: Credentials = read_json(&tmp.path().join("cloud.json")).unwrap();
        assert_eq!(saved, new);
        let links: Vec<Link> = read_json(&tmp.path().join("links.json")).unwrap();
        assert_eq!(
            links[0].url.as_deref(),
            Some("https://djsync.jeffrey.build/u2dDy37bIx227JDdDMLBoA/s3cret/mcp")
        );
        // A different cloud's credentials are never reused.
        assert!(adopt_credentials(old, "https://other.example", tmp.path()).is_none());
    }

    #[test]
    fn base_url_must_be_https() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(CloudSession::new("http://mcp.example.com", tmp.path().into()).is_err());
        assert!(CloudSession::new("https://mcp.example.com/", tmp.path().into()).is_ok());
    }
}
