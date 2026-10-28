//! Drives the axum router in-process (no socket) to check routing, the
//! secret path, MCP transport status codes and the Origin guard.

use std::path::Path;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use dj_sync::config::{Config, DownloadCfg};
use dj_sync::downloader::Fetcher;
use dj_sync::http::{router, AppState};
use dj_sync::jobs::JobQueue;
use dj_sync::MediaRef;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef0123";

struct Idle;
impl Fetcher for Idle {
    async fn fetch(&self, _: &MediaRef, _: &Path) -> anyhow::Result<()> {
        std::future::pending().await
    }
}

const API_KEY: &str = "shortcut-key-0123456789abcdef";

fn app(dir: &Path) -> axum::Router {
    app_with_key(dir, None)
}

fn app_with_key(dir: &Path, key: Option<&str>) -> axum::Router {
    let raw = format!(
        r#"
[library]
roots = ["/tmp"]
[rekordbox]
autoimport_dir = "/tmp"
[mcp]
enabled = true
public_base_url = "https://mcp.example.test"
[download]
dir = "{d}/dl"
import_xml = "{d}/import.xml"
"#,
        d = dir.display()
    );
    let cfg: Config = toml::from_str(&raw).unwrap();
    let dl: DownloadCfg = cfg.download.clone();
    let (jobs, _) = JobQueue::start(dl, Idle).unwrap();
    router(
        AppState::new(jobs, &cfg).with_api_key(key.map(String::from)),
        SECRET,
    )
}

async fn send(app: axum::Router, req: Request<Body>) -> (StatusCode, String) {
    let res = app.oneshot(req).await.unwrap();
    let status = res.status();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&body).into_owned())
}

fn post(path: &str, body: Value) -> Request<Body> {
    Request::post(path)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn mcp_path() -> String {
    format!("/{SECRET}/mcp")
}

#[tokio::test]
async fn local_status_reports_folder_and_refuses_proxied_requests() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, b) = send(
        app(tmp.path()),
        Request::get("/local/status").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v["service"], "dj-sync");
    assert_eq!(v["download_dir"], format!("{}/dl", tmp.path().display()));
    assert_eq!(v["download_dir_source"], "config");
    assert_eq!(v["download_dir_writable"], true);
    assert_eq!(v["xml_version"], "1.0.0");
    assert!(v["recent_jobs"].as_array().unwrap().is_empty());

    let req = Request::get("/local/status")
        .header("cf-ray", "8a1b2c3d4e5f-LIS")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(app(tmp.path()), req).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn health_is_public() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, b) = send(
        app(tmp.path()),
        Request::get("/health").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["status"], "ok");
}

#[tokio::test]
async fn wrong_or_missing_secret_is_404() {
    let tmp = tempfile::tempdir().unwrap();
    let ping = json!({"jsonrpc":"2.0","id":1,"method":"ping"});
    for path in [
        "/mcp",
        "/wrong-secret/mcp",
        "/openapi.json",
        "/api/downloads",
    ] {
        let (s, _) = send(app(tmp.path()), post(path, ping.clone())).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn initialize_then_list_tools_over_http() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, b) = send(
        app(tmp.path()),
        post(
            &mcp_path(),
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v["result"]["protocolVersion"], "2025-11-25");

    let (s, b) = send(
        app(tmp.path()),
        post(
            &mcp_path(),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert!(b.is_empty());

    let mut req = post(
        &mcp_path(),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    );
    req.headers_mut()
        .insert("mcp-protocol-version", "2025-11-25".parse().unwrap());
    let (s, b) = send(app(tmp.path()), req).await;
    assert_eq!(s, StatusCode::OK);
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v["result"]["tools"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn modern_version_probe_gets_bare_400_so_client_falls_back() {
    let tmp = tempfile::tempdir().unwrap();
    let mut req = post(
        &mcp_path(),
        json!({"jsonrpc":"2.0","id":1,"method":"server/discover"}),
    );
    req.headers_mut()
        .insert("mcp-protocol-version", "2026-07-28".parse().unwrap());
    let (s, b) = send(app(tmp.path()), req).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        b.is_empty(),
        "must not look like a modern JSON-RPC error: {b}"
    );
}

#[tokio::test]
async fn get_and_delete_are_405_and_bad_json_is_400() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, _) = send(
        app(tmp.path()),
        Request::get(mcp_path()).body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
    let (s, _) = send(
        app(tmp.path()),
        Request::delete(mcp_path()).body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);

    let req = Request::post(mcp_path())
        .header("content-type", "application/json")
        .body(Body::from("{not json"))
        .unwrap();
    let (s, b) = send(app(tmp.path()), req).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_str::<Value>(&b).unwrap()["error"]["code"],
        -32700
    );
}

#[tokio::test]
async fn foreign_origin_is_403_but_chatgpt_and_public_host_are_fine() {
    let tmp = tempfile::tempdir().unwrap();
    let ping = json!({"jsonrpc":"2.0","id":1,"method":"ping"});
    for (origin, want) in [
        ("https://evil.example", StatusCode::FORBIDDEN),
        ("null", StatusCode::FORBIDDEN),
        ("https://chatgpt.com", StatusCode::OK),
        ("https://mcp.example.test", StatusCode::OK),
        ("http://localhost:6274", StatusCode::OK),
    ] {
        let mut req = post(&mcp_path(), ping.clone());
        req.headers_mut().insert("origin", origin.parse().unwrap());
        let (s, _) = send(app(tmp.path()), req).await;
        assert_eq!(s, want, "{origin}");
    }
}

#[tokio::test]
async fn oversized_body_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let big = "x".repeat(70 * 1024);
    let req = post(
        &mcp_path(),
        json!({"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":big}}),
    );
    let (s, _) = send(app(tmp.path()), req).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn download_tool_call_over_http_returns_job_id() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, b) = send(
        app(tmp.path()),
        post(
            &mcp_path(),
            json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"download_to_rekordbox","arguments":{"urls":["https://open.spotify.com/track/abc123"]}}}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v["result"]["isError"], false, "{v}");
    assert_eq!(
        v["result"]["structuredContent"]["playlist"],
        "ChatGPT Downloads"
    );
    assert_eq!(
        v["result"]["structuredContent"]["job_id"]
            .as_str()
            .unwrap()
            .len(),
        12
    );
}

fn api_post(body: Value, bearer: Option<&str>) -> Request<Body> {
    let mut req = post("/api/downloads", body);
    if let Some(b) = bearer {
        req.headers_mut()
            .insert("authorization", format!("Bearer {b}").parse().unwrap());
    }
    req
}

#[tokio::test]
async fn api_requires_the_bearer_key() {
    let tmp = tempfile::tempdir().unwrap();
    let body = json!({"url": "https://youtu.be/dQw4w9WgXcQ"});
    for bearer in [None, Some("wrong"), Some("shortcut-key-0123456789abcdeX")] {
        let (s, _) = send(
            app_with_key(tmp.path(), Some(API_KEY)),
            api_post(body.clone(), bearer),
        )
        .await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{bearer:?}");
    }
}

#[tokio::test]
async fn api_queues_a_shared_link_and_reports_status() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app_with_key(tmp.path(), Some(API_KEY));
    // What the Spotify share sheet can hand over: text with the link inside.
    let (s, b) = send(
        app.clone(),
        api_post(
            json!({"url": "Tanzania by Uncle Waffles https://open.spotify.com/track/abc123?si=x", "playlist_name": "Phone"}),
            Some(API_KEY),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::ACCEPTED, "{b}");
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v["urls"][0], "https://open.spotify.com/track/abc123");
    assert_eq!(v["playlist"], "Phone");
    let id = v["job_id"].as_str().unwrap();

    let mut get = Request::get(format!("/api/downloads/{id}"))
        .body(Body::empty())
        .unwrap();
    get.headers_mut().insert(
        "authorization",
        format!("Bearer {API_KEY}").parse().unwrap(),
    );
    let (s, b) = send(app.clone(), get).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["job_id"], id);

    let mut get = Request::get("/api/downloads/nope")
        .body(Body::empty())
        .unwrap();
    get.headers_mut().insert(
        "authorization",
        format!("Bearer {API_KEY}").parse().unwrap(),
    );
    assert_eq!(send(app.clone(), get).await.0, StatusCode::NOT_FOUND);

    let (s, b) = send(
        app,
        api_post(json!({"url": "https://evil.example/x"}), Some(API_KEY)),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(b.contains("rejected"));
}
