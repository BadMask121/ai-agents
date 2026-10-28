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
//   GET  /__/shortcut_playlists      shortcut link auth (GET /api/playlists)
//   POST /__/telegram/bind|unbind|update   from the Worker's Telegram webhook

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
  MAX_SHORTCUT_BYTES,
  RETENTION_DAYS,
  SHORTCUT_INSTALL_DOWNLOADS,
  SHORTCUT_INSTALL_SECONDS,
  TELEGRAM_MESSAGES_PER_HOUR,
  TELEGRAM_PAIRING_SECONDS,
  WORKER_VERSION,
} from "./constants";
import { SHORTCUT_DISCONNECTED, apiPlaylists, apiStatus, apiSubmit, mcpPost, readJson, unauthorized } from "./http";
import { SHORTCUT_FILENAME, installExpired, installPage, shortcutFile } from "./install";
import { normalizePlaylistName, type Deps } from "./jobs";
import { parseSemver, protocolCompatible } from "./semver";
import { LINK_KINDS, SqlStore, type LinkKind, type LinkRow, type SqlDb, type TelegramChat } from "./sqlstore";
import { botApi, send, telegramConfigured, type TelegramApi, type TelegramEnv, type TgUpdate } from "./telegram";
import type { AiRunner } from "./telegram-agent";
import { handleUpdate, welcome } from "./telegram-bot";
import { addSeconds, empty, json, publicHosts, timingSafeEqual } from "./util";

export interface TenantEnv extends TelegramEnv {
  REGISTRY?: DurableObjectNamespace;
  /** Workers AI, for the Telegram assistant (spec §1c); without it the bot is rule-based. */
  AI?: AiRunner;
  /** Overrides AGENT_MODEL. */
  AI_MODEL?: string;
  DEFAULT_PLAYLIST?: string;
  MAX_URLS?: string;
  PUBLIC_HOST?: string;
  PUBLIC_HOST_ALIASES?: string;
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
  telegram: "Telegram",
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
  /** The Bot API; tests set a fake. */
  telegramApi: TelegramApi | null = null;
  /** Workers AI; tests set a fake (otherwise env.AI). */
  aiRunner: AiRunner | null = null;
  /** Telegram messages per chat in the last hour (in memory). */
  private tgRate = new Map<string, { times: number[]; warned: boolean }>();

  constructor(ctx: DurableObjectState, env: TenantEnv) {
    super(ctx, env);
    this.db = {
      exec: (q, ...b) => ctx.storage.sql.exec(q, ...b),
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    // Keep-alives are answered without waking this object (spec §3.4).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get telegram(): TelegramApi | null {
    if (this.telegramApi) return this.telegramApi;
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim();
    return token ? botApi(token) : null;
  }

  /** `null` until /__/init — an unknown tenant never gets storage. */
  private get store(): SqlStore | null {
    if (!this.storeCache && SqlStore.initialized(this.db)) {
      SqlStore.migrate(this.db);
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
        publicHost: publicHosts(this.env),
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
      if (path.startsWith("/__/install/")) return await this.install(req, store, path);
      if (path === "/__/agent" && req.method === "GET") {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return empty(426, { upgrade: "websocket" });
        const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
        await this.acceptAgent(server, req.headers);
        return new Response(null, { status: 101, webSocket: client });
      }
      if (!store) {
        // A purged DJ's Shortcut: say so in its notification.
        return path.startsWith("/__/shortcut") ? unauthorized(SHORTCUT_DISCONNECTED) : empty(404);
      }

      if (path === "/__/mcp") return await this.mcp(req, store);
      if (path === "/__/shortcut" || path.startsWith("/__/shortcut/") || path === "/__/shortcut_playlists") {
        return await this.shortcut(req, store, path);
      }
      if (path.startsWith("/__/telegram/") && req.method === "POST") return await this.telegramRoute(req, store, path);
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
    if (!auth || (auth.kind === "link" && auth.link.kind !== "shortcut")) return unauthorized(SHORTCUT_DISCONNECTED);
    const deps = this.deps(store);
    if (path === "/__/shortcut_playlists") return req.method === "GET" ? apiPlaylists(deps) : empty(405, { allow: "GET" });
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
      if (req.method === "GET") {
        const chats = new Map(store.telegramChats().map((c) => [c.link_id, c]));
        return json(store.links().map((l) => linkView(l, chats.get(l.id) ?? null)));
      }
      if (req.method === "POST") return this.createLink(req, store);
    }
    const m = /^\/__\/agent\/links\/([A-Za-z0-9_-]{1,32})(\/rotate|\/install)?$/.exec(path);
    if (m) {
      if (m[2] === "/rotate" && req.method === "POST") return this.rotateLink(store, m[1]!);
      if (m[2] === "/install" && req.method === "PUT") return this.uploadInstall(req, store, m[1]!);
      if (!m[2] && req.method === "DELETE") {
        const link = store.links().find((l) => l.id === m[1]);
        if (!link) return json({ error: "not_found" }, 404);
        if (link.kind === "telegram") await this.unpairTelegram(store, link.id, "Disconnected from DJ Sync on the Mac.");
        store.deleteLink(link.id);
        return empty(204);
      }
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
    return `https://${this.env.PUBLIC_HOST || "djsync.jeffrey.build"}/${store.meta("tenant_id")}/${secret}/mcp`;
  }

  /** A new link's credentials: the URL (and, for the Shortcut, its bearer). Shown once. */
  private secretView(store: SqlStore, link: LinkRow, secret: string) {
    const host = this.env.PUBLIC_HOST || "djsync.jeffrey.build";
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
    if (kind === "telegram" && !telegramConfigured(this.env)) {
      return json({ error: "telegram_not_configured", detail: "The DJ Sync Telegram bot isn't set up on this server yet." }, 503);
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
    if (link.kind === "telegram") {
      const view = await this.pairingView(store, link);
      if (!view) {
        store.deleteLink(link.id);
        return json({ error: "unavailable", detail: "Couldn't start Telegram pairing; try again." }, 503);
      }
      return json(view, 201);
    }
    return json(this.secretView(store, link, secret), 201);
  }

  private async rotateLink(store: SqlStore, id: string): Promise<Response> {
    const secret = newLinkSecret();
    if (!store.setLinkSecret(id, await sha256Hex(secret))) return json({ error: "not_found" }, 404);
    const link = store.links().find((l) => l.id === id)!;
    if (link.kind === "telegram") {
      // A new code, and whichever chat was paired is let go.
      await this.unpairTelegram(store, link.id, "Disconnected: DJ Sync on the Mac made a new Telegram link.");
      const view = await this.pairingView(store, link);
      return view ? json(view) : json({ error: "unavailable", detail: "Couldn't start Telegram pairing; try again." }, 503);
    }
    return json(this.secretView(store, link, secret));
  }

  // ---------- one-scan iPhone install (connect-anywhere spec §2b) ----------

  /** PUT /v2/agent/links/{id}/install: the Mac's signed Shortcut → a short-lived install link. */
  private async uploadInstall(req: Request, store: SqlStore, id: string): Promise<Response> {
    const link = store.links().find((l) => l.id === id);
    if (!link) return json({ error: "not_found" }, 404);
    if (link.kind !== "shortcut") {
      return json({ error: "not_a_shortcut_link", detail: "Only shortcut links have an iPhone install." }, 409);
    }
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > MAX_SHORTCUT_BYTES) return empty(413);
    if (bytes.byteLength === 0) return json({ error: "invalid_body", detail: "send the signed .shortcut file as the body" }, 400);
    const code = randomBase64url(16);
    const now = this.clock();
    const expiresAt = addSeconds(now, SHORTCUT_INSTALL_SECONDS).toISOString();
    store.purgeInstallsBefore(now.toISOString());
    store.putInstall(link.id, await sha256Hex(code), bytes, expiresAt);
    const host = this.env.PUBLIC_HOST || "djsync.jeffrey.build";
    return json({ install_url: `https://${host}/i/${store.meta("tenant_id")}/${code}`, expires_at: expiresAt });
  }

  /** GET /i/<tenant>/<code> (the page) and …/<code>/DJ Sync.shortcut (the file, counted). */
  private async install(req: Request, store: SqlStore | null, path: string): Promise<Response> {
    const m = /^\/__\/install\/([A-Za-z0-9_-]{22})(\/file)?$/.exec(path);
    if (!m || !store) return installExpired();
    const hash = await sha256Hex(m[1]!);
    const now = this.clock().toISOString();
    if (!m[2]) {
      if (!store.installLive(hash, now, SHORTCUT_INSTALL_DOWNLOADS)) return installExpired();
      return installPage(`/i/${store.meta("tenant_id")}/${m[1]}/${encodeURIComponent(SHORTCUT_FILENAME)}`);
    }
    const head = req.method === "HEAD";
    const bytes = head
      ? store.installBytes(hash, now, SHORTCUT_INSTALL_DOWNLOADS)
      : store.takeInstallDownload(hash, now, SHORTCUT_INSTALL_DOWNLOADS);
    return bytes ? shortcutFile(bytes, head) : installExpired();
  }

  // ---------- Telegram (connect-anywhere spec §1) ----------

  private registryStub() {
    const ns = this.env.REGISTRY;
    return ns ? ns.get(ns.idFromName("registry")) : null;
  }

  /** A fresh one-time pairing code for a telegram link, as the Mac shows it. */
  private async pairingView(store: SqlStore, link: LinkRow) {
    const registry = this.registryStub();
    if (!registry) return null;
    const code = randomBase64url(16);
    const expiresAt = addSeconds(this.clock(), TELEGRAM_PAIRING_SECONDS).toISOString();
    const res = await registry.fetch("https://registry/__/telegram/code", {
      method: "POST",
      body: JSON.stringify({ code, tenant_id: store.meta("tenant_id"), link_id: link.id, expires_at: expiresAt }),
    });
    if (res.status !== 201) return null;
    return {
      ...linkView(link, null),
      url: `https://t.me/${this.env.TELEGRAM_BOT_USERNAME!.trim().replace(/^@/, "")}?start=${code}`,
      expires_at: expiresAt,
    };
  }

  /** Let go of a telegram link's chat (here and in the Registry) and tell it why. */
  private async unpairTelegram(store: SqlStore, linkId: string, why: string): Promise<void> {
    const chat = store.unbindTelegramLink(linkId);
    try {
      await this.registryStub()?.fetch("https://registry/__/telegram/forget_link", {
        method: "POST",
        body: JSON.stringify({ tenant_id: store.meta("tenant_id"), link_id: linkId }),
      });
    } catch (e) {
      console.error(`registry forget_link failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const api = this.telegram;
    if (chat && api && why !== "") await send(api, chat, why);
  }

  private async telegramRoute(req: Request, store: SqlStore, path: string): Promise<Response> {
    const b = (await req.json()) as Record<string, unknown>;
    const api = this.telegram;
    const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

    if (path === "/__/telegram/unbind") {
      const chat = str(b.chat_id);
      if (chat) store.unbindTelegramChat(chat);
      return json({ ok: true });
    }
    if (path === "/__/telegram/bind") {
      const [linkId, chatId] = [str(b.link_id), str(b.chat_id)];
      const link = store.links().find((l) => l.id === linkId && l.kind === "telegram");
      if (!link || !chatId) return json({ error: "not_found" }, 404);
      const chat: TelegramChat = {
        link_id: link.id,
        chat_id: chatId,
        username: str(b.username)?.slice(0, 64) ?? null,
        first_name: str(b.first_name)?.slice(0, 64) ?? null,
        paired_at: this.clock().toISOString(),
      };
      store.bindTelegram(chat);
      store.touchLink(link.id, chat.paired_at);
      if (api) await send(api, chatId, welcome(chat.first_name));
      return json({ ok: true });
    }
    if (path === "/__/telegram/update") {
      const linkId = str(b.link_id);
      const link = store.links().find((l) => l.id === linkId && l.kind === "telegram");
      if (!link || !api || typeof b.update !== "object" || b.update === null) return json({ error: "not_found" }, 404);
      const now = this.clock();
      if (!link.last_used_at || now.getTime() - Date.parse(link.last_used_at) >= LINK_TOUCH_SECONDS * 1000) {
        store.touchLink(link.id, now.toISOString());
      }
      this.cleanupDaily(store);
      const handled = await handleUpdate(
        {
          store,
          deps: this.deps(store),
          api,
          now: () => this.clock(),
          disconnect: async (id) => {
            await this.unpairTelegram(store, id, "");
            store.deleteLink(id);
          },
          rateLimit: (chatId) => this.telegramRate(chatId),
          agent: (this.aiRunner ?? this.env.AI) ? { ai: (this.aiRunner ?? this.env.AI)!, model: this.env.AI_MODEL } : null,
        },
        b.update as TgUpdate,
        link.id,
      );
      return handled ? json({ ok: true }) : json({ error: "not_paired" }, 404);
    }
    return empty(404);
  }

  /** At most TELEGRAM_MESSAGES_PER_HOUR per chat; the first one over gets a warning. */
  private telegramRate(chatId: string): "ok" | "warn" | "drop" {
    const now = this.clock().getTime();
    const r = this.tgRate.get(chatId) ?? { times: [], warned: false };
    r.times = r.times.filter((t) => now - t < 3600_000);
    this.tgRate.set(chatId, r);
    if (r.times.length >= TELEGRAM_MESSAGES_PER_HOUR) {
      if (r.warned) return "drop";
      r.warned = true;
      return "warn";
    }
    r.warned = false;
    r.times.push(now);
    return "ok";
  }

  /** Tell the chat that asked for a job how it went. */
  private async notifyTelegram(store: SqlStore, jobId: string, state: "done" | "failed", message: string): Promise<void> {
    const chat = store.takeTgJob(jobId);
    const api = this.telegram;
    if (!chat || !api) return;
    await send(api, chat, `${state === "done" ? "✅" : "⚠️"} ${message}`);
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
    if (result === "ok") await this.notifyTelegram(store, jobId, parsed.state, parsed.message);
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

function linkView(l: LinkRow, chat: TelegramChat | null = null) {
  const view = { id: l.id, kind: l.kind, label: l.label, created_at: l.created_at, last_used_at: l.last_used_at };
  if (l.kind !== "telegram") return view;
  const who = chat?.username ? `@${chat.username}` : (chat?.first_name ?? null);
  return {
    ...view,
    label: chat && who ? `Telegram (${who})` : l.label,
    paired: chat !== null,
    telegram_username: chat?.username ?? null,
  };
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
