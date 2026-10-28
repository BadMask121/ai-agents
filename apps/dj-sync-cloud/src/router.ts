// Routes. Protocol 2 (spec §3.3) routes to per-DJ Tenant Durable Objects;
// protocol 1 (D1, one DJ) keeps working until V1_RETIRED="true".
//
//   GET  /health                          public liveness (no per-DJ data once v1 is retired)
//   POST /v2/register                     new DJ (rate-limited in the Registry)
//   GET  /v2/agent  (WebSocket)           the Mac: Bearer agent_token + X-DJ-Sync-Tenant
//   PUT  /v2/agent/library                ″  gzip'd library snapshot
//   GET|POST /v2/agent/links, POST /v2/agent/links/{id}/rotate, DELETE /v2/agent/links/{id}
//   POST /<tenant_id>/<link_secret>/mcp   MCP for one DJ
//   POST /api/downloads, GET /api/downloads/{id}, GET /api/playlists
//                                         Bearer <tenant_id>.<link_secret> (shortcut link)
//   GET  /v2/stats                        Bearer ADMIN_TOKEN
//   POST /v2/admin/telegram/setup         Bearer ADMIN_TOKEN: webhook, commands, descriptions
//   POST /telegram/webhook                X-Telegram-Bot-Api-Secret-Token (the shared bot)
//   — protocol 1 —
//   POST /<MCP_SECRET_PATH>/mcp, /api/downloads (Bearer SHORTCUT_API_KEY): D1, or the
//        LEGACY_TENANT_ID DJ once retired
//   POST /agent/poll | /agent/library | /agent/jobs/{id}/complete: D1, or 410 once retired
//   anything else                         404
// URLs hold secrets, so nothing here logs them. Credentials are verified in
// the Durable Object against stored hashes; the Worker only routes.

import { PROTOCOL_HEADER, VERSION_HEADER, complete, gate, poll, uploadLibrary } from "./agent";
import { AGENT_TOKEN, LINK_SECRET, TENANT_ID } from "./bytes";
import {
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_V2,
  CLOSE_UNAUTHORIZED,
  MAX_BODY_BYTES,
  MAX_LIBRARY_BYTES,
  MAX_LIBRARY_GZIP_BYTES,
  WORKER_VERSION,
} from "./constants";
import { apiPlaylists, apiStatus, apiSubmit, bearer, mcpPost, readJson, unauthorized } from "./http";
import { agentStatus, type Deps } from "./jobs";
import { parseSemver, protocolCompatible } from "./semver";
import { botApi, telegramSetup, telegramWebhook, type TelegramApi, type TelegramEnv } from "./telegram";
import { empty, json, timingSafeEqual, validSecretPath } from "./util";

export interface Secrets extends TelegramEnv {
  MCP_SECRET_PATH?: string;
  AGENT_TOKEN?: string;
  SHORTCUT_API_KEY?: string;
  /** Bearer for GET /v2/stats. */
  ADMIN_TOKEN?: string;
  /** "true" once the owner's Mac is on protocol 2 (spec §3.9). */
  V1_RETIRED?: string;
  /** The tenant the legacy secret path and Shortcut key reach after retirement. */
  LEGACY_TENANT_ID?: string;
}

export interface Namespaces {
  TENANT: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
}

export interface RouteOptions {
  /** The Bot API (tests pass a fake); defaults to the real one when the token is set. */
  telegram?: TelegramApi | null;
}

const MCP_PATH = /^\/([^/]+)\/mcp$/;
const V2_MCP_PATH = /^\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{43})\/mcp$/;
const V2_SHORTCUT_BEARER = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const API_JOB_PATH = /^\/api\/downloads\/([^/]+)$/;
const AGENT_COMPLETE_PATH = /^\/agent\/jobs\/([^/]+)\/complete$/;
const V2_LINK_PATH = /^\/v2\/agent\/links\/([A-Za-z0-9_-]{1,32})(\/rotate)?$/;
const TENANT_HEADER = "x-dj-sync-tenant";
const WORKER_PROTOCOL_V2 = parseSemver(AGENT_PROTOCOL_V2)!;

/** Headers a Tenant may see; everything else (including any x-djs-*) is dropped. */
const FORWARDED = [
  "content-type",
  "content-encoding",
  "origin",
  "mcp-protocol-version",
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  PROTOCOL_HEADER,
  VERSION_HEADER,
];

export async function route(req: Request, secrets: Secrets, deps: Deps, ns?: Namespaces, opts: RouteOptions = {}): Promise<Response> {
  const path = new URL(req.url).pathname;
  const retired = secrets.V1_RETIRED === "true";

  if (path === "/health" && req.method === "GET") return health(deps, retired);

  if (ns) {
    const telegram =
      opts.telegram !== undefined ? opts.telegram : secrets.TELEGRAM_BOT_TOKEN?.trim() ? botApi(secrets.TELEGRAM_BOT_TOKEN.trim()) : null;
    if (path === "/telegram/webhook") return telegramWebhook(req, secrets, ns, telegram);
    if (path === "/v2/admin/telegram/setup") {
      const admin = nonEmpty(secrets.ADMIN_TOKEN);
      if (!admin) return empty(404);
      if (req.method !== "POST") return empty(405, { allow: "POST" });
      if (!timingSafeEqual(bearer(req), admin)) return unauthorized();
      return telegramSetup(secrets, telegram);
    }
    const v2 = await routeV2(req, path, secrets, ns);
    if (v2) return v2;
  }

  // ---------- protocol 1 ----------
  const legacyTenant = retired && ns && TENANT_ID.test(secrets.LEGACY_TENANT_ID ?? "") ? secrets.LEGACY_TENANT_ID! : null;

  const mcp = MCP_PATH.exec(path);
  if (mcp && validSecretPath(secrets.MCP_SECRET_PATH) && timingSafeEqual(mcp[1]!, secrets.MCP_SECRET_PATH)) {
    if (retired) return legacyTenant ? forward(ns!, legacyTenant, "/__/mcp", req, { "x-djs-legacy": "1" }) : empty(404);
    if (req.method !== "POST") return empty(405, { allow: "POST" });
    return mcpPost(req, deps);
  }

  const apiKey = nonEmpty(secrets.SHORTCUT_API_KEY);
  if (apiKey && path === "/api/playlists" && req.method === "GET") {
    if (!timingSafeEqual(bearer(req), apiKey)) return unauthorized();
    if (retired) return legacyTenant ? forward(ns!, legacyTenant, "/__/shortcut_playlists", req, { "x-djs-legacy": "1" }) : empty(404);
    return apiPlaylists(deps);
  }
  if (apiKey) {
    const m = API_JOB_PATH.exec(path);
    if ((path === "/api/downloads" && req.method === "POST") || (m && req.method === "GET")) {
      if (!timingSafeEqual(bearer(req), apiKey)) return unauthorized();
      if (retired) {
        if (!legacyTenant) return empty(404);
        return forward(ns!, legacyTenant, m ? `/__/shortcut/${m[1]}` : "/__/shortcut", req, { "x-djs-legacy": "1" });
      }
      return m ? apiStatus(decodeURIComponent(m[1]!), deps) : apiSubmit(req, deps);
    }
  }

  const agentToken = nonEmpty(secrets.AGENT_TOKEN);
  if (req.method === "POST" && (path === "/agent/poll" || path === "/agent/library" || AGENT_COMPLETE_PATH.test(path))) {
    if (retired) {
      return json(
        { error: "upgrade_required", detail: `Agent protocol 1 is retired; update DJ Sync (protocol ${AGENT_PROTOCOL_V2}).` },
        410,
      );
    }
    if (agentToken) {
      const done = AGENT_COMPLETE_PATH.exec(path);
      const library = path === "/agent/library";
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

async function health(deps: Deps, retired: boolean): Promise<Response> {
  if (retired) return json({ status: "ok", version: WORKER_VERSION, protocol: AGENT_PROTOCOL_V2 });
  // Until retirement /health keeps describing the v1 Mac (menu app 0.7 reads it).
  const agent = await agentStatus(deps);
  return json({
    status: "ok",
    version: WORKER_VERSION,
    protocol: AGENT_PROTOCOL,
    protocol_v2: AGENT_PROTOCOL_V2,
    agent,
    queued: await deps.store.countQueued(),
  });
}

/** Protocol 2 routes, or null when the path isn't one. */
async function routeV2(req: Request, path: string, secrets: Secrets, ns: Namespaces): Promise<Response | null> {
  if (path === "/v2/register") {
    if (req.method !== "POST") return empty(405, { allow: "POST" });
    return register(req, ns);
  }

  if (path === "/v2/stats") {
    const admin = nonEmpty(secrets.ADMIN_TOKEN);
    if (!admin) return empty(404);
    if (req.method !== "GET") return empty(405, { allow: "GET" });
    if (!timingSafeEqual(bearer(req), admin)) return unauthorized();
    return ns.REGISTRY.get(ns.REGISTRY.idFromName("registry")).fetch("https://registry/__/stats");
  }

  if (path === "/v2/agent" || path.startsWith("/v2/agent/")) {
    const tenant = req.headers.get(TENANT_HEADER)?.trim() ?? "";
    const token = bearer(req);
    const socket = path === "/v2/agent";
    if (!TENANT_ID.test(tenant) || !AGENT_TOKEN.test(token)) {
      return socket
        ? refuseSocket(CLOSE_UNAUTHORIZED, "unauthorized", "Unknown DJ or wrong token; register again.")
        : json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }
    if (socket) return req.method === "GET" ? forward(ns, tenant, "/__/agent", req, { "x-djs-token": token }) : empty(405, { allow: "GET" });
    if (path === "/v2/agent/library") {
      if (req.method !== "PUT") return empty(405, { allow: "PUT" });
      return forward(ns, tenant, "/__/agent/library", req, { "x-djs-token": token }, MAX_LIBRARY_GZIP_BYTES);
    }
    if (path === "/v2/agent/links" || V2_LINK_PATH.test(path)) {
      return forward(ns, tenant, path.replace(/^\/v2\//, "/__/"), req, { "x-djs-token": token });
    }
    return empty(404);
  }

  const mcp = V2_MCP_PATH.exec(path);
  if (mcp) return forward(ns, mcp[1]!, "/__/mcp", req, { "x-djs-link": mcp[2]! });

  const m = API_JOB_PATH.exec(path);
  const playlists = path === "/api/playlists" && req.method === "GET";
  if ((path === "/api/downloads" && req.method === "POST") || (m && req.method === "GET") || playlists) {
    const b = V2_SHORTCUT_BEARER.exec(bearer(req));
    if (b && LINK_SECRET.test(b[2]!)) {
      const to = playlists ? "/__/shortcut_playlists" : m ? `/__/shortcut/${m[1]}` : "/__/shortcut";
      return forward(ns, b[1]!, to, req, { "x-djs-link": b[2]! });
    }
  }
  return null;
}

async function register(req: Request, ns: Namespaces): Promise<Response> {
  const body = await readJson(req);
  if (body.kind === "too_large") return empty(413);
  const b = body.kind === "ok" && typeof body.value === "object" && body.value !== null ? (body.value as Record<string, unknown>) : null;
  if (!b) return json({ error: "invalid_body", detail: "expected a JSON object" }, 400);
  const protocol = parseSemver(typeof b.protocol === "string" ? b.protocol : req.headers.get(PROTOCOL_HEADER));
  if (!protocol) return json({ error: "missing_or_invalid_protocol", detail: "send protocol (semver)" }, 400);
  if (!protocolCompatible(WORKER_PROTOCOL_V2, protocol)) {
    return json(
      {
        error: "incompatible_protocol",
        worker_protocol: AGENT_PROTOCOL_V2,
        agent_protocol: String(b.protocol ?? ""),
        worker_version: WORKER_VERSION,
      },
      409,
    );
  }
  if (b.platform !== "macos") return json({ error: "invalid_body", detail: 'platform must be "macos"' }, 400);
  return ns.REGISTRY.get(ns.REGISTRY.idFromName("registry")).fetch("https://registry/__/register", {
    method: "POST",
    body: JSON.stringify({
      ip: req.headers.get("cf-connecting-ip") ?? "",
      platform: b.platform,
      arch: typeof b.arch === "string" ? b.arch : "",
      agent_version: typeof b.agent_version === "string" ? b.agent_version : "",
    }),
  });
}

/** Forward to one DJ's Tenant with only the allowed headers plus internal auth ones. */
async function forward(
  ns: Namespaces,
  tenantId: string,
  path: string,
  req: Request,
  internal: Record<string, string>,
  maxBody = MAX_BODY_BYTES,
): Promise<Response> {
  const headers = new Headers();
  for (const h of FORWARDED) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  for (const [k, v] of Object.entries(internal)) headers.set(k, v);
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (Number(req.headers.get("content-length") ?? "0") > maxBody) return empty(413);
    const body = await req.arrayBuffer();
    if (body.byteLength > maxBody) return empty(413);
    init.body = body;
  }
  return ns.TENANT.get(ns.TENANT.idFromName(tenantId)).fetch(new Request(`https://tenant${path}`, init));
}

/** Upgrade, then close with `code`, so the Mac sees the same signal a Tenant would send. */
function refuseSocket(code: number, error: string, message: string): Response {
  if (typeof WebSocketPair === "undefined") return json({ error, message }, 401); // not in workerd (tests)
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  server.send(JSON.stringify({ type: "error", code: error, message }));
  server.close(code, error);
  return new Response(null, { status: 101, webSocket: client });
}

function nonEmpty(s: string | undefined): string | null {
  return s && s.trim() !== "" ? s.trim() : null;
}
