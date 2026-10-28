// Routes (port of apps/dj-sync/src/http.rs plus the agent API):
//   GET  /health                     — public liveness + Mac online state
//   POST /<MCP_SECRET_PATH>/mcp      — MCP (Streamable HTTP, JSON responses)
//   POST /api/downloads              — iOS Shortcut (Bearer SHORTCUT_API_KEY)
//   GET  /api/downloads/{id}
//   POST /agent/poll                 — the Mac (Bearer AGENT_TOKEN, see agent.ts)
//   POST /agent/library              — the Mac's Rekordbox library snapshot (≤16 MB)
//   POST /agent/jobs/{id}/complete
//   anything else                    — 404
// The secret path is the MCP credential, so nothing here logs URLs.

import { PROTOCOL_HEADER, complete, gate, poll, uploadLibrary } from "./agent";
import {
  AGENT_PROTOCOL,
  MAX_BODY_BYTES,
  MAX_LIBRARY_BYTES,
  SUPPORTED_MCP_VERSIONS,
  WORKER_VERSION,
} from "./constants";
import { agentStatus, jobView, offlineNote, submit, type Deps } from "./jobs";
import { extractMediaRef, linkIn, type MediaRef } from "./links";
import { dispatch, parseError } from "./mcp";
import { empty, json, timingSafeEqual, validSecretPath } from "./util";

export interface Secrets {
  MCP_SECRET_PATH?: string;
  AGENT_TOKEN?: string;
  SHORTCUT_API_KEY?: string;
}

const MCP_PATH = /^\/([^/]+)\/mcp$/;
const API_JOB_PATH = /^\/api\/downloads\/([^/]+)$/;
const AGENT_COMPLETE_PATH = /^\/agent\/jobs\/([^/]+)\/complete$/;

export async function route(req: Request, secrets: Secrets, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health" && req.method === "GET") return health(deps);

  const mcp = MCP_PATH.exec(path);
  if (mcp && validSecretPath(secrets.MCP_SECRET_PATH) && timingSafeEqual(mcp[1]!, secrets.MCP_SECRET_PATH)) {
    if (req.method !== "POST") return empty(405, { allow: "POST" });
    return mcpPost(req, deps);
  }

  const apiKey = nonEmpty(secrets.SHORTCUT_API_KEY);
  if (apiKey) {
    if (path === "/api/downloads" && req.method === "POST") return apiSubmit(req, apiKey, deps);
    const m = API_JOB_PATH.exec(path);
    if (m && req.method === "GET") return apiStatus(req, apiKey, decodeURIComponent(m[1]!), deps);
  }

  const agentToken = nonEmpty(secrets.AGENT_TOKEN);
  if (agentToken && req.method === "POST") {
    const done = AGENT_COMPLETE_PATH.exec(path);
    const library = path === "/agent/library";
    if (path === "/agent/poll" || library || done) {
      const body = await readJson(req, library ? MAX_LIBRARY_BYTES : MAX_BODY_BYTES);
      if (body.kind === "too_large") return empty(413);
      const g = await gate(req, agentToken, deps);
      if (!g.ok) return g.response;
      if (body.kind === "invalid") return json({ error: "invalid_body", detail: "body is not valid JSON" }, 400);
      if (done) return complete(decodeURIComponent(done[1]!), body.value, deps);
      if (library) return uploadLibrary(body.value, g.protocol, req.headers.get(PROTOCOL_HEADER)!.trim(), deps);
      return poll(body.value, g.protocol, deps);
    }
  }

  return empty(404);
}

async function health(deps: Deps): Promise<Response> {
  const agent = await agentStatus(deps);
  return json({
    status: "ok",
    version: WORKER_VERSION,
    protocol: AGENT_PROTOCOL,
    agent,
    queued: await deps.store.countQueued(),
  });
}

async function mcpPost(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson(req);
  if (body.kind === "too_large") return empty(413);

  if (!originAllowed(req.headers.get("origin"), deps.config.publicHost)) {
    return json({ jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } }, 403);
  }
  // A version we don't speak — including 2026-07-28's per-request probe — gets
  // a bare 400, which tells newer clients to fall back to `initialize`.
  const version = req.headers.get("mcp-protocol-version");
  if (version !== null && !(SUPPORTED_MCP_VERSIONS as readonly string[]).includes(version)) {
    return empty(400);
  }
  if (body.kind === "invalid") return json(parseError(), 400);

  const reply = await dispatch(body.value, deps);
  return reply === null ? empty(202) : json(reply);
}

/**
 * DNS-rebinding guard from the MCP spec: browsers always send Origin, so a
 * present-but-foreign one is refused. ChatGPT's backend normally sends none.
 */
export function originAllowed(origin: string | null, publicHost: string): boolean {
  if (origin === null) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    ["localhost", "127.0.0.1", "[::1]", "chatgpt.com", "chat.openai.com"].includes(host) ||
    host.endsWith(".chatgpt.com") ||
    host.endsWith(".openai.com") ||
    host === publicHost.toLowerCase()
  );
}

// ---------- REST for the iOS Shortcut ----------

function shortcutAuthorized(req: Request, key: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  return timingSafeEqual(auth.slice("Bearer ".length).trim(), key);
}

function unauthorized(): Response {
  return json({ error: "missing or wrong bearer token" }, 401, { "www-authenticate": "Bearer" });
}

async function apiSubmit(req: Request, key: string, deps: Deps): Promise<Response> {
  if (!shortcutAuthorized(req, key)) return unauthorized();
  const body = await readJson(req);
  if (body.kind === "too_large") return empty(413);
  if (body.kind === "invalid" || typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
    return json({ error: 'expected JSON {"url": …}' }, 400);
  }
  const b = body.value as Record<string, unknown>;
  const inputs: unknown[] = [...(b.url !== undefined && b.url !== null ? [b.url] : []), ...(Array.isArray(b.urls) ? b.urls : [])];
  if (inputs.length === 0) return json({ error: "send `url` (or `urls`)" }, 400);
  if (inputs.length > deps.config.maxUrls) {
    return json({ error: `at most ${deps.config.maxUrls} links per request` }, 400);
  }
  if (b.playlist_name !== undefined && b.playlist_name !== null && typeof b.playlist_name !== "string") {
    return json({ error: "playlist_name must be a string" }, 400);
  }

  const media: MediaRef[] = [];
  const rejected: { url: unknown; reason: string }[] = [];
  for (const raw of inputs) {
    if (typeof raw !== "string") {
      rejected.push({ url: raw, reason: "not a string" });
      continue;
    }
    const r = extractMediaRef(linkIn(raw));
    if (!r.ok) rejected.push({ url: raw, reason: r.reason });
    else if (!media.some((m) => m.url === r.media.url)) media.push(r.media);
  }
  if (media.length === 0) return json({ error: "no supported Spotify or YouTube links", rejected }, 400);

  const sub = await submit(deps, media, (b.playlist_name as string | undefined) ?? null, "shortcut");
  if (!sub.ok) return json({ error: sub.error }, 400);
  const { job, position, deduplicated } = sub.value;
  const agent = await agentStatus(deps);
  // The Shortcut shows `message` in a notification, so make it self-explanatory.
  const message = job.message + (agent.online ? "" : offlineNote(agent, deps.now()));
  return json(
    { ...jobView(job), message, position, deduplicated, rejected, mac_online: agent.online },
    202,
  );
}

async function apiStatus(req: Request, key: string, jobId: string, deps: Deps): Promise<Response> {
  if (!shortcutAuthorized(req, key)) return unauthorized();
  const job = await deps.store.getJob(jobId);
  if (!job) return json({ error: "no such job" }, 404);
  const agent = await agentStatus(deps);
  return json({ ...jobView(job), mac_online: agent.online });
}

// ---------- helpers ----------

type Body = { kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too_large" };

async function readJson(req: Request, limit = MAX_BODY_BYTES): Promise<Body> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return { kind: "too_large" };
  const buf = await req.arrayBuffer();
  if (buf.byteLength > limit) return { kind: "too_large" };
  try {
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { kind: "invalid" };
  }
}

function nonEmpty(s: string | undefined): string | null {
  return s && s.trim() !== "" ? s.trim() : null;
}
