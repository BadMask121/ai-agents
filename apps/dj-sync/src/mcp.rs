//! A minimal, stateless MCP server (JSON-RPC 2.0) exposing two tools to
//! ChatGPT. Transport concerns (HTTP status codes, headers) live in
//! `http.rs`; this module maps one JSON-RPC message to at most one response.
//!
//! We speak the `initialize`-based protocol versions. Clients on the
//! 2026-07-28 revision probe with a version header first; `http.rs` answers
//! that with a bare 400, which per the spec makes them fall back to
//! `initialize`.

use serde_json::{json, Value};

use crate::jobs::JobQueue;
use crate::parser::extract_media_ref;

/// Newest first; the first entry is what we offer when the client asks for
/// something we don't know.
pub const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

const DOWNLOAD_TOOL: &str = "download_to_rekordbox";
const STATUS_TOOL: &str = "get_download_status";

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

pub struct McpContext<'a> {
    pub jobs: &'a JobQueue,
    pub max_urls: usize,
    pub default_playlist: &'a str,
}

pub fn parse_error() -> Value {
    error(
        Value::Null,
        PARSE_ERROR,
        "Parse error: body is not valid JSON",
    )
}

/// Handle one JSON-RPC message. `None` means it was a notification and the
/// transport should answer `202 Accepted` with no body.
pub fn dispatch(msg: &Value, ctx: &McpContext<'_>) -> Option<Value> {
    if msg.is_array() {
        return Some(error(
            Value::Null,
            INVALID_REQUEST,
            "JSON-RPC batches are not supported",
        ));
    }
    let Some(obj) = msg.as_object() else {
        return Some(error(
            Value::Null,
            INVALID_REQUEST,
            "expected a JSON-RPC object",
        ));
    };
    let id = obj.get("id").cloned();
    let method = obj.get("method").and_then(Value::as_str);

    let (Some(id), Some(method)) = (id, method) else {
        // No id: a notification (e.g. notifications/initialized) — nothing to say.
        // No method either: a stray response; also nothing to say.
        return if obj.contains_key("id") {
            Some(error(obj["id"].clone(), INVALID_REQUEST, "missing method"))
        } else {
            None
        };
    };
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(error(id, INVALID_REQUEST, "jsonrpc must be \"2.0\""));
    }
    let params = obj.get("params").cloned().unwrap_or(Value::Null);

    Some(match method {
        "initialize" => ok(id, initialize(&params)),
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": tool_definitions(ctx.max_urls) })),
        "tools/call" => match params.get("name").and_then(Value::as_str) {
            Some(DOWNLOAD_TOOL) => ok(id, call_download(params.get("arguments"), ctx)),
            Some(STATUS_TOOL) => ok(id, call_status(params.get("arguments"), ctx)),
            Some(other) => error(id, INVALID_PARAMS, &format!("Unknown tool: {other}")),
            None => error(id, INVALID_PARAMS, "tools/call requires params.name"),
        },
        other => error(id, METHOD_NOT_FOUND, &format!("Method not found: {other}")),
    })
}

fn initialize(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    let version = requested
        .filter(|v| SUPPORTED_VERSIONS.contains(v))
        .unwrap_or(SUPPORTED_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": "dj-sync",
            "title": "DJ Sync → Rekordbox",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": "Use download_to_rekordbox when the user shares Spotify, YouTube or \
            SoundCloud links they want in Rekordbox. It queues a download on the DJ's Mac and \
            returns a job_id right away; downloads take a few minutes. Use get_download_status \
            with that job_id when the user asks how it went.",
    })
}

pub fn tool_definitions(max_urls: usize) -> Value {
    json!([
        {
            "name": DOWNLOAD_TOOL,
            "title": "Download to Rekordbox",
            "description": "Download Spotify (track, album, playlist), YouTube (video, playlist) \
                or SoundCloud (track, set) links as audio files on the DJ's Mac and add them to a \
                playlist in the Rekordbox import XML. Returns immediately with a job_id; the \
                download itself takes a few minutes — call get_download_status to check on it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "array",
                        "items": { "type": "string" },
                        "minItems": 1,
                        "maxItems": max_urls,
                        "description": "Spotify, YouTube or SoundCloud links, e.g. https://open.spotify.com/track/… or https://soundcloud.com/artist/track"
                    },
                    "playlist_name": {
                        "type": "string",
                        "maxLength": 100,
                        "description": "Rekordbox playlist to add the tracks to. Omit to use the default playlist."
                    }
                },
                "required": ["urls"],
                "additionalProperties": false
            },
            "annotations": {
                "title": "Download to Rekordbox",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": true
            }
        },
        {
            "name": STATUS_TOOL,
            "title": "Download status",
            "description": "Check a download job started by download_to_rekordbox. Pass its job_id, \
                or omit it to list the most recent jobs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "job_id": { "type": "string", "description": "The job_id returned by download_to_rekordbox." }
                },
                "additionalProperties": false
            },
            "annotations": {
                "title": "Download status",
                "readOnlyHint": true,
                "openWorldHint": false
            }
        }
    ])
}

fn call_download(args: Option<&Value>, ctx: &McpContext<'_>) -> Value {
    let Some(urls) = args.and_then(|a| a.get("urls")).and_then(Value::as_array) else {
        return tool_error("`urls` must be a list of Spotify, YouTube or SoundCloud links.");
    };
    if urls.is_empty() {
        return tool_error(
            "`urls` is empty — send at least one Spotify, YouTube or SoundCloud link.",
        );
    }
    if urls.len() > ctx.max_urls {
        return tool_error(&format!(
            "Too many links ({}); send at most {} per call.",
            urls.len(),
            ctx.max_urls
        ));
    }
    let playlist = match args.and_then(|a| a.get("playlist_name")) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return tool_error("`playlist_name` must be a string."),
    };

    let mut media = Vec::new();
    let mut rejected = Vec::new();
    for u in urls {
        match u.as_str().map(extract_media_ref) {
            Some(Ok(m)) if !media.contains(&m) => media.push(m),
            Some(Ok(_)) => {} // duplicate link in the same call
            Some(Err(reason)) => rejected.push(json!({ "url": u, "reason": reason })),
            None => rejected.push(json!({ "url": u, "reason": "not a string" })),
        }
    }
    if media.is_empty() {
        return tool_result(
            "None of the links can be downloaded: only https Spotify track/album/playlist, \
             YouTube video/playlist and SoundCloud track/set links are supported.",
            json!({ "rejected": rejected }),
            true,
        );
    }

    match ctx.jobs.submit(media, playlist) {
        Ok(sub) => {
            let mut text = if sub.deduplicated {
                format!(
                    "That download is already in progress as job {} ({}).",
                    sub.job.job_id,
                    state_word(&sub.job)
                )
            } else {
                format!(
                    "Queued job {}: {} link(s) → Rekordbox playlist \"{}\"{}. Downloads take a \
                     few minutes; check with get_download_status.",
                    sub.job.job_id,
                    sub.job.urls.len(),
                    sub.job.playlist,
                    if sub.position > 0 {
                        format!(" ({} job(s) ahead)", sub.position)
                    } else {
                        String::new()
                    }
                )
            };
            if !rejected.is_empty() {
                text.push_str(&format!(" Skipped {} unsupported link(s).", rejected.len()));
            }
            let mut structured = serde_json::to_value(&sub).unwrap_or(Value::Null);
            structured["rejected"] = Value::Array(rejected);
            tool_result(&text, structured, false)
        }
        Err(e) => tool_error(&format!("{e:#}")),
    }
}

fn call_status(args: Option<&Value>, ctx: &McpContext<'_>) -> Value {
    match args.and_then(|a| a.get("job_id")).and_then(Value::as_str) {
        Some(id) => match ctx.jobs.get(id.trim()) {
            Some(job) => {
                let mut text = format!(
                    "Job {} is {}. {}",
                    job.job_id,
                    state_word(&job),
                    job.message
                );
                for e in &job.errors {
                    text.push_str(&format!("\n- {}: {}", e.url, error_summary(&e.error)));
                }
                tool_result(
                    &text,
                    serde_json::to_value(&job).unwrap_or(Value::Null),
                    false,
                )
            }
            None => tool_error(&format!(
                "No job {id} — it may be from before the server restarted. Call \
                 get_download_status without a job_id to list recent jobs."
            )),
        },
        None => {
            let jobs = ctx.jobs.recent(5);
            let text = if jobs.is_empty() {
                format!(
                    "No download jobs yet. New downloads go to the \"{}\" playlist unless you name one.",
                    ctx.default_playlist
                )
            } else {
                jobs.iter()
                    .map(|j| {
                        format!(
                            "{} — {} — \"{}\" — {}",
                            j.job_id,
                            state_word(j),
                            j.playlist,
                            j.message
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            tool_result(&text, json!({ "jobs": jobs }), false)
        }
    }
}

fn state_word(job: &crate::jobs::JobStatus) -> &'static str {
    use crate::jobs::JobState::*;
    match job.state {
        Queued => "queued",
        Running => "downloading",
        Done => "done",
        Failed => "failed",
    }
}

/// Downloader errors end with the tool's own output; its last `ERROR` line
/// says why (e.g. "Video unavailable"), so prefer that over our wrapper text.
fn error_summary(s: &str) -> &str {
    let lines = || s.lines().map(str::trim).filter(|l| !l.is_empty());
    lines()
        .rev()
        .find(|l| l.contains("ERROR"))
        .or_else(|| lines().next())
        .unwrap_or(s)
}

fn tool_result(text: &str, structured: Value, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": is_error,
    })
}

fn tool_error(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": true,
    })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DownloadCfg;
    use crate::downloader::Fetcher;
    use crate::MediaRef;
    use std::path::Path;

    struct NeverFinishes;
    impl Fetcher for NeverFinishes {
        async fn fetch(&self, _: &MediaRef, _: &Path) -> anyhow::Result<()> {
            std::future::pending().await
        }
    }

    fn queue(dir: &Path) -> JobQueue {
        let cfg = DownloadCfg {
            dir: dir.join("dl"),
            import_xml: dir.join("import.xml"),
            ..DownloadCfg::default()
        };
        JobQueue::start(cfg, NeverFinishes).unwrap().0
    }

    fn call(q: &JobQueue, msg: Value) -> Option<Value> {
        dispatch(
            &msg,
            &McpContext {
                jobs: q,
                max_urls: 3,
                default_playlist: "DJ Sync Downloads",
            },
        )
    }

    fn tool(q: &JobQueue, name: &str, args: Value) -> Value {
        call(
            q,
            json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":name,"arguments":args}}),
        )
        .unwrap()["result"]
            .clone()
    }

    #[test]
    fn error_summary_prefers_the_tools_last_error_line() {
        let e = "yt-dlp failed for https://x: exited with exit status: 1:\nWARNING: retrying\nERROR: [youtube] abc: Video unavailable\n";
        assert_eq!(error_summary(e), "ERROR: [youtube] abc: Video unavailable");
        assert_eq!(
            error_summary("produced no audio files"),
            "produced no audio files"
        );
    }

    #[tokio::test]
    async fn initialize_negotiates_version() {
        let tmp = tempfile::tempdir().unwrap();
        let q = queue(tmp.path());
        let r = call(&q, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}})).unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "dj-sync");
        assert!(r["result"]["capabilities"]["tools"].is_object());

        let r = call(&q, json!({"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"2099-01-01"}})).unwrap();
        assert_eq!(r["result"]["protocolVersion"], SUPPORTED_VERSIONS[0]);
    }

    #[tokio::test]
    async fn notifications_get_no_response_and_unknowns_get_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let q = queue(tmp.path());
        assert!(call(
            &q,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .is_none());
        let r = call(
            &q,
            json!({"jsonrpc":"2.0","id":2,"method":"resources/list"}),
        )
        .unwrap();
        assert_eq!(r["error"]["code"], METHOD_NOT_FOUND);
        let r = call(&q, json!([{"jsonrpc":"2.0","id":1,"method":"ping"}])).unwrap();
        assert_eq!(r["error"]["code"], INVALID_REQUEST);
        let r = call(
            &q,
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rm_rf"}}),
        )
        .unwrap();
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = call(&q, json!({"jsonrpc":"2.0","id":4,"method":"ping"})).unwrap();
        assert_eq!(r["result"], json!({}));
    }

    #[tokio::test]
    async fn tools_list_has_both_tools_with_object_schemas() {
        let tmp = tempfile::tempdir().unwrap();
        let q = queue(tmp.path());
        let r = call(&q, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, [DOWNLOAD_TOOL, STATUS_TOOL]);
        for t in tools {
            assert_eq!(t["inputSchema"]["type"], "object");
        }
        assert_eq!(tools[0]["inputSchema"]["properties"]["urls"]["maxItems"], 3);
        assert_eq!(tools[1]["annotations"]["readOnlyHint"], true);
    }

    #[tokio::test]
    async fn download_queues_valid_links_and_reports_bad_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let q = queue(tmp.path());
        let r = tool(
            &q,
            DOWNLOAD_TOOL,
            json!({"urls":["https://youtu.be/dQw4w9WgXcQ","https://evil.example/x"],"playlist_name":"Fri"}),
        );
        assert_eq!(r["isError"], false, "{r}");
        let job_id = r["structuredContent"]["job_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(r["structuredContent"]["playlist"], "Fri");
        assert_eq!(
            r["structuredContent"]["rejected"].as_array().unwrap().len(),
            1
        );
        assert!(r["content"][0]["text"].as_str().unwrap().contains(&job_id));

        // A retry of the same call is deduplicated.
        let again = tool(
            &q,
            DOWNLOAD_TOOL,
            json!({"urls":["https://youtu.be/dQw4w9WgXcQ"],"playlist_name":"Fri"}),
        );
        assert_eq!(again["structuredContent"]["job_id"], job_id.as_str());
        assert_eq!(again["structuredContent"]["deduplicated"], true);

        let st = tool(&q, STATUS_TOOL, json!({"job_id": job_id}));
        assert_eq!(st["isError"], false);
        assert!(matches!(
            st["structuredContent"]["state"].as_str(),
            Some("queued" | "running")
        ));

        let list = tool(&q, STATUS_TOOL, json!({}));
        assert_eq!(
            list["structuredContent"]["jobs"].as_array().unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn download_rejects_bad_input_as_tool_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let q = queue(tmp.path());
        for args in [
            json!({}),
            json!({"urls": []}),
            json!({"urls": "https://youtu.be/dQw4w9WgXcQ"}),
            json!({"urls": ["https://a.example/1","https://a.example/2"]}),
            json!({"urls": ["https://youtu.be/dQw4w9WgXcQ"], "playlist_name": 5}),
            json!({"urls": ["a","b","c","d"]}),
        ] {
            let r = tool(&q, DOWNLOAD_TOOL, args.clone());
            assert_eq!(r["isError"], true, "{args} -> {r}");
        }
        assert!(q.recent(10).is_empty(), "nothing queued");
        assert_eq!(
            tool(&q, STATUS_TOOL, json!({"job_id":"nope"}))["isError"],
            true
        );
    }
}
