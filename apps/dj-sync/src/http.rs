//! The HTTP lane: an axum server on 127.0.0.1 that Cloudflare Tunnel exposes
//! publicly. Routes:
//!
//! - `GET  /health`              — public liveness probe
//! - `POST /<MCP_SECRET_PATH>/mcp` — MCP (Streamable HTTP, JSON responses)
//! - `POST /api/downloads`       — iOS Shortcut fallback (Bearer `SHORTCUT_API_KEY`)
//! - `GET  /api/downloads/{id}`  — job status for the Shortcut
//! - `GET  /local/status`        — for the menu bar app on this Mac only
//! - `POST /local/rekordbox/{apply,restore,retry,dismiss}` — library actions from the app
//! - `GET|POST /local/links`, `POST /local/links/{id}/rotate`,
//!   `DELETE /local/links/{id}` — assistant links (cloud v2), from the app
//! - anything else               — 404 (including `/api/*` when no key is set)
//!
//! The secret path is the credential (ChatGPT connects with "No
//! authentication"), so it's never logged.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::cloud_v2::{CloudError, CloudSession};
use crate::config::{CloudCfg, Config, DownloadCfg};
use crate::jobs::JobQueue;
use crate::mcp::{self, McpContext, SUPPORTED_VERSIONS};
use crate::parser::extract_media_ref;
use crate::rekordbox_db::RekordboxLibrary;
use crate::toolbox::Toolbox;
use crate::xml_versions::Versions;

const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct AppState {
    jobs: JobQueue,
    max_urls: usize,
    default_playlist: String,
    /// Host of `mcp.public_base_url`, accepted as an `Origin`.
    public_host: Option<String>,
    /// Bearer key for `/api/*`; `None` turns those routes off.
    api_key: Option<Arc<str>>,
    download: DownloadCfg,
    cloud: CloudCfg,
    mcp_bind: SocketAddr,
    public_base_url: Option<String>,
    /// Set by `router`; only reported to the menu bar app on this Mac.
    mcp_secret: Arc<str>,
    library: Option<Arc<RekordboxLibrary>>,
    /// This Mac's cloud v2 identity, for `/local/links`.
    session: Option<Arc<CloudSession>>,
    toolbox: Option<Arc<Toolbox>>,
}

impl AppState {
    pub fn new(jobs: JobQueue, cfg: &Config) -> Self {
        Self {
            jobs,
            max_urls: cfg.download.max_urls_per_job,
            default_playlist: cfg.download.default_playlist.clone(),
            public_host: cfg
                .mcp
                .public_base_url
                .as_deref()
                .and_then(|u| url::Url::parse(u).ok())
                .and_then(|u| u.host_str().map(str::to_ascii_lowercase)),
            api_key: None,
            download: cfg.download.clone(),
            cloud: cfg.cloud.clone(),
            mcp_bind: cfg.mcp.bind,
            public_base_url: cfg.mcp.public_base_url.clone(),
            mcp_secret: Arc::from(""),
            library: None,
            session: None,
            toolbox: None,
        }
    }

    pub fn with_toolbox(mut self, toolbox: Option<Arc<Toolbox>>) -> Self {
        self.toolbox = toolbox;
        self
    }

    pub fn with_session(mut self, session: Option<Arc<CloudSession>>) -> Self {
        self.session = session;
        self
    }

    pub fn with_library(mut self, library: Option<Arc<RekordboxLibrary>>) -> Self {
        self.library = library;
        self
    }

    pub fn with_api_key(mut self, key: Option<String>) -> Self {
        self.api_key = key.map(Arc::from);
        self
    }
}

/// `secret` is the local MCP route's path segment; empty means no MCP route
/// (a fresh install: assistants reach this Mac through the cloud instead).
pub fn router(mut state: AppState, secret: &str) -> Router {
    state.mcp_secret = Arc::from(secret);
    let mut app = Router::new()
        .route("/health", get(health))
        .route("/local/status", get(local_status))
        .route("/local/rekordbox/apply", post(local_apply))
        .route("/local/rekordbox/restore", post(local_restore))
        .route("/local/rekordbox/retry", post(local_retry))
        .route("/local/rekordbox/baseline", post(local_baseline))
        .route("/local/toolbox", get(local_toolbox))
        .route("/local/toolbox/install", post(local_toolbox_install))
        .route("/local/links", get(local_links).post(local_create_link))
        .route("/local/links/{id}/rotate", post(local_rotate_link))
        .route("/local/links/{id}", delete(local_delete_link))
        .route("/local/rekordbox/dismiss", post(local_dismiss));
    if !secret.is_empty() {
        app = app.route(
            &format!("/{secret}/mcp"),
            post(mcp_post)
                .get(method_not_allowed)
                .delete(method_not_allowed),
        );
    }
    if state.api_key.is_some() {
        app = app
            .route("/api/downloads", post(api_submit))
            .route("/api/downloads/{job_id}", get(api_status));
    }
    app.fallback(not_found)
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        // Span carries the method only: the URI contains the secret.
        .layer(
            TraceLayer::new_for_http().make_span_with(
                |req: &Request| tracing::info_span!("http", method = %req.method()),
            ),
        )
        .with_state(state)
}

/// Run the HTTP lane until `shutdown` flips. Jobs go to the shared queue
/// built in `main` (the only writer of the import XML).
pub async fn serve(
    cfg: Config,
    jobs: JobQueue,
    library: Option<Arc<RekordboxLibrary>>,
    session: Option<Arc<CloudSession>>,
    toolbox: Option<Arc<Toolbox>>,
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    // The local MCP lane needs its secret; without the lane there's no route.
    let secret = if cfg.mcp.enabled {
        Config::mcp_secret_path()?
    } else {
        String::new()
    };
    let api_key = Config::shortcut_api_key()?;

    let listener = bind(cfg.mcp.bind).await?;
    let addr = listener.local_addr().context("local address")?;
    write_runtime_file(addr);
    info!(
        %addr,
        downloads = %cfg.download.dir.display(),
        xml = %cfg.download.import_xml.display(),
        local_mcp = !secret.is_empty(),
        "dj-sync listening at http://{addr} (local MCP at /<MCP_SECRET_PATH>/mcp when enabled)"
    );

    if api_key.is_some() {
        info!("SHORTCUT_API_KEY set; /api/downloads enabled");
    }
    let mut state = AppState::new(jobs, &cfg)
        .with_api_key(api_key)
        .with_library(library)
        .with_session(session)
        .with_toolbox(toolbox);
    state.mcp_bind = addr;
    axum::serve(listener, router(state, &secret))
        .with_graceful_shutdown(async move {
            let _ = shutdown.wait_for(|stop| *stop).await;
        })
        .await
        .context("http server")
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

/// What the DJ Sync menu bar app shows. Only for this Mac: anything that
/// came through Cloudflare (the tunnel, if it's ever routed again) is refused.
/// `/local/*` is for the menu bar app on this Mac: refuse anything relayed
/// by Cloudflare, and (for actions) anything a web page could send — browsers
/// always attach `Origin`, the app never does.
fn local_only(headers: &HeaderMap, action: bool) -> bool {
    let proxied = headers.contains_key("cf-ray") || headers.contains_key("cf-connecting-ip");
    let from_browser = action && headers.contains_key(header::ORIGIN);
    !(proxied || from_browser)
}

async fn local_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !local_only(&headers, false) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (dir, source) = state.download.current_dir();
    // Probe as dj-sync itself: macOS may block the background service from a
    // folder the user can see fine in Finder.
    let dir_error = crate::settings::ensure_writable(&dir)
        .err()
        .map(|e| format!("{e:#}"));
    let xml_version = Versions::for_xml(&state.download.import_xml, state.download.keep_versions)
        .latest()
        .map(|(v, _)| v.to_string());
    let recent: Vec<Value> = state
        .jobs
        // Enough history for the app to notice every new or finished job
        // between its polls; it shows only the newest few.
        .recent(10)
        .into_iter()
        .map(|j| {
            json!({
                "job_id": j.job_id,
                "state": j.state,
                "playlist": j.playlist,
                "message": j.message,
                "created_at": j.created_at,
                "finished_at": j.finished_at,
                "links": j.urls.len(),
                "tracks": j.tracks.len(),
                "errors": j.errors.len(),
                "xml_version": j.xml_version,
            })
        })
        .collect();
    // ChatGPT reaches the cloud Worker when the cloud lane is on, else the
    // public base (tunnel); both serve the same secret path.
    let public_base = if state.cloud.enabled {
        Some(state.cloud.base_url.clone())
    } else {
        state.public_base_url.clone()
    }
    .map(|b| b.trim_end_matches('/').to_string());
    let secret = &*state.mcp_secret;
    // The secret-path URL exists only with the local MCP lane (the owner's
    // original setup); new installs connect assistants through links.
    let mcp = (!secret.is_empty()).then(|| {
        json!({
            "public_url": public_base.as_ref().map(|b| format!("{b}/{secret}/mcp")),
            "local_url": format!("http://{}/{secret}/mcp", state.mcp_bind),
        })
    });
    Json(json!({
        "service": "dj-sync",
        "mcp": mcp,
        "shortcut_url": match (&public_base, state.api_key.is_some()) {
            (Some(b), true) => Some(format!("{b}/api/downloads")),
            _ => None,
        },
        "version": env!("CARGO_PKG_VERSION"),
        "download_dir": dir,
        "download_dir_source": source.as_str(),
        "download_dir_writable": dir_error.is_none(),
        "download_dir_error": dir_error,
        "import_xml": state.download.import_xml,
        "xml_version": xml_version,
        "cloud": {
            "enabled": state.cloud.enabled,
            "base_url": state.cloud.base_url,
            "protocol": state.cloud.protocol,
            "registered": match &state.session {
                Some(s) => s.tenant_id().await.is_some(),
                None => false,
            },
            "connected": state.session.as_ref().is_some_and(|s| s.is_connected()),
        },
        "rekordbox_db": state.library.as_ref().map(|lib| lib.status()),
        "recent_jobs": recent,
    }))
    .into_response()
}

/// Apply queued library changes now (only does anything if Rekordbox is closed).
async fn local_apply(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !local_only(&headers, true) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(lib) = state.library.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::task::spawn_blocking(move || lib.apply_pending()).await {
        Ok(Ok(applied)) => Json(json!({ "ok": true, "applied": applied })).into_response(),
        Ok(Err(e)) => conflict(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Requeue changes that were set aside after failing.
async fn local_retry(State(state): State<AppState>, headers: HeaderMap) -> Response {
    library_call(state, headers, |lib| lib.retry_failed()).await
}

/// Forget changes that were set aside after failing.
async fn local_dismiss(State(state): State<AppState>, headers: HeaderMap) -> Response {
    library_call(state, headers, |lib| lib.dismiss_failed()).await
}

async fn library_call(
    state: AppState,
    headers: HeaderMap,
    f: impl FnOnce(&RekordboxLibrary) -> anyhow::Result<usize> + Send + 'static,
) -> Response {
    if !local_only(&headers, true) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(lib) = state.library.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::task::spawn_blocking(move || f(&lib)).await {
        Ok(Ok(n)) => Json(json!({ "ok": true, "count": n })).into_response(),
        Ok(Err(e)) => conflict(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct RestoreRequest {
    version: String,
}

/// Put a backup of Rekordbox's library back (Rekordbox must be closed).
async fn local_restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RestoreRequest>,
) -> Response {
    if !local_only(&headers, true) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(lib) = state.library.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::task::spawn_blocking(move || lib.restore(&req.version)).await {
        Ok(Ok(message)) => Json(json!({ "ok": true, "message": message })).into_response(),
        Ok(Err(e)) => conflict(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Take the "before DJ Sync" backup now (onboarding).
async fn local_baseline(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !local_only(&headers, true) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(lib) = state.library.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::task::spawn_blocking(move || lib.ensure_baseline()).await {
        Ok(Ok(version)) => Json(json!({ "ok": true, "version": version })).into_response(),
        Ok(Err(e)) => conflict(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn conflict(e: anyhow::Error) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "ok": false, "error": format!("{e:#}") })),
    )
        .into_response()
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

async fn method_not_allowed() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

async fn mcp_post(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if !origin_allowed(&headers, state.public_host.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"jsonrpc":"2.0","error":{"code":-32600,"message":"Origin not allowed"}})),
        )
            .into_response();
    }

    // A version we don't speak — including 2026-07-28's per-request probe —
    // gets a bare 400, which tells newer clients to fall back to `initialize`.
    if let Some(v) = headers.get("mcp-protocol-version") {
        let v = v.to_str().unwrap_or_default();
        if !SUPPORTED_VERSIONS.contains(&v) {
            return StatusCode::BAD_REQUEST.into_response();
        }
    }

    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(mcp::parse_error())).into_response(),
    };
    let ctx = McpContext {
        jobs: &state.jobs,
        max_urls: state.max_urls,
        default_playlist: &state.default_playlist,
    };
    match mcp::dispatch(&msg, &ctx) {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// DNS-rebinding guard from the MCP spec: browsers always send `Origin`, so
/// a present-but-foreign one is refused. Server-to-server callers (ChatGPT's
/// backend) normally send none.
fn origin_allowed(headers: &HeaderMap, public_host: Option<&str>) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Some(host) = origin
        .to_str()
        .ok()
        .and_then(|o| url::Url::parse(o).ok())
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
    else {
        return false;
    };
    matches!(
        host.as_str(),
        "localhost" | "127.0.0.1" | "[::1]" | "chatgpt.com" | "chat.openai.com"
    ) || host.ends_with(".chatgpt.com")
        || host.ends_with(".openai.com")
        || Some(host.as_str()) == public_host
}

// ---------- REST for the iOS Shortcut ----------

#[derive(Deserialize)]
struct ApiSubmit {
    /// A single shared link — what the Share Sheet hands a Shortcut.
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    playlist_name: Option<String>,
}

fn authorized(headers: &HeaderMap, key: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|got| bool::from(got.trim().as_bytes().ct_eq(key.as_bytes())))
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        Json(json!({ "error": "missing or wrong bearer token" })),
    )
        .into_response()
}

fn bad_request(msg: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.into() })),
    )
        .into_response()
}

/// Share sheets sometimes hand over "Song by Artist https://…" — keep the link.
fn link_in(text: &str) -> &str {
    text.split_whitespace()
        .find(|w| w.starts_with("https://") || w.starts_with("spotify:"))
        .unwrap_or(text.trim())
}

async fn api_submit(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(key) = state.api_key.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !authorized(&headers, key) {
        return unauthorized();
    }
    let req: ApiSubmit = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return bad_request(format!("expected JSON {{\"url\": …}}: {e}")),
    };

    let inputs: Vec<String> = req.url.into_iter().chain(req.urls).collect();
    if inputs.is_empty() {
        return bad_request("send `url` (or `urls`)");
    }
    if inputs.len() > state.max_urls {
        return bad_request(format!("at most {} links per request", state.max_urls));
    }
    let mut media = Vec::new();
    let mut rejected = Vec::new();
    for raw in &inputs {
        match extract_media_ref(link_in(raw)) {
            Ok(m) if !media.contains(&m) => media.push(m),
            Ok(_) => {}
            Err(reason) => rejected.push(json!({ "url": raw, "reason": reason })),
        }
    }
    if media.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "no supported Spotify or YouTube links", "rejected": rejected })),
        )
            .into_response();
    }

    match state.jobs.submit(media, req.playlist_name.as_deref()) {
        Ok(sub) => {
            let mut body = serde_json::to_value(&sub).unwrap_or(Value::Null);
            body["rejected"] = Value::Array(rejected);
            (StatusCode::ACCEPTED, Json(body)).into_response()
        }
        Err(e) => bad_request(format!("{e:#}")),
    }
}

async fn api_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Response {
    let Some(key) = state.api_key.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !authorized(&headers, key) {
        return unauthorized();
    }
    match state.jobs.get(&job_id) {
        Some(job) => Json(job).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such job" })),
        )
            .into_response(),
    }
}

/// Bind the configured address; on this Mac's loopback, fall back to any
/// free port when another app already holds it (8000 is a common dev port).
async fn bind(addr: SocketAddr) -> anyhow::Result<tokio::net::TcpListener> {
    match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && addr.ip().is_loopback() => {
            tracing::warn!(%addr, "port in use; using a free one (see ~/.dj-sync/runtime.json)");
            let any = SocketAddr::new(addr.ip(), 0);
            tokio::net::TcpListener::bind(any)
                .await
                .with_context(|| format!("binding {any}"))
        }
        Err(e) => Err(e).with_context(|| format!("binding {addr}")),
    }
}

/// `~/.dj-sync/runtime.json`: where the menu bar app finds this service.
fn write_runtime_file(addr: SocketAddr) {
    let body = json!({
        "port": addr.port(),
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    let written = crate::config::state_dir().and_then(|dir| {
        let path = dir.join("runtime.json");
        let tmp = dir.join("runtime.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&body)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(path)
    });
    if let Err(e) = written {
        tracing::warn!(error = %format!("{e:#}"), "couldn't write runtime.json");
    }
}

// ---------- toolbox ----------

async fn local_toolbox(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !local_only(&headers, false) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match &state.toolbox {
        Some(tb) => Json(json!(tb.report())).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Install or repair now (the menu app's Repair button).
async fn local_toolbox_install(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !local_only(&headers, true) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match &state.toolbox {
        Some(tb) => {
            tb.request_install();
            (StatusCode::ACCEPTED, Json(json!({ "ok": true }))).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------- assistant links (cloud v2) ----------

const LINK_KINDS: [&str; 4] = ["chatgpt", "claude", "shortcut", "other"];

fn cloud_error(e: CloudError) -> Response {
    let status = match e {
        CloudError::Limited(_) => StatusCode::TOO_MANY_REQUESTS,
        CloudError::Incompatible(_) => StatusCode::CONFLICT,
        CloudError::Unauthorized => StatusCode::SERVICE_UNAVAILABLE,
        CloudError::Replaced | CloudError::Transient(_) => StatusCode::BAD_GATEWAY,
        CloudError::Rejected(status, _) => {
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
        }
    };
    (status, Json(json!({ "ok": false, "error": e.to_string() }))).into_response()
}

fn session_for(
    state: &AppState,
    headers: &HeaderMap,
    action: bool,
) -> Result<Arc<CloudSession>, StatusCode> {
    if !local_only(headers, action) {
        return Err(if action {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::NOT_FOUND
        });
    }
    state.session.clone().ok_or(StatusCode::NOT_FOUND)
}

async fn local_links(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let session = match session_for(&state, &headers, false) {
        Ok(s) => s,
        Err(code) => return code.into_response(),
    };
    match session.list_links().await {
        Ok(links) => Json(json!({ "links": links })).into_response(),
        Err(e) => cloud_error(e),
    }
}

#[derive(Deserialize)]
struct NewLink {
    kind: String,
    #[serde(default)]
    label: Option<String>,
}

async fn local_create_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NewLink>,
) -> Response {
    let session = match session_for(&state, &headers, true) {
        Ok(s) => s,
        Err(code) => return code.into_response(),
    };
    if !LINK_KINDS.contains(&body.kind.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": format!("kind must be one of {LINK_KINDS:?}") })),
        )
            .into_response();
    }
    let label = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    match session.create_link(&body.kind, label).await {
        Ok(link) => (StatusCode::CREATED, Json(json!(link))).into_response(),
        Err(e) => cloud_error(e),
    }
}

async fn local_rotate_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let session = match session_for(&state, &headers, true) {
        Ok(s) => s,
        Err(code) => return code.into_response(),
    };
    match session.rotate_link(&id).await {
        Ok(link) => Json(json!(link)).into_response(),
        Err(e) => cloud_error(e),
    }
}

async fn local_delete_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let session = match session_for(&state, &headers, true) {
        Ok(s) => s,
        Err(code) => return code.into_response(),
    };
    match session.delete_link(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => cloud_error(e),
    }
}
