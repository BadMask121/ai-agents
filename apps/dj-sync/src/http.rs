//! The HTTP lane: an axum server on 127.0.0.1 that Cloudflare Tunnel exposes
//! publicly. Routes:
//!
//! - `GET  /health`              — public liveness probe
//! - `POST /<MCP_SECRET_PATH>/mcp` — MCP (Streamable HTTP, JSON responses)
//! - `POST /api/downloads`       — iOS Shortcut fallback (Bearer `SHORTCUT_API_KEY`)
//! - `GET  /api/downloads/{id}`  — job status for the Shortcut
//! - `GET  /local/status`        — for the menu bar app on this Mac only
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
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::config::{CloudCfg, Config, DownloadCfg};
use crate::jobs::JobQueue;
use crate::mcp::{self, McpContext, SUPPORTED_VERSIONS};
use crate::parser::extract_media_ref;
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
        }
    }

    pub fn with_api_key(mut self, key: Option<String>) -> Self {
        self.api_key = key.map(Arc::from);
        self
    }
}

pub fn router(state: AppState, secret: &str) -> Router {
    let mut app = Router::new()
        .route("/health", get(health))
        .route("/local/status", get(local_status))
        .route(
            &format!("/{secret}/mcp"),
            post(mcp_post)
                .get(method_not_allowed)
                .delete(method_not_allowed),
        );
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
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let secret = Config::mcp_secret_path()?;
    let api_key = Config::shortcut_api_key()?;

    let addr: SocketAddr = cfg.mcp.bind;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    info!(
        %addr,
        downloads = %cfg.download.dir.display(),
        xml = %cfg.download.import_xml.display(),
        "MCP endpoint listening at http://{addr}/<MCP_SECRET_PATH>/mcp"
    );

    if api_key.is_some() {
        info!("SHORTCUT_API_KEY set; /api/downloads enabled");
    }
    let state = AppState::new(jobs, &cfg).with_api_key(api_key);
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
async fn local_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if headers.contains_key("cf-ray") || headers.contains_key("cf-connecting-ip") {
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
        .recent(3)
        .into_iter()
        .map(|j| {
            json!({
                "job_id": j.job_id,
                "state": j.state,
                "playlist": j.playlist,
                "message": j.message,
                "created_at": j.created_at,
                "finished_at": j.finished_at,
            })
        })
        .collect();
    Json(json!({
        "service": "dj-sync",
        "version": env!("CARGO_PKG_VERSION"),
        "download_dir": dir,
        "download_dir_source": source.as_str(),
        "download_dir_writable": dir_error.is_none(),
        "download_dir_error": dir_error,
        "import_xml": state.download.import_xml,
        "xml_version": xml_version,
        "cloud": { "enabled": state.cloud.enabled, "base_url": state.cloud.base_url },
        "recent_jobs": recent,
    }))
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
