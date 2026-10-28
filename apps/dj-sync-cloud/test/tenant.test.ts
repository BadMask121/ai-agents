import { describe, expect, it } from "vitest";
import { gzip } from "../src/bytes";
import {
  CLOSE_INCOMPATIBLE,
  CLOSE_OVER_LIMITS,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  LEASE_SECONDS,
  MAX_AGENT_CONNECTS_PER_HOUR,
  MAX_JOBS_PER_DAY,
  MAX_LINKS,
  MAX_MCP_CALLS_PER_HOUR,
  MAX_QUEUED_JOBS,
  WORKER_VERSION,
} from "../src/constants";
import { YT, agentHeaders, makeCloud, req, type Any } from "./cloud";

const LIBRARY = {
  hash: "h1",
  generated_at: "2026-10-28T11:00:00Z",
  library_version: "1.2.0",
  playlists: [{ id: "1", name: "Friday", folder: "DJ Sync", track_ids: ["101"] }],
  tracks: [{ id: "101", title: "Ye", artist: "Burna Boy", album: null, genre: "Afrobeats", bpm: 102, key: "8A", duration_secs: 231 }],
};

const upload = async (c: ReturnType<typeof makeCloud>, t: Any, body: Uint8Array | string) =>
  c.call(req("PUT", "/v2/agent/library", body, { ...agentHeaders(t), "content-encoding": "gzip" }));

describe("links (spec §3.2)", () => {
  it("creates, lists, rotates and revokes per-assistant links", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const chatgpt = await c.link(t, "chatgpt");
    expect(chatgpt).toMatchObject({ kind: "chatgpt", label: "ChatGPT", last_used_at: null });
    expect(chatgpt.url).toMatch(new RegExp(`^https://mcp\\.example\\.test/${t.tenant_id}/[A-Za-z0-9_-]{43}/mcp$`));

    // Listing never shows a URL or secret.
    const list = await (await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(t)))).json();
    expect(list).toEqual([{ id: chatgpt.id, kind: "chatgpt", label: "ChatGPT", created_at: chatgpt.created_at, last_used_at: null }]);

    // Use marks last_used_at (the onboarding live check).
    const [s1] = await c.mcp(chatgpt.url, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(s1).toBe(200);
    const used = (await (await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(t)))).json()) as Any;
    expect(used[0].last_used_at).toBe(c.now().toISOString());

    // Rotate: the old URL stops working at once.
    const rotated = (await (await c.call(req("POST", `/v2/agent/links/${chatgpt.id}/rotate`, {}, agentHeaders(t)))).json()) as Any;
    expect(rotated.url).not.toBe(chatgpt.url);
    expect((await c.mcp(chatgpt.url, { jsonrpc: "2.0", id: 1, method: "ping" }))[0]).toBe(404);
    expect((await c.mcp(rotated.url, { jsonrpc: "2.0", id: 1, method: "ping" }))[0]).toBe(200);

    // Disconnect.
    expect((await c.call(req("DELETE", `/v2/agent/links/${chatgpt.id}`, undefined, agentHeaders(t)))).status).toBe(204);
    expect((await c.mcp(rotated.url, { jsonrpc: "2.0", id: 1, method: "ping" }))[0]).toBe(404);
    expect((await c.call(req("DELETE", `/v2/agent/links/${chatgpt.id}`, undefined, agentHeaders(t)))).status).toBe(404);
  });

  it("validates kinds and caps links at 10", async () => {
    const c = makeCloud();
    const t = await c.registered();
    expect((await c.call(req("POST", "/v2/agent/links", { kind: "telegram" }, agentHeaders(t)))).status).toBe(400);
    expect((await c.call(req("POST", "/v2/agent/links", { kind: "claude", label: 7 }, agentHeaders(t)))).status).toBe(400);
    const claude = await c.link(t, "claude", "  Studio\nMac  ");
    expect(claude.label).toBe("Studio Mac");
    for (let i = 1; i < MAX_LINKS; i++) await c.link(t, "other");
    const res = await c.call(req("POST", "/v2/agent/links", { kind: "other" }, agentHeaders(t)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "too_many_links", limit: MAX_LINKS });
  });

  it("needs the agent token and protocol 2 for link management", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const bad = { ...t, agent_token: `djsa_${"x".repeat(43)}` };
    expect((await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(bad)))).status).toBe(401);
    expect((await c.call(req("GET", "/v2/agent/links", undefined, { ...agentHeaders(t), authorization: "Bearer nope" }))).status).toBe(401);
    const old = await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(t, "1.1.0")));
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ error: "incompatible_protocol", worker_protocol: "2.0.0", agent_protocol: "1.1.0" });
  });
});

describe("MCP per DJ", () => {
  it("serves the same 10 tools with v1 transport rules behind a link", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const [s, init] = await c.mcp(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    expect(s).toBe(200);
    expect(init.result.serverInfo.version).toBe(WORKER_VERSION);
    const [, list] = await c.mcp(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools).toHaveLength(10);
    expect((await c.mcp(url, { jsonrpc: "2.0", method: "notifications/initialized" }))[0]).toBe(202);
    expect((await c.mcp(url, { jsonrpc: "2.0", id: 3, method: "ping" }, { origin: "https://evil.example" }))[0]).toBe(403);
    expect((await c.mcp(url, { jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-protocol-version": "2026-07-28" }))[0]).toBe(400);
    const get = await c.call(req("GET", new URL(url).pathname));
    expect(get.status).toBe(405);
  });

  it("404s unknown tenants without creating storage, and ignores spoofed internal headers", async () => {
    const c = makeCloud();
    const ghost = "A".repeat(22);
    const url = `https://mcp.example.test/${ghost}/${"b".repeat(43)}/mcp`;
    const [s] = await c.mcp(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { "x-djs-legacy": "1", "x-djs-link": "x" });
    expect(s).toBe(404);
    const rows = c.TENANT.ctxs.get(ghost)!.storage.sql.exec("SELECT name FROM sqlite_master").toArray();
    expect(rows).toEqual([]);

    // A real DJ's tenant id with a made-up secret, even claiming "legacy".
    const t = await c.registered();
    const [s2] = await c.mcp(`https://mcp.example.test/${t.tenant_id}/${"c".repeat(43)}/mcp`, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      "x-djs-legacy": "1",
    });
    expect(s2).toBe(404);
  });

  it("keeps DJs isolated: links, agent tokens, jobs and libraries", async () => {
    const c = makeCloud();
    const a = await c.registered("198.51.100.1");
    const b = await c.registered("198.51.100.2");
    const la = await c.link(a);
    const lb = await c.link(b);
    const secretA = new URL(la.url).pathname.split("/")[2];

    // A's secret on B's tenant id → 404.
    expect((await c.mcp(`https://mcp.example.test/${b.tenant_id}/${secretA}/mcp`, { jsonrpc: "2.0", id: 1, method: "ping" }))[0]).toBe(404);
    // A's agent token on B → 401 (REST) and 4001 (socket).
    const mixed = { tenant_id: b.tenant_id, agent_token: a.agent_token };
    expect((await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(mixed)))).status).toBe(401);
    const ws = await c.connect(mixed);
    expect(ws.closed?.code).toBe(CLOSE_UNAUTHORIZED);

    // A's job and library stay A's.
    const queued = await c.tool(la.url, "download_to_rekordbox", { urls: [YT(1)] });
    expect(queued.isError).toBe(false);
    expect((await upload(c, a, await gzip(new TextEncoder().encode(JSON.stringify(LIBRARY))))).status).toBe(200);
    const statusB = await c.tool(lb.url, "get_download_status", {});
    expect(statusB.structuredContent.jobs).toEqual([]);
    expect((await c.tool(lb.url, "get_download_status", { job_id: queued.structuredContent.job_id })).isError).toBe(true);
    expect((await c.tool(lb.url, "list_playlists", {})).isError).toBe(true); // no library shared by B
    expect((await c.tool(la.url, "list_playlists", {})).structuredContent.playlists[0].name).toBe("Friday");
  });
});

describe("agent WebSocket (protocol 2.0.0, spec §3.4)", () => {
  it("hello → welcome → job → complete → ack, then ready for the next", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const first = (await c.tool(url, "download_to_rekordbox", { urls: [YT(1)], playlist_name: "Sat" })).structuredContent;
    const second = (await c.tool(url, "download_to_rekordbox", { urls: [YT(2)] })).structuredContent;
    expect(first.mac_online).toBe(false);

    const ws = await c.connect(t);
    expect(ws.sent).toEqual([]); // nothing before hello
    await c.hello(t, ws, { library_hash: "abc" });
    const [welcome, job] = ws.frames();
    expect(welcome).toEqual({ type: "welcome", worker_version: WORKER_VERSION, protocol: "2.0.0", library_wanted: true });
    expect(job).toEqual({ type: "job", job_id: first.job_id, kind: "download", playlist: "Sat", urls: [`https://www.youtube.com/watch?v=${YT(1).slice(-11)}`], attempt: 1 });

    // One at a time: the second waits for `ready`.
    expect(ws.frames()).toHaveLength(2);
    const status = await c.tool(url, "get_download_status", { job_id: first.job_id });
    expect(status.structuredContent).toMatchObject({ state: "running", mac_online: true });

    await c.send(t, ws, {
      type: "complete",
      job_id: first.job_id,
      state: "done",
      message: "1 track ready.",
      tracks: [{ artist: "A", title: "B", file: "/x.mp3", already_downloaded: false }],
      errors: [],
      xml_version: "1.3.0",
      library_version: null,
    });
    expect(ws.last()).toEqual({ type: "ack", job_id: first.job_id, result: "ok" });
    // A retried report is acknowledged as a duplicate; an unknown job too.
    await c.send(t, ws, { type: "complete", job_id: first.job_id, state: "done", message: "again" });
    expect(ws.last()).toMatchObject({ type: "ack", result: "duplicate" });
    await c.send(t, ws, { type: "complete", job_id: "000000000000", state: "failed", message: "?" });
    expect(ws.last()).toMatchObject({ type: "ack", result: "not_found" });

    await c.send(t, ws, { type: "ready" });
    expect(ws.last()).toMatchObject({ type: "job", job_id: second.job_id });
    const done = await c.tool(url, "get_download_status", { job_id: first.job_id });
    expect(done.structuredContent).toMatchObject({ state: "done", xml_version: "1.3.0", message: "1 track ready." });
  });

  it("pushes a job the moment it's queued while the Mac is idle", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const ws = await c.connect(t);
    await c.hello(t, ws);
    expect(ws.frames().map((f) => f.type)).toEqual(["welcome"]);
    const q = (await c.tool(url, "download_to_rekordbox", { urls: [YT(3)] })).structuredContent;
    expect(q.mac_online).toBe(true);
    expect(ws.last()).toMatchObject({ type: "job", job_id: q.job_id });
  });

  it("re-delivers a job when the Mac vanishes and the lease runs out (alarm)", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const ws = await c.connect(t);
    await c.hello(t, ws);
    const q = (await c.tool(url, "download_to_rekordbox", { urls: [YT(4)] })).structuredContent;
    const storage = c.TENANT.ctxs.get(t.tenant_id)!.storage;
    expect(storage.alarm).toBe(Date.parse(c.now().toISOString()) + LEASE_SECONDS * 1000 + 1000);

    // extend pushes the lease out.
    c.advance(600);
    await c.send(t, ws, { type: "extend", active: [q.job_id] });
    c.advance(600); // 20 min after delivery, 10 after the extend: still leased
    await c.tenant(t).alarm();
    expect((await c.tool(url, "get_download_status", { job_id: q.job_id })).structuredContent.state).toBe("running");

    // The Mac disappears; 15 min later the alarm requeues the job.
    ws.close(1006, "gone");
    await c.tenant(t).webSocketClose(ws as Any);
    c.advance(LEASE_SECONDS + 5);
    await c.tenant(t).alarm();
    expect((await c.tool(url, "get_download_status", { job_id: q.job_id })).structuredContent).toMatchObject({ state: "queued", mac_online: false });
    expect(storage.alarm).toBeNull(); // nothing leased → no alarm

    const ws2 = await c.connect(t);
    await c.hello(t, ws2);
    expect(ws2.last()).toMatchObject({ type: "job", job_id: q.job_id, attempt: 2 });
    await c.send(t, ws2, { type: "complete", job_id: q.job_id, state: "failed", message: "nope" });
    expect(storage.alarm).toBeNull();
  });

  it("closes with 4001 / 4009 / 4010 / 4029", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const wrong = await c.connect({ ...t, agent_token: `djsa_${"z".repeat(43)}` });
    expect(wrong.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(wrong.frames()[0]).toMatchObject({ type: "error", code: "unauthorized" });

    const old = await c.connect(t, { "x-dj-sync-agent-protocol": "1.1.0" });
    expect(old.closed?.code).toBe(CLOSE_INCOMPATIBLE);
    expect(old.frames()[0]).toMatchObject({ type: "error", code: "incompatible_protocol" });
    const newer = await c.connect(t, { "x-dj-sync-agent-protocol": "2.1.0" });
    expect(newer.closed?.code).toBe(CLOSE_INCOMPATIBLE);

    const one = await c.connect(t);
    const two = await c.connect(t);
    expect(one.closed?.code).toBe(CLOSE_REPLACED);
    expect(two.closed).toBeNull();

    for (let i = 3; i <= MAX_AGENT_CONNECTS_PER_HOUR; i++) await c.connect(t);
    const runaway = await c.connect(t);
    expect(runaway.closed?.code).toBe(CLOSE_OVER_LIMITS);
    c.advance(3600);
    expect((await c.connect(t)).closed).toBeNull();
  });

  it("answers bad frames with an error, and pings with pong", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const ws = await c.connect(t);
    expect(c.TENANT.ctxs.get(t.tenant_id)!.autoResponse).toMatchObject({ request: "ping", response: "pong" });
    await c.send(t, ws, "ping");
    expect(ws.sent.at(-1)).toBe("pong");
    await c.send(t, ws, "{not json");
    expect(ws.last()).toMatchObject({ type: "error", code: "bad_message" });
    await c.send(t, ws, { type: "dance" });
    expect(ws.last()).toMatchObject({ type: "error", code: "bad_message" });
    await c.hello(t, ws, { active: "nope" });
    expect(ws.last()).toMatchObject({ type: "error", code: "bad_message" });
    expect(ws.closed).toBeNull();
  });
});

describe("library snapshot (spec §3.6)", () => {
  it("takes gzip or plain JSON, asks for it only when the hash changes, and survives eviction", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const res = await upload(c, t, await gzip(new TextEncoder().encode(JSON.stringify(LIBRARY))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, playlists: 1, tracks: 1 });

    const ws = await c.connect(t);
    await c.hello(t, ws, { library_hash: "h1", can_claim: false });
    expect(ws.last()).toMatchObject({ type: "welcome", library_wanted: false });
    await c.send(t, ws, { type: "library_hash", hash: "h1" });
    expect(ws.frames()).toHaveLength(1);
    await c.send(t, ws, { type: "library_hash", hash: "h2" });
    expect(ws.last()).toEqual({ type: "library_wanted" });

    // Plain JSON is accepted too (bytes decide, not Content-Encoding).
    const plain = await c.call(req("PUT", "/v2/agent/library", JSON.stringify({ ...LIBRARY, hash: "h2" }), agentHeaders(t)));
    expect(plain.status).toBe(200);
    const bad = await upload(c, t, new Uint8Array([0x1f, 0x8b, 1, 2, 3]));
    expect(bad.status).toBe(400);
    expect((await upload(c, t, "{}")).status).toBe(400);

    c.TENANT.evict(t.tenant_id); // a fresh instance reads it back from storage
    const found = await c.tool(url, "search_tracks", { query: "burna" });
    expect(found.structuredContent.tracks[0]).toMatchObject({ track_id: "101", title: "Ye" });
  });

  it("splits big snapshots into ≤1 MB rows", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    // Random titles don't compress, so this spans several rows.
    const rnd = (n: number) => Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join("");
    const tracks = Array.from({ length: 6000 }, (_, i) => ({ id: String(i), title: rnd(40), artist: null, album: null, genre: null, bpm: null, key: null, duration_secs: null }));
    const res = await upload(c, t, await gzip(new TextEncoder().encode(JSON.stringify({ ...LIBRARY, tracks }))));
    expect(res.status).toBe(200);
    const rows = c.TENANT.ctxs.get(t.tenant_id)!.storage.sql.exec("SELECT LENGTH(data) AS n FROM library_chunks WHERE name = 'tracks'").toArray();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => Number(r.n) <= 1024 * 1024)).toBe(true);
    c.TENANT.evict(t.tenant_id);
    expect((await c.tool(url, "search_tracks", { query: tracks[5999]!.title.slice(0, 20) })).structuredContent.tracks[0].track_id).toBe("5999");
  });
});

describe("per-DJ limits (spec §3.7)", () => {
  it("caps queued jobs at 50", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) expect((await c.tool(url, "download_to_rekordbox", { urls: [YT(i)] })).isError).toBe(false);
    const over = await c.tool(url, "download_to_rekordbox", { urls: [YT(999)] });
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toContain("50 jobs are already waiting");
    // A retry of queued work is still answered (dedupe, not a new job).
    expect((await c.tool(url, "download_to_rekordbox", { urls: [YT(0)] })).structuredContent.deduplicated).toBe(true);
  });

  it("caps jobs per UTC day at 200", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const sql = c.TENANT.ctxs.get(t.tenant_id)!.storage.sql;
    const today = c.now().toISOString();
    for (let i = 0; i < MAX_JOBS_PER_DAY; i++) {
      sql.exec(
        "INSERT INTO jobs (id, kind, state, playlist, urls, dedupe_key, source, created_at, finished_at, message) VALUES (?, 'download', 'done', 'P', '[]', ?, 'mcp', ?, ?, 'ok')",
        `j${i}`,
        `k${i}`,
        today,
        today,
      );
    }
    const over = await c.tool(url, "create_playlist", { name: "X" });
    // No library yet → that tool refuses earlier; use a download to hit the cap.
    expect(over.isError).toBe(true);
    const dl = await c.tool(url, "download_to_rekordbox", { urls: [YT(7)] });
    expect(dl.isError).toBe(true);
    expect(dl.content[0].text).toContain("daily limit of 200");
    c.advance(86_400);
    expect((await c.tool(url, "download_to_rekordbox", { urls: [YT(7)] })).isError).toBe(false);
  });

  it("caps tool calls at 600 an hour", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    for (let i = 0; i < MAX_MCP_CALLS_PER_HOUR; i++) await c.tool(url, "get_download_status", {});
    const over = await c.tool(url, "get_download_status", {});
    expect(over).toMatchObject({ isError: true, structuredContent: { error: "rate_limited" } });
    // Other methods still work.
    expect((await c.mcp(url, { jsonrpc: "2.0", id: 9, method: "tools/list" }))[1].result.tools).toHaveLength(10);
    c.advance(3601);
    expect((await c.tool(url, "get_download_status", {})).isError).toBe(false);
  });

  it("drops finished jobs after 30 days, lazily", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const ws = await c.connect(t);
    await c.hello(t, ws);
    const q = (await c.tool(url, "download_to_rekordbox", { urls: [YT(5)] })).structuredContent;
    await c.send(t, ws, { type: "complete", job_id: q.job_id, state: "done", message: "ok" });
    c.advance(31 * 86_400);
    await c.tool(url, "get_download_status", {}); // first call of a new day runs the cleanup
    expect((await c.tool(url, "get_download_status", { job_id: q.job_id })).isError).toBe(true);
  });
});

describe("Shortcut links", () => {
  it("lets a shortcut link (only) use /api/downloads", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const sc = await c.link(t, "shortcut");
    expect(sc.api_url).toBe("https://mcp.example.test/api/downloads");
    expect(sc.token).toMatch(new RegExp(`^${t.tenant_id}\\.[A-Za-z0-9_-]{43}$`));
    const res = await c.call(req("POST", "/api/downloads", { url: YT(8) }, { authorization: `Bearer ${sc.token}` }));
    expect(res.status).toBe(202);
    const job = (await res.json()) as Any;
    const st = await c.call(req("GET", `/api/downloads/${job.job_id}`, undefined, { authorization: `Bearer ${sc.token}` }));
    expect(await st.json()).toMatchObject({ job_id: job.job_id, state: "queued", mac_online: false });

    const chat = await c.link(t, "chatgpt");
    const secret = new URL(chat.url).pathname.split("/")[2];
    const denied = await c.call(req("POST", "/api/downloads", { url: YT(9) }, { authorization: `Bearer ${t.tenant_id}.${secret}` }));
    expect(denied.status).toBe(401);
  });
});
