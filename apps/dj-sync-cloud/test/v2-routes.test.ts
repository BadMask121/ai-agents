import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL, CLOSE_UNAUTHORIZED, REGISTRATIONS_PER_DAY, REGISTRATIONS_PER_IP_PER_DAY, WORKER_VERSION } from "../src/constants";
import { ADMIN, YT, agentHeaders, makeCloud, req, type Any } from "./cloud";
import { AGENT_TOKEN, SECRET, SHORTCUT_KEY } from "./helpers";

const stats = async (c: ReturnType<typeof makeCloud>, token = ADMIN) =>
  c.call(req("GET", "/v2/stats", undefined, { authorization: `Bearer ${token}` }));

describe("registration (spec §3.2, §3.7)", () => {
  it("creates a DJ with a tenant id and agent token, storing only a hash", async () => {
    const c = makeCloud();
    const res = await c.register();
    expect(res.status).toBe(201);
    const t = (await res.json()) as Any;
    expect(t.tenant_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(t.agent_token).toMatch(/^djsa_[A-Za-z0-9_-]{43}$/);
    expect(t.worker_version).toBe(WORKER_VERSION);
    const meta = c.TENANT.ctxs.get(t.tenant_id)!.storage.sql.exec("SELECT key, value FROM meta").toArray();
    const values = meta.map((r) => String(r.value));
    expect(values).not.toContain(t.agent_token);
    expect(meta.find((r) => r.key === "agent_token_hash")!.value).toMatch(/^[0-9a-f]{64}$/);
    // The new DJ works straight away.
    expect((await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(t)))).status).toBe(200);
  });

  it("validates protocol and platform", async () => {
    const c = makeCloud();
    expect((await c.register(undefined, { protocol: AGENT_PROTOCOL })).status).toBe(409);
    expect((await c.register(undefined, { protocol: "nope" })).status).toBe(400);
    expect((await c.register(undefined, { platform: "windows" })).status).toBe(400);
    expect((await c.call(req("POST", "/v2/register", "{bad"))).status).toBe(400);
    expect((await c.call(req("GET", "/v2/register"))).status).toBe(405);
  });

  it("allows 5 sign-ups per IP per UTC day, and pauses at the global cap", async () => {
    const c = makeCloud();
    for (let i = 0; i < REGISTRATIONS_PER_IP_PER_DAY; i++) expect((await c.register("192.0.2.1")).status).toBe(201);
    const limited = await c.register("192.0.2.1");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited", retry_after: 12 * 3600 });
    expect((await c.register("192.0.2.2")).status).toBe(201);
    c.advance(12 * 3600);
    expect((await c.register("192.0.2.1")).status).toBe(201); // a new day

    // IPs are only kept as salted per-day hashes.
    const sql = c.REGISTRY.ctxs.get("registry")!.storage.sql;
    const hashes = sql.exec("SELECT ip_hash FROM registrations").toArray().map((r) => String(r.ip_hash));
    expect(hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);

    sql.exec("UPDATE days SET registrations = ? WHERE day = ?", REGISTRATIONS_PER_DAY, c.now().toISOString().slice(0, 10));
    const paused = await c.register("192.0.2.9");
    expect(paused.status).toBe(503);
    expect(await paused.json()).toMatchObject({ error: "registration_paused" });
  });
});

describe("stats and the inactivity sweep (spec §3.7)", () => {
  it("counts DJs and recent activity behind ADMIN_TOKEN", async () => {
    const c = makeCloud();
    const a = await c.registered("198.51.100.1");
    await c.registered("198.51.100.2");
    const ws = await c.connect(a);
    await c.hello(a, ws);
    expect((await stats(c, "wrong")).status).toBe(401);
    expect(await (await stats(c)).json()).toEqual({ tenants: 2, active_24h: 1, active_7d: 1, registrations_24h: 2 });
    const off = makeCloud(undefined, { ADMIN_TOKEN: "" });
    expect((await stats(off)).status).toBe(404);
  });

  it("purges DJs whose Mac hasn't connected for 90 days; a returning Mac must re-register", async () => {
    const c = makeCloud();
    const active = await c.registered("198.51.100.1");
    const idle = await c.registered("198.51.100.2");
    const { url } = await c.link(idle);
    c.advance(89 * 86_400);
    const ws = await c.connect(active);
    await c.hello(active, ws); // seen today
    c.advance(2 * 86_400);

    const registry = c.REGISTRY.instance("registry");
    expect(await registry.sweep()).toEqual({ purged: 1, more: false });
    expect(await (await stats(c)).json()).toMatchObject({ tenants: 1 });
    // The idle DJ's data is gone: links 404, the Mac's socket gets 4001.
    expect((await c.mcp(url, { jsonrpc: "2.0", id: 1, method: "ping" }))[0]).toBe(404);
    expect((await c.connect(idle)).closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(c.TENANT.ctxs.get(idle.tenant_id)!.storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    expect((await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(active)))).status).toBe(200);
  });

  it("sweeps in batches, continuing from an alarm", async () => {
    const c = makeCloud();
    const sql = c.REGISTRY.instance("registry") && c.REGISTRY.ctxs.get("registry")!.storage.sql;
    for (let i = 0; i < 45; i++) sql.exec("INSERT INTO tenants (id, created_at, last_seen_day) VALUES (?, '2026-01-01T00:00:00Z', NULL)", `t${String(i).padStart(21, "0")}`);
    const registry = c.REGISTRY.instance("registry");
    expect(await registry.sweep()).toEqual({ purged: 40, more: true });
    expect(c.REGISTRY.ctxs.get("registry")!.storage.alarm).not.toBeNull();
    await registry.alarm();
    expect(sql.exec("SELECT COUNT(*) AS n FROM tenants").toArray()[0]!.n).toBe(0);
  });
});

describe("uninstall: DELETE /v2/agent forgets the DJ (uninstaller spec §2)", () => {
  it("purges the DJ and drops it from the Registry, Telegram pairing included", async () => {
    const c = makeCloud();
    const gone = await c.registered("198.51.100.1");
    const kept = await c.registered("198.51.100.2");
    const { url } = await c.link(gone);
    const ws = await c.connect(gone);
    await c.hello(gone, ws);
    const sql = c.REGISTRY.ctxs.get("registry")!.storage.sql;
    sql.exec("INSERT INTO telegram_chats (chat_id, tenant_id, link_id) VALUES ('42', ?, 'l1')", gone.tenant_id);
    sql.exec("INSERT INTO pairing_codes (code, tenant_id, link_id, expires_at) VALUES ('c1', ?, 'l1', '2099-01-01')", gone.tenant_id);

    const res = await c.call(req("DELETE", "/v2/agent", undefined, agentHeaders(gone)));
    expect(res.status).toBe(204);
    expect(ws.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect((await c.mcp(url, { jsonrpc: "2.0", id: 1, method: "ping" }))[0]).toBe(404);
    expect(c.TENANT.ctxs.get(gone.tenant_id)!.storage.sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    const left = (table: string) => sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === "tenants" ? "id" : "tenant_id"} = ?`, gone.tenant_id).toArray()[0]!.n;
    expect([left("tenants"), left("telegram_chats"), left("pairing_codes")]).toEqual([0, 0, 0]);
    expect(await (await stats(c)).json()).toMatchObject({ tenants: 1 });

    // Already forgotten: 404, which the Mac treats as done. Other DJs are untouched.
    expect((await c.call(req("DELETE", "/v2/agent", undefined, agentHeaders(gone)))).status).toBe(404);
    expect((await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(kept)))).status).toBe(200);
  });

  it("needs the DJ's own agent token, but no protocol header", async () => {
    const c = makeCloud();
    const a = await c.registered("198.51.100.1");
    const b = await c.registered("198.51.100.2");
    const as = (t: Any, token: string) => ({ authorization: `Bearer ${token}`, "x-dj-sync-tenant": t.tenant_id });
    expect((await c.call(req("DELETE", "/v2/agent", undefined, as(a, b.agent_token)))).status).toBe(401);
    expect((await c.call(req("DELETE", "/v2/agent", undefined, as(a, "nope")))).status).toBe(401);
    expect((await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(a)))).status).toBe(200);
    expect((await c.call(req("DELETE", "/v2/agent", undefined, as(a, a.agent_token)))).status).toBe(204);
    expect((await c.call(req("POST", "/v2/agent", undefined, agentHeaders(b)))).status).toBe(405);
  });

  it("answers a non-upgrade request without credentials with a JSON 401, even where sockets exist", async () => {
    const c = makeCloud();
    const g = globalThis as Any;
    const had = g.WebSocketPair;
    g.WebSocketPair = class {
      0 = {};
      1 = { accept() {}, send() {}, close() {} };
    };
    try {
      for (const method of ["DELETE", "GET"]) {
        const res = await c.call(req(method, "/v2/agent"));
        expect(res.status, method).toBe(401);
        expect(await res.json()).toMatchObject({ error: "unauthorized" });
      }
    } finally {
      g.WebSocketPair = had;
    }
  });
});

describe("protocol 1 → 2 transition (spec §3.9)", () => {
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  it("leaves v1 untouched until V1_RETIRED, with protocol_v2 in /health", async () => {
    const c = makeCloud();
    const health = await (await c.call(req("GET", "/health"))).json();
    expect(health).toMatchObject({ version: WORKER_VERSION, protocol: AGENT_PROTOCOL, protocol_v2: "2.0.0", agent: { online: false } });
    expect((await c.mcp(`https://mcp.example.test/${SECRET}/mcp`, ping))[0]).toBe(200);
    const poll = await c.call(
      req("POST", "/agent/poll", { active: [], can_claim: false }, {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "x-dj-sync-agent-protocol": AGENT_PROTOCOL,
        "x-dj-sync-agent-version": "0.8.0",
      }),
    );
    expect(poll.status).toBe(200);
  });

  it("after retirement: legacy secrets reach LEGACY_TENANT_ID, /agent/* is 410", async () => {
    const c = makeCloud();
    const owner = await c.registered();
    c.secrets = { ...c.secrets, V1_RETIRED: "true", LEGACY_TENANT_ID: owner.tenant_id };

    expect(await (await c.call(req("GET", "/health"))).json()).toEqual({ status: "ok", version: WORKER_VERSION, protocol: "2.0.0" });

    // The owner's old ChatGPT URL and Shortcut key now land in their tenant.
    const legacyUrl = `https://mcp.example.test/${SECRET}/mcp`;
    const [s, body] = await c.mcp(legacyUrl, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "download_to_rekordbox", arguments: { urls: [YT(1)] } } });
    expect(s).toBe(200);
    const jobId = body.result.structuredContent.job_id;
    const sc = await c.call(req("POST", "/api/downloads", { url: YT(2) }, { authorization: `Bearer ${SHORTCUT_KEY}` }));
    expect(sc.status).toBe(202);
    expect((await c.call(req("POST", "/api/downloads", { url: YT(3) }, { authorization: "Bearer wrong" }))).status).toBe(401);

    const ws = await c.connect(owner);
    await c.hello(owner, ws);
    expect(ws.last()).toMatchObject({ type: "job", job_id: jobId });

    for (const path of ["/agent/poll", "/agent/library", "/agent/jobs/abc/complete"]) {
      const r = await c.call(req("POST", path, {}, { authorization: `Bearer ${AGENT_TOKEN}` }));
      expect(r.status, path).toBe(410);
      expect(await r.json()).toMatchObject({ error: "upgrade_required" });
    }

    // Without LEGACY_TENANT_ID the old secrets lead nowhere.
    c.secrets = { ...c.secrets, LEGACY_TENANT_ID: undefined };
    expect((await c.mcp(legacyUrl, ping))[0]).toBe(404);
  });

  it("rejects malformed agent credentials before touching a Durable Object", async () => {
    const c = makeCloud();
    const res = await c.call(req("GET", "/v2/agent/links", undefined, { authorization: "Bearer x", "x-dj-sync-tenant": "short" }));
    expect(res.status).toBe(401);
    expect(c.TENANT.instances.size).toBe(0);
    const sock = await c.call(req("GET", "/v2/agent", undefined, { authorization: "Bearer x", "x-dj-sync-tenant": "short" }));
    expect(sock.status).toBe(401); // workerd: 101 + close 4001
  });
});
