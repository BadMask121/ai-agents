import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL, LEASE_SECONDS, WORKER_VERSION } from "../src/constants";
import { route, type Secrets } from "../src/router";
import { AGENT_TOKEN, SECRET, SHORTCUT_KEY, makeDeps } from "./helpers";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = "https://mcp.example.test";
const ALL: Secrets = { MCP_SECRET_PATH: SECRET, AGENT_TOKEN, SHORTCUT_API_KEY: SHORTCUT_KEY };

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const agentHeaders = (protocol = AGENT_PROTOCOL, token = AGENT_TOKEN) => ({
  authorization: `Bearer ${token}`,
  "x-dj-sync-agent-protocol": protocol,
  "x-dj-sync-agent-version": "0.2.0",
});

async function body(res: Response): Promise<Any> {
  const t = await res.text();
  return t === "" ? null : JSON.parse(t);
}

describe("routing", () => {
  it("serves health publicly with the Mac's state", async () => {
    const { deps } = makeDeps();
    const res = await route(new Request(`${BASE}/health`), ALL, deps);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      status: "ok",
      version: WORKER_VERSION,
      protocol: AGENT_PROTOCOL,
      agent: { online: false, last_seen: null },
      queued: 0,
    });
  });

  it("404s wrong or missing secrets and unknown paths", async () => {
    const { deps } = makeDeps();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    for (const path of ["/mcp", "/wrong-secret/mcp", `/${SECRET}x/mcp`, `/${SECRET}/mcp/`, "/openapi.json"]) {
      expect((await route(post(path, ping), ALL, deps)).status, path).toBe(404);
    }
    // An unusable secret disables the endpoint rather than accepting anything.
    expect((await route(post("/short/mcp", ping), { MCP_SECRET_PATH: "short" }, deps)).status).toBe(404);
    // Shortcut and agent routes don't exist without their secrets.
    expect((await route(post("/api/downloads", {}), { MCP_SECRET_PATH: SECRET }, deps)).status).toBe(404);
    expect((await route(post("/agent/poll", {}), { MCP_SECRET_PATH: SECRET }, deps)).status).toBe(404);
  });

  it("speaks MCP over HTTP: initialize, 202 notifications, tools/list", async () => {
    const { deps } = makeDeps();
    const init = await route(
      post(`/${SECRET}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      ALL,
      deps,
    );
    expect(init.status).toBe(200);
    expect((await body(init)).result.protocolVersion).toBe("2025-11-25");

    const note = await route(post(`/${SECRET}/mcp`, { jsonrpc: "2.0", method: "notifications/initialized" }), ALL, deps);
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");

    const list = await route(
      post(`/${SECRET}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-11-25" }),
      ALL,
      deps,
    );
    expect((await body(list)).result.tools).toHaveLength(10);
  });

  it("gives a 2026-07-28 probe a bare 400 so the client falls back", async () => {
    const { deps } = makeDeps();
    const res = await route(
      post(`/${SECRET}/mcp`, { jsonrpc: "2.0", id: 1, method: "server/discover" }, { "mcp-protocol-version": "2026-07-28" }),
      ALL,
      deps,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  });

  it("405s GET/DELETE, 400s bad JSON, 413s big bodies", async () => {
    const { deps } = makeDeps();
    const get = await route(new Request(`${BASE}/${SECRET}/mcp`), ALL, deps);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await route(new Request(`${BASE}/${SECRET}/mcp`, { method: "DELETE" }), ALL, deps)).status).toBe(405);

    const bad = await route(post(`/${SECRET}/mcp`, "{not json"), ALL, deps);
    expect(bad.status).toBe(400);
    expect((await body(bad)).error.code).toBe(-32700);

    const big = { jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70 * 1024) } };
    expect((await route(post(`/${SECRET}/mcp`, big), ALL, deps)).status).toBe(413);
  });

  it("refuses foreign browser origins but allows ChatGPT and the public host", async () => {
    const { deps } = makeDeps();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    for (const [origin, want] of [
      ["https://evil.example", 403],
      ["null", 403],
      ["https://chatgpt.com", 200],
      ["https://mcp.example.test", 200],
      ["http://localhost:6274", 200],
    ] as const) {
      expect((await route(post(`/${SECRET}/mcp`, ping, { origin }), ALL, deps)).status, origin).toBe(want);
    }
  });
});

describe("shortcut REST", () => {
  it("requires the bearer key", async () => {
    const { deps } = makeDeps();
    for (const auth of [undefined, "Bearer wrong", `Bearer ${SHORTCUT_KEY}X`]) {
      const res = await route(
        post("/api/downloads", { url: "https://youtu.be/dQw4w9WgXcQ" }, auth ? { authorization: auth } : {}),
        ALL,
        deps,
      );
      expect(res.status, String(auth)).toBe(401);
    }
  });

  it("queues a shared link, reports status, rejects junk", async () => {
    const { deps } = makeDeps();
    const auth = { authorization: `Bearer ${SHORTCUT_KEY}` };
    const res = await route(
      post(
        "/api/downloads",
        { url: "Tanzania by Uncle Waffles https://open.spotify.com/track/abc123?si=x", playlist_name: "Phone" },
        auth,
      ),
      ALL,
      deps,
    );
    expect(res.status).toBe(202);
    const job = await body(res);
    expect(job).toMatchObject({ urls: ["https://open.spotify.com/track/abc123"], playlist: "Phone", source: "shortcut" });
    expect(job.message).toContain("Your Mac is offline");

    const got = await route(new Request(`${BASE}/api/downloads/${job.job_id}`, { headers: auth }), ALL, deps);
    expect(got.status).toBe(200);
    expect((await body(got)).job_id).toBe(job.job_id);
    expect((await route(new Request(`${BASE}/api/downloads/nope`, { headers: auth }), ALL, deps)).status).toBe(404);

    const junk = await route(post("/api/downloads", { url: "https://evil.example/x" }, auth), ALL, deps);
    expect(junk.status).toBe(400);
    expect((await body(junk)).rejected).toHaveLength(1);
  });
});

describe("agent API", () => {
  async function queue(deps: Any, playlist: string) {
    const res = await route(
      post(`/${SECRET}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "download_to_rekordbox", arguments: { urls: ["https://youtu.be/dQw4w9WgXcQ"], playlist_name: playlist } },
      }),
      ALL,
      deps,
    );
    return (await body(res)).result.structuredContent.job_id as string;
  }
  const poll = (deps: Any, b: unknown, h: Record<string, string> = agentHeaders()) =>
    route(post("/agent/poll", b, h), ALL, deps);

  it("authenticates and checks the protocol version", async () => {
    const { deps } = makeDeps();
    expect((await poll(deps, { can_claim: true }, agentHeaders(AGENT_PROTOCOL, "wrong"))).status).toBe(401);
    const noProto = { authorization: `Bearer ${AGENT_TOKEN}` };
    expect((await poll(deps, { can_claim: true }, noProto)).status).toBe(400);
    const tooNew = await poll(deps, { can_claim: true }, agentHeaders("1.9.0"));
    expect(tooNew.status).toBe(409);
    expect(await body(tooNew)).toMatchObject({
      error: "incompatible_protocol",
      worker_protocol: AGENT_PROTOCOL,
      agent_protocol: "1.9.0",
      worker_version: WORKER_VERSION,
    });
    expect((await poll(deps, { can_claim: true }, agentHeaders("2.0.0"))).status).toBe(409);
    expect((await poll(deps, { active: "x" })).status).toBe(400);
  });

  it("marks the Mac online, claims oldest-first, and completes jobs", async () => {
    const { deps, advance } = makeDeps();
    const first = await queue(deps, "One");
    advance(1);
    const second = await queue(deps, "Two");

    // Not claiming: just a heartbeat.
    const idle = await body(await poll(deps, { active: [], can_claim: false }));
    expect(idle).toEqual({ worker_version: WORKER_VERSION, protocol: AGENT_PROTOCOL, library_wanted: false, job: null });
    const health = await body(await route(new Request(`${BASE}/health`), ALL, deps));
    expect(health.agent).toMatchObject({ online: true, version: "0.2.0" });
    expect(health.queued).toBe(2);

    const got = await body(await poll(deps, { active: [], can_claim: true }));
    expect(got.job).toEqual({
      job_id: first,
      kind: "download",
      playlist: "One",
      urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      attempt: 1,
    });

    const done = await route(
      post(
        `/agent/jobs/${first}/complete`,
        {
          state: "done",
          message: 'Added 1 track(s) to the Rekordbox playlist "One".',
          tracks: [{ artist: "jawed", title: "Me at the zoo", file: "jawed - Me at the zoo.mp3", already_downloaded: false }],
          errors: [],
          xml_version: "v1.2.0",
        },
        agentHeaders(),
      ),
      ALL,
      deps,
    );
    expect(done.status).toBe(200);

    // Retrying the same report is fine; contradicting it isn't.
    const again = { state: "done", message: "x", tracks: [], errors: [], xml_version: null };
    expect((await route(post(`/agent/jobs/${first}/complete`, again, agentHeaders()), ALL, deps)).status).toBe(200);
    const flip = { ...again, state: "failed" };
    expect((await route(post(`/agent/jobs/${first}/complete`, flip, agentHeaders()), ALL, deps)).status).toBe(409);
    expect((await route(post(`/agent/jobs/nope/complete`, again, agentHeaders()), ALL, deps)).status).toBe(404);
    expect(
      (await route(post(`/agent/jobs/${second}/complete`, { state: "maybe" }, agentHeaders()), ALL, deps)).status,
    ).toBe(400);

    const status = await route(
      post(`/${SECRET}/mcp`, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_download_status", arguments: { job_id: first } },
      }),
      ALL,
      deps,
    );
    const sc = (await body(status)).result.structuredContent;
    expect(sc).toMatchObject({ state: "done", xml_version: "v1.2.0", attempts: 1 });
    expect(sc.tracks[0].title).toBe("Me at the zoo");

    const next = await body(await poll(deps, { active: [], can_claim: true }));
    expect(next.job.job_id).toBe(second);
  });

  it("extends leases for active jobs and requeues abandoned ones", async () => {
    const { deps, advance } = makeDeps();
    const id = await queue(deps, "Lease");
    expect((await body(await poll(deps, { active: [], can_claim: true }))).job.job_id).toBe(id);

    // Still running and reported active: lease keeps moving, nothing to reclaim.
    advance(LEASE_SECONDS - 10);
    expect((await body(await poll(deps, { active: [id], can_claim: true }))).job).toBeNull();
    advance(LEASE_SECONDS - 10);
    expect((await body(await poll(deps, { active: [id], can_claim: true }))).job).toBeNull();

    // The Mac vanished mid-download: once the lease lapses, the job is claimable again.
    advance(LEASE_SECONDS + 1);
    const reclaimed = await body(await poll(deps, { active: [], can_claim: true }));
    expect(reclaimed.job).toMatchObject({ job_id: id, attempt: 2 });
  });
});
