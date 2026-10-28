// One DJ: a SQLite Durable Object named by their tenant_id (spec §3). It
// holds their jobs, assistant links, library snapshot and the Mac's
// WebSocket (agent protocol 2.0.0), and runs the same MCP tools as v1.
//
// The Worker (router.ts) only routes. Every credential is checked here
// against a stored hash. Internal routes, never reachable from outside:
//   POST /__/init                    from the Registry, once
//   POST /__/purge                   from the Registry's inactivity sweep
//   POST /__/mcp                     x-djs-link: <secret> | x-djs-legacy: 1
//   POST /__/shortcut, GET /__/shortcut/{id}   same auth; shortcut links only
//   GET  /__/agent (Upgrade)         x-djs-token: <agent_token>
//   PUT  /__/agent/library           ″
//   GET|POST /__/agent/links, POST /__/agent/links/{id}/rotate, DELETE /__/agent/links/{id}

import { DurableObject } from "cloudflare:workers";
import { PROTOCOL_HEADER, VERSION_HEADER, claimedJobView, parseCompletion, parseLibrary } from "./agent";
import { LINK_SECRET, gunzip, isGzip, newLinkSecret, randomBase64url, sha256Hex, utcDay } from "./bytes";
import {
  AGENT_PROTOCOL_V2,
  CLOSE_INCOMPATIBLE,
  CLOSE_OVER_LIMITS,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  LEASE_SECONDS,
  LINK_TOUCH_SECONDS,
  MAX_ACTIVE_IDS,
  MAX_AGENT_CONNECTS_PER_HOUR,
  MAX_JOBS_PER_DAY,
  MAX_LIBRARY_GZIP_BYTES,
  MAX_LIBRARY_JSON_BYTES,
  MAX_LINK_LABEL,
  MAX_LINKS,
  MAX_MCP_CALLS_PER_HOUR,
  MAX_QUEUED_JOBS,
  RETENTION_DAYS,
  WORKER_VERSION,
} from "./constants";
import { apiStatus, apiSubmit, mcpPost, readJson, unauthorized } from "./http";
import { normalizePlaylistName, type Deps } from "./jobs";
import { parseSemver, protocolCompatible } from "./semver";
import { LINK_KINDS, SqlStore, type LinkKind, type LinkRow, type SqlDb } from "./sqlstore";
import { addSeconds, empty, json, timingSafeEqual } from "./util";

export interface TenantEnv {
  REGISTRY?: DurableObjectNamespace;
  DEFAULT_PLAYLIST?: string;
  MAX_URLS?: string;
  PUBLIC_HOST?: string;
}

/** What survives hibernation on the Mac's socket (≤ 16 KB). */
interface AgentAttachment {
  protocol: string;
  agent_version: string | null;
  connected_at: string;
  /** `hello` received. */
  hello: boolean;
  /** The Mac can take one job right now. */
  ready: boolean;
}

const AGENT_TAG = "agent";
const OPEN = 1; // WebSocket.OPEN
const WORKER_PROTOCOL_V2 = parseSemver(AGENT_PROTOCOL_V2)!;
const LINK_LABELS: Record<LinkKind, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  shortcut: "iOS Shortcut",
  other: "Other",
};

type Auth = { kind: "link"; link: LinkRow } | { kind: "legacy" };

export class Tenant extends DurableObject<TenantEnv> {
  /** Overridable clock (tests). */
  clock: () => Date = () => new Date();
  private db: SqlDb;
  private storeCache: SqlStore | null = null;
  /** tools/call timestamps in the last hour (in memory, per spec §3.7). */
  private mcpCalls: number[] = [];

  constructor(ctx: DurableObjectState, env: TenantEnv) {
    super(ctx, env);
    this.db = {
      exec: (q, ...b) => ctx.storage.sql.exec(q, ...b),
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    // Keep-alives are answered without waking this object (spec §3.4).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** `null` until /__/init — an unknown tenant never gets storage. */
  private get store(): SqlStore | null {
    if (!this.storeCache && SqlStore.initialized(this.db)) {
      this.storeCache = new SqlStore(this.db, () => this.agentSocket() !== null, () => this.clock());
    }
    return this.storeCache;
  }

  private deps(store: SqlStore): Deps {
    return {
      store,
      now: () => this.clock(),
      config: {
        defaultPlaylist: this.env.DEFAULT_PLAYLIST || "ChatGPT Downloads",
        maxUrls: Number.parseInt(this.env.MAX_URLS ?? "", 10) || 25,
        publicHost: this.env.PUBLIC_HOST || "",
      },
      admit: async () => {
        if ((await store.countQueued()) >= MAX_QUEUED_JOBS) {
          return `${MAX_QUEUED_JOBS} jobs are already waiting for your Mac; let some finish first.`;
        }
        const today = `${utcDay(this.clock())}T00:00:00.000Z`;
        if (store.countCreatedSince(today) >= MAX_JOBS_PER_DAY) {
          return `That's the daily limit of ${MAX_JOBS_PER_DAY} jobs; it resets at midnight UTC.`;
        }
        return null;
      },
    };
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/__/init" && req.method === "POST") return await this.init(req);
      if (path === "/__/purge" && req.method === "POST") return await this.purge();

      const store = this.store;
      if (path === "/__/agent" && req.method === "GET") {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return empty(426, { upgrade: "websocket" });
        const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
        await this.acceptAgent(server, req.headers);
        return new Response(null, { status: 101, webSocket: client });
      }
      if (!store) return empty(404);

      if (path === "/__/mcp") return await this.mcp(req, store);
      if (path === "/__/shortcut" || path.startsWith("/__/shortcut/")) return await this.shortcut(req, store, path);
      if (path.startsWith("/__/agent/")) return await this.agentRest(req, store, path);
      return empty(404);
    } finally {
      await this.pump();
    }
  }

  // ---------- lifecycle ----------

  private async init(req: Request): Promise<Response> {
    if (SqlStore.initialized(this.db)) return json({ error: "already_initialized" }, 409);
    const b = (await req.json()) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const k of ["tenant_id", "agent_token_hash", "created_at", "platform", "arch", "agent_version"]) {
      if (typeof b[k] === "string") fields[k] = b[k] as string;
    }
    if (!fields.tenant_id || !fields.agent_token_hash) return json({ error: "invalid_body" }, 400);
    new SqlStore(this.db).init(fields);
    return json({ ok: true }, 201);
  }

  /** Delete everything (90 days inactive). A returning Mac gets 4001 and re-registers. */
  async purge(): Promise<Response> {
    for (const ws of this.ctx.getWebSockets(AGENT_TAG)) {
      try {
        ws.close(CLOSE_UNAUTHORIZED, "purged");
      } catch {
        /* already closed */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.storeCache = null;
    return json({ ok: true });
  }

  // ---------- MCP + Shortcut (link auth) ----------

  private async authenticate(req: Request, store: SqlStore): Promise<Auth | null> {
    if (req.headers.get("x-djs-legacy") === "1") return { kind: "legacy" };
    const secret = req.headers.get("x-djs-link") ?? "";
    if (!LINK_SECRET.test(secret)) return null;
    const hash = await sha256Hex(secret);
    let found: LinkRow | null = null;
    for (const l of store.links()) if (timingSafeEqual(l.secret_hash, hash)) found = l; // compare all, constant-time
    if (!found) return null;
    const now = this.clock();
    if (!found.last_used_at || now.getTime() - Date.parse(found.last_used_at) >= LINK_TOUCH_SECONDS * 1000) {
      store.touchLink(found.id, now.toISOString());
    }
    return { kind: "link", link: found };
  }

  private async mcp(req: Request, store: SqlStore): Promise<Response> {
    if (!(await this.authenticate(req, store))) return empty(404);
    if (req.method !== "POST") return empty(405, { allow: "POST" });
    this.cleanupDaily(store);
    return mcpPost(req, this.deps(store), async (msg) => this.rateLimit(msg));
  }

  /** Over 600 tool calls an hour: answer with a tool error instead (spec §3.7). */
  private rateLimit(msg: unknown): unknown | undefined {
    if (typeof msg !== "object" || msg === null || (msg as { method?: unknown }).method !== "tools/call") return undefined;
    const now = this.clock().getTime();
    this.mcpCalls = this.mcpCalls.filter((t) => now - t < 3600_000);
    if (this.mcpCalls.length >= MAX_MCP_CALLS_PER_HOUR) {
      const text = `Too many requests: DJ Sync allows ${MAX_MCP_CALLS_PER_HOUR} tool calls an hour. Try again in a few minutes.`;
      return {
        jsonrpc: "2.0",
        id: (msg as { id?: unknown }).id ?? null,
        result: { content: [{ type: "text", text }], structuredContent: { error: "rate_limited" }, isError: true },
      };
    }
    this.mcpCalls.push(now);
    return undefined;
  }

  private async shortcut(req: Request, store: SqlStore, path: string): Promise<Response> {
    const auth = await this.authenticate(req, store);
    if (!auth || (auth.kind === "link" && auth.link.kind !== "shortcut")) return unauthorized();
    const deps = this.deps(store);
    if (path === "/__/shortcut" && req.method === "POST") return apiSubmit(req, deps);
    const id = path.slice("/__/shortcut/".length);
    if (id !== "" && req.method === "GET") return apiStatus(decodeURIComponent(id), deps);
    return empty(404);
  }

  // ---------- agent REST (library upload, links) ----------

  private async agentAuth(headers: Headers, store: SqlStore | null): Promise<"ok" | "unauthorized" | "incompatible" | "bad_protocol"> {
    const token = headers.get("x-djs-token") ?? "";
    const expected = store?.meta("agent_token_hash") ?? null;
    if (!store || expected === null || token === "" || !timingSafeEqual(await sha256Hex(token), expected)) {
      return "unauthorized";
    }
    const protocol = parseSemver(headers.get(PROTOCOL_HEADER));
    if (!protocol) return "bad_protocol";
    return protocolCompatible(WORKER_PROTOCOL_V2, protocol) ? "ok" : "incompatible";
  }

  private async agentRest(req: Request, store: SqlStore, path: string): Promise<Response> {
    const auth = await this.agentAuth(req.headers, store);
    if (auth === "unauthorized") return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    if (auth === "bad_protocol") {
      return json({ error: "missing_or_invalid_protocol", expected_header: "X-DJ-Sync-Agent-Protocol" }, 400);
    }
    if (auth === "incompatible") return incompatible(req.headers.get(PROTOCOL_HEADER) ?? "");

    if (path === "/__/agent/library" && req.method === "PUT") return this.uploadLibrary(req, store);
    if (path === "/__/agent/links") {
      if (req.method === "GET") return json(store.links().map(linkView));
      if (req.method === "POST") return this.createLink(req, store);
    }
    const m = /^\/__\/agent\/links\/([A-Za-z0-9_-]{1,32})(\/rotate)?$/.exec(path);
    if (m) {
      if (m[2] && req.method === "POST") return this.rotateLink(store, m[1]!);
      if (!m[2] && req.method === "DELETE") return store.deleteLink(m[1]!) ? empty(204) : json({ error: "not_found" }, 404);
    }
    return empty(404);
  }

  private async uploadLibrary(req: Request, store: SqlStore): Promise<Response> {
    if (Number(req.headers.get("content-length") ?? "0") > MAX_LIBRARY_GZIP_BYTES) return empty(413);
    let bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_LIBRARY_GZIP_BYTES) return empty(413);
    // Trust the bytes, not Content-Encoding: plain JSON is accepted too.
    if (isGzip(bytes)) {
      const raw = await gunzip(bytes, MAX_LIBRARY_JSON_BYTES).catch(() => undefined);
      if (raw === null) return empty(413);
      if (raw === undefined) return json({ error: "invalid_body", detail: "body is not valid gzip" }, 400);
      bytes = raw;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ error: "invalid_body", detail: "body is not valid JSON" }, 400);
    }
    const parsed = parseLibrary(body);
    if (typeof parsed === "string") return json({ error: "invalid_body", detail: parsed }, 400);
    await store.putLibrary(parsed.playlists, parsed.tracks);
    await store.setLibraryMeta({
      library_hash: parsed.hash,
      library_generated_at: parsed.generated_at,
      library_version: parsed.library_version,
    });
    return json({ ok: true, playlists: parsed.playlists.length, tracks: parsed.tracks.length });
  }

  private linkUrl(store: SqlStore, secret: string): string {
    return `https://${this.env.PUBLIC_HOST || "mcp.triplejmusic.art"}/${store.meta("tenant_id")}/${secret}/mcp`;
  }

  /** A new link's credentials: the URL (and, for the Shortcut, its bearer). Shown once. */
  private secretView(store: SqlStore, link: LinkRow, secret: string) {
    const host = this.env.PUBLIC_HOST || "mcp.triplejmusic.art";
    return {
      ...linkView(link),
      url: this.linkUrl(store, secret),
      ...(link.kind === "shortcut"
        ? { api_url: `https://${host}/api/downloads`, token: `${store.meta("tenant_id")}.${secret}` }
        : {}),
    };
  }

  private async createLink(req: Request, store: SqlStore): Promise<Response> {
    const body = await readJson(req);
    if (body.kind === "too_large") return empty(413);
    const b = body.kind === "ok" && typeof body.value === "object" && body.value !== null ? (body.value as Record<string, unknown>) : null;
    const kind = b?.kind;
    if (typeof kind !== "string" || !(LINK_KINDS as readonly string[]).includes(kind)) {
      return json({ error: "invalid_body", detail: `kind must be one of ${LINK_KINDS.join(", ")}` }, 400);
    }
    if (b!.label !== undefined && b!.label !== null && typeof b!.label !== "string") {
      return json({ error: "invalid_body", detail: "label must be a string" }, 400);
    }
    const label = normalizePlaylistName((b!.label as string | undefined) ?? null, LINK_LABELS[kind as LinkKind]);
    if (!label.ok || [...label.value].length > MAX_LINK_LABEL) {
      return json({ error: "invalid_body", detail: `label must be at most ${MAX_LINK_LABEL} characters` }, 400);
    }
    if (store.links().length >= MAX_LINKS) return json({ error: "too_many_links", limit: MAX_LINKS }, 409);

    const secret = newLinkSecret();
    const link: LinkRow = {
      id: randomBase64url(9),
      kind: kind as LinkKind,
      label: label.value,
      secret_hash: await sha256Hex(secret),
      created_at: this.clock().toISOString(),
      last_used_at: null,
    };
    store.insertLink(link);
    return json(this.secretView(store, link, secret), 201);
  }

  private async rotateLink(store: SqlStore, id: string): Promise<Response> {
    const secret = newLinkSecret();
    if (!store.setLinkSecret(id, await sha256Hex(secret))) return json({ error: "not_found" }, 404);
    const link = store.links().find((l) => l.id === id)!;
    return json(this.secretView(store, link, secret));
  }

  // ---------- agent WebSocket (protocol 2.0.0, spec §3.4) ----------

  /** The Mac's open socket, if any. */
  private agentSocket(): WebSocket | null {
    return this.ctx.getWebSockets(AGENT_TAG).find((ws) => ws.readyState === OPEN) ?? null;
  }

  /** Accept (or refuse with a close code) the Mac's connection. Split out of fetch() for tests. */
  async acceptAgent(server: WebSocket, headers: Headers): Promise<void> {
    const store = this.store;
    const refuse = (code: number, error: string, message: string) => {
      server.accept();
      server.send(JSON.stringify({ type: "error", code: error, message }));
      server.close(code, error);
    };
    const auth = await this.agentAuth(headers, store);
    if (auth === "unauthorized" || !store) {
      return refuse(CLOSE_UNAUTHORIZED, "unauthorized", "Unknown DJ or wrong token; register again.");
    }
    if (auth !== "ok") {
      return refuse(
        CLOSE_INCOMPATIBLE,
        "incompatible_protocol",
        `This server speaks agent protocol ${AGENT_PROTOCOL_V2}; the Mac sent ${headers.get(PROTOCOL_HEADER) ?? "none"}.`,
      );
    }

    // Runaway reconnects (a bug or a loop) are refused for the rest of the hour.
    const now = this.clock();
    const hour = now.toISOString().slice(0, 13);
    const count = store.meta("connects_hour") === hour ? Number(store.meta("connects") ?? "0") : 0;
    if (count >= MAX_AGENT_CONNECTS_PER_HOUR) {
      return refuse(CLOSE_OVER_LIMITS, "over_limits", `More than ${MAX_AGENT_CONNECTS_PER_HOUR} reconnects this hour.`);
    }
    store.setMeta("connects_hour", hour);
    store.setMeta("connects", String(count + 1));

    // One Mac per DJ: a new connection replaces the old one.
    for (const old of this.ctx.getWebSockets(AGENT_TAG)) {
      try {
        old.close(CLOSE_REPLACED, "replaced");
      } catch {
        /* already gone */
      }
    }
    this.ctx.acceptWebSocket(server, [AGENT_TAG]);
    const att: AgentAttachment = {
      protocol: headers.get(PROTOCOL_HEADER)!.trim(),
      agent_version: headers.get(VERSION_HEADER)?.trim().slice(0, 64) || null,
      connected_at: now.toISOString(),
      hello: false,
      ready: false,
    };
    server.serializeAttachment(att);
    await store.touchAgent({ last_seen: att.connected_at, version: att.agent_version, protocol: att.protocol });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const store = this.store;
    const att = ws.deserializeAttachment() as AgentAttachment | null;
    if (!store || !att) return;
    if (message === "ping") return ws.send("pong"); // normally answered by the auto-response
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = typeof message === "string" ? JSON.parse(message) : null;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      msg = parsed as Record<string, unknown>;
    } catch {
      return sendError(ws, "bad_message", "expected a JSON object frame");
    }

    switch (msg.type) {
      case "hello":
        return this.onHello(ws, att, msg, store);
      case "ready":
        att.ready = true;
        ws.serializeAttachment(att);
        return this.pump();
      case "extend": {
        const active = activeIds(msg.active);
        if (active === null) return sendError(ws, "bad_message", `active must be at most ${MAX_ACTIVE_IDS} job ids`);
        await store.extendLeases(active, this.leaseUntil());
        return this.armAlarm(store);
      }
      case "complete":
        return this.onComplete(ws, msg, store);
      case "library_hash": {
        if (typeof msg.hash !== "string" || msg.hash === "") return sendError(ws, "bad_message", "hash must be a string");
        if (msg.hash !== store.meta("library_hash")) ws.send(JSON.stringify({ type: "library_wanted" }));
        return;
      }
      default:
        return sendError(ws, "bad_message", `unknown frame type ${JSON.stringify(msg.type)}`);
    }
  }

  private async onHello(ws: WebSocket, att: AgentAttachment, msg: Record<string, unknown>, store: SqlStore) {
    const active = activeIds(msg.active);
    if (active === null) return sendError(ws, "bad_message", `active must be at most ${MAX_ACTIVE_IDS} job ids`);
    const hash = msg.library_hash ?? null;
    if (hash !== null && typeof hash !== "string") return sendError(ws, "bad_message", "library_hash must be a string or null");
    if (typeof msg.agent_version === "string") att.agent_version = msg.agent_version.slice(0, 64);

    await store.extendLeases(active, this.leaseUntil());
    att.hello = true;
    att.ready = msg.can_claim === true;
    ws.serializeAttachment(att);

    ws.send(
      JSON.stringify({
        type: "welcome",
        worker_version: WORKER_VERSION,
        protocol: AGENT_PROTOCOL_V2,
        library_wanted: hash !== null && hash !== store.meta("library_hash"),
      }),
    );
    this.cleanupDaily(store);
    await this.noteSeenToday(store);
    await this.armAlarm(store);
    // pump() runs after every message (webSocketMessage's caller doesn't, so do it here).
    await this.pump();
  }

  private async onComplete(ws: WebSocket, msg: Record<string, unknown>, store: SqlStore) {
    const jobId = typeof msg.job_id === "string" ? msg.job_id : "";
    const parsed = parseCompletion(msg);
    if (jobId === "" || typeof parsed === "string") {
      return sendError(ws, "bad_message", typeof parsed === "string" ? parsed : "job_id must be a string");
    }
    // Completions are idempotent, as in v1; `result` says what happened.
    const job = await store.getJob(jobId);
    let result: "ok" | "duplicate" | "not_found" | "already_finished" = "ok";
    if (!job) result = "not_found";
    else if (job.state === parsed.state) result = "duplicate";
    else if (job.state === "done" || job.state === "failed") result = "already_finished";
    else await store.finishJob(jobId, parsed.state, parsed.message, parsed.result, this.clock().toISOString());
    ws.send(JSON.stringify({ type: "ack", job_id: jobId, result }));
    await this.armAlarm(store);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.store?.setMeta("last_seen", this.clock().toISOString());
    void ws; // compatibility date ≥ 2026-04-07 replies to Close frames itself
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ---------- delivery and leases (spec §3.5) ----------

  private leaseUntil(): string {
    return addSeconds(this.clock(), LEASE_SECONDS).toISOString();
  }

  /** Hand the oldest queued job to the Mac if it's connected and ready. */
  async pump(): Promise<void> {
    const store = this.store;
    const ws = this.agentSocket();
    if (!store || !ws) return;
    const att = ws.deserializeAttachment() as AgentAttachment | null;
    if (!att?.hello || !att.ready) return;
    att.ready = false; // one job at a time; set before claiming
    ws.serializeAttachment(att);
    const job = await store.claimNext(this.clock().toISOString(), this.leaseUntil(), true);
    if (!job) {
      att.ready = true;
      ws.serializeAttachment(att);
      return;
    }
    ws.send(JSON.stringify({ type: "job", ...claimedJobView(job) }));
    await this.armAlarm(store);
  }

  /** An alarm only while something is leased (alarms are billed requests). */
  private async armAlarm(store: SqlStore): Promise<void> {
    const earliest = store.earliestLease();
    if (earliest === null) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const at = Date.parse(earliest) + 1000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const store = this.store;
    if (!store) return;
    const expired = store.expireLeases(this.clock().toISOString());
    if (expired.length > 0) console.log(`lease expired for ${expired.length} job(s); requeued`);
    await this.pump();
    await this.armAlarm(store);
  }

  // ---------- housekeeping ----------

  /** Lazy 30-day retention, at most once a day (spec §3.5). */
  private cleanupDaily(store: SqlStore): void {
    const today = utcDay(this.clock());
    if (store.meta("cleanup_day") === today) return;
    store.setMeta("cleanup_day", today);
    void store.purgeFinishedBefore(addSeconds(this.clock(), -RETENTION_DAYS * 86400).toISOString());
  }

  /** Tell the Registry this DJ is active, once per UTC day. */
  private async noteSeenToday(store: SqlStore): Promise<void> {
    const today = utcDay(this.clock());
    if (store.meta("seen_day") === today) return;
    store.setMeta("seen_day", today);
    const registry = this.env.REGISTRY;
    if (!registry) return;
    try {
      await registry.get(registry.idFromName("registry")).fetch("https://registry/__/touch", {
        method: "POST",
        body: JSON.stringify({ tenant_id: store.meta("tenant_id"), day: today }),
      });
    } catch (e) {
      console.error(`registry touch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function linkView(l: LinkRow) {
  return { id: l.id, kind: l.kind, label: l.label, created_at: l.created_at, last_used_at: l.last_used_at };
}

function activeIds(v: unknown): string[] | null {
  const a = v ?? [];
  if (!Array.isArray(a) || a.length > MAX_ACTIVE_IDS || !a.every((x) => typeof x === "string")) return null;
  return a as string[];
}

function sendError(ws: WebSocket, code: string, message: string): void {
  ws.send(JSON.stringify({ type: "error", code, message }));
}

function incompatible(agentProtocol: string): Response {
  return json(
    {
      error: "incompatible_protocol",
      worker_protocol: AGENT_PROTOCOL_V2,
      agent_protocol: agentProtocol,
      worker_version: WORKER_VERSION,
    },
    409,
  );
}
