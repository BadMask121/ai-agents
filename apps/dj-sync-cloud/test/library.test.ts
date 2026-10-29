import { claimedJobView } from "../src/agent";
import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL, MAX_BODY_BYTES, MAX_LIBRARY_BYTES, WORKER_VERSION } from "../src/constants";
import { dispatch } from "../src/mcp";
import { route, type Secrets } from "../src/router";
import { AGENT_TOKEN, SECRET, makeDeps } from "./helpers";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Deps = ReturnType<typeof makeDeps>["deps"];
const BASE = "https://mcp.example.test";
const ALL: Secrets = { MCP_SECRET_PATH: SECRET, AGENT_TOKEN };
const NO_LIBRARY = "Your Mac hasn't shared its Rekordbox library yet — open DJ Sync on the Mac.";
const APPLY =
  "Your Mac applies it to Rekordbox — straight away if Rekordbox is closed, otherwise when you quit it. " +
  "It also shows under rekordbox xml right away.";

const track = (id: string, title: string, artist: string | null, genre: string | null, bpm: number | null, key: string | null) => ({
  id,
  title,
  artist,
  album: `${title} (Album)`,
  genre,
  bpm,
  key,
  duration_secs: 300,
});

const SNAPSHOT = {
  hash: "abc123",
  generated_at: "2026-10-28T11:55:00Z",
  library_version: "1.4.0",
  playlists: [
    { id: "p3", name: "Warmup", folder: "Gigs/Friday", track_ids: ["t2", "t1"] },
    { id: "p1", name: "Amapiano Bangers", folder: "", track_ids: ["t1", "t3", "t4"] },
    { id: "p2", name: "afro house", folder: "DJ Sync", track_ids: [] },
    { id: "p4", name: "Closing", folder: "Gigs/Friday", track_ids: ["t5"] },
  ],
  tracks: [
    track("t1", "Mnike", "Tyler ICU", "Amapiano", 112, "Am"),
    track("t2", "Water", "Tyla", "Amapiano", 117, "8A"),
    track("t3", "Abalele", "Kabza De Small", "Amapiano", 113, "Am"),
    track("t4", "Jerusalema", "Master KG", "Afro House", 124, "Fm"),
    track("t5", "Untitled", null, null, null, null),
  ],
};

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const agentHeaders = (protocol = AGENT_PROTOCOL, token = AGENT_TOKEN) => ({
  authorization: `Bearer ${token}`,
  "x-dj-sync-agent-protocol": protocol,
  "x-dj-sync-agent-version": "0.7.0",
});

async function body(res: Response): Promise<Any> {
  const t = await res.text();
  return t === "" ? null : JSON.parse(t);
}

const upload = (deps: Deps, snapshot: unknown = SNAPSHOT, protocol = AGENT_PROTOCOL) =>
  route(post("/agent/library", snapshot, agentHeaders(protocol)), ALL, deps);

const poll = (deps: Deps, b: unknown, protocol = AGENT_PROTOCOL) =>
  route(post("/agent/poll", b, agentHeaders(protocol)), ALL, deps);

function call(deps: Deps, name: string, args: unknown): Promise<Any> {
  return dispatch({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, deps).then(
    (r: Any) => r.result,
  );
}

const text = (r: Any): string => r.content[0].text;

async function withLibrary() {
  const env = makeDeps();
  expect((await upload(env.deps)).status).toBe(200);
  return env;
}

describe("POST /agent/library", () => {
  it("stores the snapshot and its hash for a 1.1 agent", async () => {
    const { deps, store } = makeDeps();
    const res = await upload(deps);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ ok: true });
    expect(await store.getAgent()).toMatchObject({
      library_hash: "abc123",
      library_generated_at: "2026-10-28T11:55:00Z",
      library_version: "1.4.0",
      version: "0.7.0",
      protocol: AGENT_PROTOCOL,
    });
    expect((await store.getLibraryPlaylists())!.map((p) => p.name)).toContain("Warmup");
    expect(await store.getLibraryTracks()).toHaveLength(5);
  });

  it("refuses 1.0 agents, bad tokens and malformed snapshots", async () => {
    const { deps, store } = makeDeps();
    const old = await upload(deps, SNAPSHOT, "1.0.0");
    expect(old.status).toBe(409);
    expect(await body(old)).toMatchObject({
      error: "incompatible_protocol",
      worker_protocol: AGENT_PROTOCOL,
      agent_protocol: "1.0.0",
      worker_version: WORKER_VERSION,
    });
    expect(await store.getLibraryPlaylists()).toBeNull();

    const wrong = await route(post("/agent/library", SNAPSHOT, agentHeaders(AGENT_PROTOCOL, "nope")), ALL, deps);
    expect(wrong.status).toBe(401);

    for (const bad of [
      [],
      { ...SNAPSHOT, hash: "" },
      { ...SNAPSHOT, generated_at: "yesterday" },
      { ...SNAPSHOT, playlists: "x" },
      { ...SNAPSHOT, tracks: [{ title: "no id" }] },
      { ...SNAPSHOT, playlists: [{ id: "p", name: "x", track_ids: [1] }] },
    ]) {
      expect((await upload(deps, bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await store.getAgent())!.library_hash).toBeNull();
  });

  it("takes bodies up to 16 MB there and nowhere else", async () => {
    const { deps } = makeDeps();
    // Bigger than the 64 KB every other route allows.
    const big = {
      ...SNAPSHOT,
      tracks: Array.from({ length: 2000 }, (_, i) => track(`x${i}`, `Track number ${i}`, "Artist", "House", 120, "Am")),
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_BODY_BYTES);
    expect((await upload(deps, big)).status).toBe(200);
    expect((await poll(deps, { active: [], can_claim: false, pad: "x".repeat(MAX_BODY_BYTES) })).status).toBe(413);

    const tooBig = new Request(`${BASE}/agent/library`, {
      method: "POST",
      headers: { ...agentHeaders(), "content-type": "application/json", "content-length": String(MAX_LIBRARY_BYTES + 1) },
      body: "{}",
    });
    expect((await route(tooBig, ALL, deps)).status).toBe(413);
  });
});

describe("library_wanted", () => {
  it("is true only when a hash is sent and differs from the stored one", async () => {
    const { deps } = makeDeps();
    // Old agents never send a hash.
    expect((await body(await poll(deps, { active: [], can_claim: false }, "1.0.0"))).library_wanted).toBe(false);
    // Nothing stored yet.
    expect((await body(await poll(deps, { library_hash: "abc123" }))).library_wanted).toBe(true);
    await upload(deps);
    expect((await body(await poll(deps, { library_hash: "abc123" }))).library_wanted).toBe(false);
    expect((await body(await poll(deps, { library_hash: "def456" }))).library_wanted).toBe(true);
    expect((await body(await poll(deps, { can_claim: false }))).library_wanted).toBe(false);
    expect((await poll(deps, { library_hash: 7 })).status).toBe(400);
  });

  it("isn't reset by a heartbeat", async () => {
    const { deps, store } = makeDeps();
    await upload(deps);
    await poll(deps, { library_hash: "abc123" }, "1.0.0");
    expect((await store.getAgent())!.library_hash).toBe("abc123");
  });
});

describe("library jobs on the agent API", () => {
  it("hands library jobs only to 1.1 agents, with the exact ops", async () => {
    const { deps, advance } = await withLibrary();
    const created = await call(deps, "create_playlist", { name: "Sunset Set", track_ids: ["t2", "t4"] });
    advance(1);
    const download = await call(deps, "download_to_rekordbox", { urls: ["https://youtu.be/dQw4w9WgXcQ"] });

    // A 1.0 Mac skips the (older) library job and gets the download.
    const old = await body(await poll(deps, { active: [], can_claim: true }, "1.0.0"));
    expect(old.job).toMatchObject({ job_id: download.structuredContent.job_id, kind: "download" });
    expect((await body(await poll(deps, { active: [], can_claim: true }, "1.0.0"))).job).toBeNull();

    const got = await body(await poll(deps, { active: [], can_claim: true }));
    expect(got.job).toEqual({
      job_id: created.structuredContent.job_id,
      kind: "library",
      playlist: "Sunset Set",
      urls: [],
      attempt: 1,
      summary: 'Create playlist "Sunset Set" with 2 tracks',
      ops: [
        { op: "ensure_playlist", name: "Sunset Set" },
        { op: "add_to_playlist", playlist: "Sunset Set", content_id: "t2" },
        { op: "add_to_playlist", playlist: "Sunset Set", content_id: "t4" },
      ],
    });

    const status = await call(deps, "get_download_status", { job_id: got.job.job_id });
    expect(text(status)).toContain("is updating Rekordbox");
  });

  it("records library_version on completion and shows it in get_download_status", async () => {
    const { deps } = await withLibrary();
    const r = await call(deps, "rename_playlist", { name: "Warmup", new_name: "Warm Up" });
    const id = r.structuredContent.job_id;
    await poll(deps, { active: [], can_claim: true });
    const done = await route(
      post(
        `/agent/jobs/${id}/complete`,
        { state: "done", message: "Rekordbox updated.", tracks: [], errors: [], xml_version: "v1.3.0", library_version: "1.5.0" },
        agentHeaders(),
      ),
      ALL,
      deps,
    );
    expect(done.status).toBe(200);
    const bad = await route(
      post(`/agent/jobs/${id}/complete`, { state: "done", message: "x", library_version: 5 }, agentHeaders()),
      ALL,
      deps,
    );
    expect(bad.status).toBe(400);

    const status = await call(deps, "get_download_status", { job_id: id });
    expect(status.structuredContent).toMatchObject({
      kind: "library",
      state: "done",
      summary: 'Rename "Warmup" to "Warm Up"',
      library_version: "1.5.0",
      xml_version: "v1.3.0",
    });
    expect(text(status)).toContain('Rename "Warmup" to "Warm Up"');
    expect(text(status)).toContain("1.5.0");
    const recent = await call(deps, "get_download_status", {});
    expect(text(recent)).toContain('Rename "Warmup" to "Warm Up"');
  });
});

describe("read tools", () => {
  it("all say so when the Mac hasn't shared its library", async () => {
    const { deps } = makeDeps();
    const calls: [string, unknown][] = [
      ["list_playlists", {}],
      ["search_tracks", { query: "x" }],
      ["get_playlist", { name: "Warmup" }],
      ["create_playlist", { name: "New" }],
      ["add_tracks_to_playlist", { playlist: "Warmup", track_ids: ["t1"] }],
      ["remove_tracks_from_playlist", { playlist: "Warmup", track_ids: ["t1"] }],
      ["rename_playlist", { name: "Warmup", new_name: "W" }],
      ["delete_playlist", { name: "Warmup" }],
    ];
    for (const [name, args] of calls) {
      const r = await call(deps, name, args);
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toBe(NO_LIBRARY);
    }
    expect(await deps.store.recentJobs(10)).toHaveLength(0);
  });

  it("list_playlists sorts by folder then name, filters, and reports freshness", async () => {
    const { deps, advance } = await withLibrary();
    const all = await call(deps, "list_playlists", {});
    expect(all.isError).toBe(false);
    expect(all.structuredContent.playlists).toEqual([
      { name: "Amapiano Bangers", folder: "", tracks: 3 },
      { name: "afro house", folder: "DJ Sync", tracks: 0 },
      { name: "Closing", folder: "Gigs/Friday", tracks: 1 },
      { name: "Warmup", folder: "Gigs/Friday", tracks: 2 },
    ]);
    expect(all.structuredContent).toMatchObject({ library_as_of: "2026-10-28T11:55:00Z", mac_online: true });
    expect(text(all)).toContain("Gigs/Friday/Warmup (2 tracks)");
    expect(text(all)).toMatch(/library as of .*your Mac is online/);

    const friday = await call(deps, "list_playlists", { query: "FRIDAY" });
    expect(friday.structuredContent.playlists.map((p: Any) => p.name)).toEqual(["Closing", "Warmup"]);
    const ama = await call(deps, "list_playlists", { query: "amap" });
    expect(ama.structuredContent.playlists.map((p: Any) => p.name)).toEqual(["Amapiano Bangers"]);

    advance(600);
    const later = await call(deps, "list_playlists", {});
    expect(later.structuredContent.mac_online).toBe(false);
    expect(text(later)).toContain("your Mac is offline");
  });

  it("search_tracks: every query word must match; filters, sort and limit", async () => {
    const { deps } = await withLibrary();
    const s = (args: unknown) => call(deps, "search_tracks", args).then((r) => r.structuredContent);

    // Sorted by artist then title; tracks without an artist sort first.
    const all = await s({});
    expect(all.total_matches).toBe(5);
    expect(all.tracks.map((t: Any) => t.track_id)).toEqual(["t5", "t3", "t4", "t2", "t1"]);
    expect(all.tracks[1]).toEqual({
      track_id: "t3",
      title: "Abalele",
      artist: "Kabza De Small",
      genre: "Amapiano",
      bpm: 113,
      key: "Am",
      duration_secs: 300,
      playlists: ["Amapiano Bangers"],
    });
    // "Which playlist has Abalele?" in one call: the text says where each track is.
    const text = (await call(deps, "search_tracks", { query: "abalele" })).content[0].text as string;
    expect(text).toContain("[track_id t3] · in Amapiano Bangers");

    expect((await s({ query: "amapiano tyl" })).tracks.map((t: Any) => t.track_id)).toEqual(["t2", "t1"]);
    // Not every word found: a close match, and the text says to check before acting on it.
    const near = await s({ query: "water zoo" });
    expect([near.match, near.tracks.map((t: Any) => t.track_id)]).toEqual(["close", ["t2"]]);
    const nearText = (await call(deps, "search_tracks", { query: "water zoo" })).content[0].text as string;
    expect(nearText).toContain("No exact match for “water zoo”. 1 close match (check with the DJ before changing a playlist with these)");
    expect((await s({ query: "zzzz qqqq" })).match).toBe("none");
    expect((await s({ query: "jerusalema (album)" })).tracks.map((t: Any) => t.track_id)).toEqual(["t4"]);
    expect((await s({ artist: "TYL" })).tracks.map((t: Any) => t.track_id)).toEqual(["t2", "t1"]);
    expect((await s({ genre: "house" })).tracks.map((t: Any) => t.track_id)).toEqual(["t4"]);
    expect((await s({ key: "am" })).tracks.map((t: Any) => t.track_id)).toEqual(["t3", "t1"]);
    expect((await s({ key: "A" })).total_matches).toBe(0); // exact, not substring
    expect((await s({ bpm_min: 112, bpm_max: 117 })).tracks.map((t: Any) => t.track_id)).toEqual(["t3", "t2", "t1"]);
    expect((await s({ bpm_min: 120 })).tracks.map((t: Any) => t.track_id)).toEqual(["t4"]);

    const limited = await s({ limit: 2 });
    expect(limited.tracks).toHaveLength(2);
    expect(limited.total_matches).toBe(5);
    for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { bpm_min: "fast" }, { query: 5 }]) {
      expect((await call(deps, "search_tracks", bad)).isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it("get_playlist lists tracks in playlist order and suggests close names", async () => {
    const { deps } = await withLibrary();
    const r = await call(deps, "get_playlist", { name: "  warmup " });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ name: "Warmup", folder: "Gigs/Friday", total: 2 });
    expect(r.structuredContent.tracks.map((t: Any) => t.track_id)).toEqual(["t2", "t1"]);
    expect(text(r)).toContain("[track_id t2]");

    // A phrase inside exactly one name resolves to it.
    expect((await call(deps, "get_playlist", { name: "Amapiano" })).structuredContent.name).toBe("Amapiano Bangers");
    const miss = await call(deps, "get_playlist", { name: "Amapino Bangerz" });
    expect(miss.isError).toBe(true);
    expect(miss.structuredContent.suggestions.map((x: Any) => x.name)).toEqual(["Amapiano Bangers"]);
    expect(miss.structuredContent.error).toBe("playlist_not_found");
    expect(text(miss)).toContain('closest playlists are "Amapiano Bangers" (3 tracks, playlist_id p1)');
    expect(text(miss)).toContain("Ask the user which one");
  });

  it("get_playlist pages through every track of a long playlist", async () => {
    const { deps } = makeDeps();
    const ids = Array.from({ length: 1250 }, (_, i) => `k${i}`);
    await upload(deps, {
      ...SNAPSHOT,
      playlists: [{ id: "big", name: "Big", folder: "", track_ids: ids }],
      tracks: ids.map((id) => track(id, id, "A", null, null, null)),
    });
    const r = await call(deps, "get_playlist", { name: "Big" });
    expect(r.structuredContent).toMatchObject({ total: 1250, offset: 0, next_offset: 500, playlist_id: "big" });
    expect(r.structuredContent.tracks).toHaveLength(500);
    expect(text(r)).toContain("showing 1–500; call get_playlist again with offset 500 for the rest");
    const seen = [...r.structuredContent.tracks];
    let next = r.structuredContent.next_offset;
    while (next !== null) {
      const page = await call(deps, "get_playlist", { name: "Big", offset: next });
      seen.push(...page.structuredContent.tracks);
      next = page.structuredContent.next_offset;
    }
    expect(seen.map((t: Any) => t.track_id)).toEqual(ids);
    const last = await call(deps, "get_playlist", { name: "Big", offset: 1200, limit: 1000 });
    expect(text(last)).toContain("1201. ");
    expect(last.structuredContent.next_offset).toBeNull();
    expect((await call(deps, "get_playlist", { name: "Big", limit: 1001 })).isError).toBe(true);
    expect((await call(deps, "get_playlist", { name: "Big", offset: -1 })).isError).toBe(true);
  });

  it("list_playlists lists every playlist in its text, not just the first 100", async () => {
    const { deps } = makeDeps();
    const playlists = Array.from({ length: 233 }, (_, i) => ({ id: `p${i}`, name: `Set ${i}`, folder: "", track_ids: [] }));
    await upload(deps, { ...SNAPSHOT, playlists });
    const r = await call(deps, "list_playlists", {});
    expect(text(r)).toContain("Set 232");
    expect(text(r)).not.toContain("more; narrow it down");
  });

  it("matches loose names: case, emoji, punctuation, accents, Folder/Name", async () => {
    const { deps } = makeDeps();
    await upload(deps, {
      ...SNAPSHOT,
      playlists: [
        { id: "e", name: "AFROBEATS PARTY MIX 2022_2023🔥", folder: "", track_ids: ["t1"] },
        { id: "s1", name: "Afro House - Español", folder: "Afro", track_ids: [] },
        { id: "s2", name: "Afro House - Español ", folder: "Afro", track_ids: ["t1", "t2"] },
        { id: "m1", name: "mukstar", folder: "Old", track_ids: [] },
        { id: "m2", name: "mukstar", folder: "New", track_ids: ["t3"] },
        { id: "g", name: "Gqom", folder: "GQOM", track_ids: ["t2"] },
      ],
    });
    const named = async (name: string) => (await call(deps, "get_playlist", { name })).structuredContent;
    expect((await named("afrobeats party mix 2022 2023")).playlist_id).toBe("e");
    expect((await named("GQOM")).playlist_id).toBe("g");
    expect((await named("GQOM/gqom")).playlist_id).toBe("g");
    // Exactly the same name in two folders: ask, listing both with their folders.
    const dup = await call(deps, "get_playlist", { name: "mukstar" });
    expect(dup.isError).toBe(true);
    expect(dup.structuredContent.error).toBe("playlist_ambiguous");
    expect(dup.structuredContent.suggestions.map((x: Any) => x.path)).toEqual(["Old/mukstar", "New/mukstar"]);
    expect((await named("New/mukstar")).playlist_id).toBe("m2");
    expect(text(dup)).toContain("playlist_id m1");
    const byId = await call(deps, "get_playlist", { name: "mukstar", playlist_id: "m2" });
    expect(byId.structuredContent).toMatchObject({ playlist_id: "m2", folder: "New" });
    expect((await call(deps, "get_playlist", { name: "mukstar", playlist_id: "zzz" })).isError).toBe(true);
    const add = await call(deps, "add_tracks_to_playlist", { playlist: "mukstar", playlist_id: "m1", track_ids: ["t1"] });
    expect((await deps.store.getJob(add.structuredContent.job_id))!.ops).toEqual([
      { op: "add_to_playlist", playlist: "mukstar", content_id: "t1", playlist_id: "m1" },
    ]);
    // The exact spelling wins over a trailing-space twin.
    expect((await named("Afro House - Español")).playlist_id).toBe("s1");
    expect((await call(deps, "get_playlist", { name: "afro house espanol" })).structuredContent.error).toBe(
      "playlist_ambiguous",
    );
    // A phrase inside exactly one name is that playlist…
    expect((await named("afrobeats party mix")).playlist_id).toBe("e");
    // …inside several, or a typo, gets suggestions, best first.
    const typo = await call(deps, "get_playlist", { name: "afrobeat party" });
    expect(typo.structuredContent.suggestions[0].name).toBe("AFROBEATS PARTY MIX 2022_2023🔥");
    const afro = await call(deps, "get_playlist", { name: "afro" });
    expect(afro.structuredContent.error).toBe("playlist_not_found");
    expect(afro.structuredContent.suggestions.length).toBeGreaterThan(1);
  });
});

describe("write tools", () => {
  const jobOps = async (deps: Deps, jobId: string) => (await deps.store.getJob(jobId))!.ops;

  it("create_playlist queues ensure + adds, and says it's applied on the Mac", async () => {
    const { deps } = await withLibrary();
    const r = await call(deps, "create_playlist", { name: "  Late\tNight  ", track_ids: ["t1", "t1", "t3"] });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({
      kind: "library",
      state: "queued",
      playlist: "Late Night",
      summary: 'Create playlist "Late Night" with 2 tracks',
      deduplicated: false,
      mac_online: true,
    });
    expect(text(r)).toContain(APPLY);
    expect(await jobOps(deps, r.structuredContent.job_id)).toEqual([
      { op: "ensure_playlist", name: "Late Night" },
      { op: "add_to_playlist", playlist: "Late Night", content_id: "t1" },
      { op: "add_to_playlist", playlist: "Late Night", content_id: "t3" },
    ]);

    const empty = await call(deps, "create_playlist", { name: "Empty" });
    expect(await jobOps(deps, empty.structuredContent.job_id)).toEqual([{ op: "ensure_playlist", name: "Empty" }]);
  });

  it("create_playlist on an existing name adds to it under its exact name", async () => {
    const { deps } = await withLibrary();
    const r = await call(deps, "create_playlist", { name: "WARMUP", track_ids: ["t3"] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('Playlist "Warmup" already exists; adding to it.');
    expect(await jobOps(deps, r.structuredContent.job_id)).toEqual([
      { op: "ensure_playlist", name: "Warmup", playlist_id: "p3" },
      { op: "add_to_playlist", playlist: "Warmup", content_id: "t3", playlist_id: "p3" },
    ]);
  });

  it("dedupes identical active jobs, but not once they're finished", async () => {
    const { deps } = await withLibrary();
    const a = await call(deps, "add_tracks_to_playlist", { playlist: "Closing", track_ids: ["t4"] });
    const b = await call(deps, "add_tracks_to_playlist", { playlist: "closing", track_ids: ["t4"] });
    expect(b.structuredContent).toMatchObject({ job_id: a.structuredContent.job_id, deduplicated: true });
    expect(text(b)).toContain("already queued");
    const other = await call(deps, "add_tracks_to_playlist", { playlist: "Closing", track_ids: ["t3"] });
    expect(other.structuredContent.job_id).not.toBe(a.structuredContent.job_id);

    await deps.store.finishJob(a.structuredContent.job_id, "done", "ok", { tracks: [], errors: [], xml_version: null }, "2026-10-28T12:00:00Z");
    const again = await call(deps, "add_tracks_to_playlist", { playlist: "Closing", track_ids: ["t4"] });
    expect(again.structuredContent.deduplicated).toBe(false);
  });

  it("add/remove validate the playlist and every track id", async () => {
    const { deps } = await withLibrary();
    const add = await call(deps, "add_tracks_to_playlist", { playlist: "Closing", track_ids: ["t1", "t2"] });
    expect(await jobOps(deps, add.structuredContent.job_id)).toEqual([
      { op: "add_to_playlist", playlist: "Closing", content_id: "t1", playlist_id: "p4" },
      { op: "add_to_playlist", playlist: "Closing", content_id: "t2", playlist_id: "p4" },
    ]);
    const rm = await call(deps, "remove_tracks_from_playlist", { playlist: "Amapiano Bangers", track_ids: ["t3"] });
    expect(rm.structuredContent.summary).toBe('Remove 1 track from "Amapiano Bangers"');
    expect(await jobOps(deps, rm.structuredContent.job_id)).toEqual([
      { op: "remove_from_playlist", playlist: "Amapiano Bangers", content_id: "t3", playlist_id: "p1" },
    ]);

    const noList = await call(deps, "add_tracks_to_playlist", { playlist: "Brand New", track_ids: ["t1"] });
    expect(noList.isError).toBe(true);
    expect(text(noList)).toContain("create_playlist");

    const ids = Array.from({ length: 12 }, (_, i) => `ghost${i}`);
    const ghosts = await call(deps, "add_tracks_to_playlist", { playlist: "Closing", track_ids: ["t1", ...ids] });
    expect(ghosts.isError).toBe(true);
    expect(ghosts.structuredContent.unknown_track_ids).toEqual(ids.slice(0, 10));
    expect((await call(deps, "create_playlist", { name: "X", track_ids: ["nope"] })).isError).toBe(true);

    for (const bad of [
      { playlist: "Closing", track_ids: [] },
      { playlist: "Closing" },
      { playlist: "Closing", track_ids: "t1" },
      { playlist: "Closing", track_ids: Array.from({ length: 501 }, (_, i) => `t${i}`) },
      { playlist: "   ", track_ids: ["t1"] },
      { playlist: "x".repeat(101), track_ids: ["t1"] },
    ]) {
      expect((await call(deps, "add_tracks_to_playlist", bad)).isError, JSON.stringify(bad).slice(0, 60)).toBe(true);
    }
    // Only the two valid calls queued anything.
    expect(await deps.store.recentJobs(10)).toHaveLength(2);
  });

  it("rename_playlist and delete_playlist target the snapshot's playlist", async () => {
    const { deps } = await withLibrary();
    const rn = await call(deps, "rename_playlist", { name: "afro HOUSE", new_name: "Afro\u0000House" });
    expect(await jobOps(deps, rn.structuredContent.job_id)).toEqual([
      { op: "rename_playlist", name: "afro house", new_name: "Afro House", playlist_id: "p2" },
    ]);
    expect((await call(deps, "rename_playlist", { name: "Warmup", new_name: "Warmup" })).isError).toBe(true);
    expect((await call(deps, "rename_playlist", { name: "Nope", new_name: "X" })).isError).toBe(true);

    const del = await call(deps, "delete_playlist", { name: "Closing" });
    expect(del.isError).toBe(false);
    expect(await jobOps(deps, del.structuredContent.job_id)).toEqual([
      { op: "delete_playlist", name: "Closing", playlist_id: "p4" },
    ]);
    expect(text(del)).toContain("restored from DJ Sync on the Mac");
    expect(text(del)).toContain(APPLY);
    const miss = await call(deps, "delete_playlist", { name: "Closin" });
    expect(miss.structuredContent.suggestions.map((x: Any) => x.path)).toEqual(["Gigs/Friday/Closing"]);
    expect(text(miss)).toContain("Nothing was changed");
  });

  it("says when the Mac is offline", async () => {
    const { deps, advance } = await withLibrary();
    advance(3600);
    const r = await call(deps, "delete_playlist", { name: "Warmup" });
    expect(r.structuredContent.mac_online).toBe(false);
    expect(text(r)).toContain("it will update Rekordbox when it's back online");
  });

  it("asks which one when names repeat, and pins the choice by id", async () => {
    const { deps } = makeDeps();
    await upload(deps, {
      ...SNAPSHOT,
      playlists: [
        { id: "a", name: "Dupes", folder: "Other", track_ids: [] },
        { id: "b", name: "Dupes", folder: "DJ Sync", track_ids: ["t1"] },
      ],
    });
    const ask = await call(deps, "delete_playlist", { name: "Dupes" });
    expect(ask.structuredContent.error).toBe("playlist_ambiguous");
    expect(await deps.store.recentJobs(10)).toHaveLength(0);
    const del = await call(deps, "delete_playlist", { name: "DJ Sync/Dupes" });
    expect(await jobOps(deps, del.structuredContent.job_id)).toEqual([
      { op: "delete_playlist", name: "Dupes", playlist_id: "b" },
    ]);
  });

  it("downloads go into the playlist the user meant, or ask", async () => {
    const { deps } = await withLibrary();
    const url = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";
    const into = await call(deps, "download_to_rekordbox", { urls: [url], playlist_name: "warm up" });
    expect(into.isError).toBe(false);
    expect(into.structuredContent).toMatchObject({ playlist: "Warmup", playlist_id: "p3" });
    const job = (await deps.store.getJob(into.structuredContent.job_id))!;
    expect(claimedJobView(job)).toMatchObject({ kind: "download", playlist: "Warmup", playlist_id: "p3" });

    const unclear = await call(deps, "download_to_rekordbox", { urls: [url], playlist_name: "amapino bangerz" });
    expect(unclear.isError).toBe(true);
    expect(unclear.structuredContent.suggestions[0].name).toBe("Amapiano Bangers");
    expect(text(unclear)).toContain("create_playlist: true");

    const fresh = await call(deps, "download_to_rekordbox", {
      urls: [url],
      playlist_name: "Sunday Brunch",
      create_playlist: true,
    });
    expect(fresh.structuredContent).toMatchObject({ playlist: "Sunday Brunch", playlist_id: null });
    expect(claimedJobView((await deps.store.getJob(fresh.structuredContent.job_id))!)).not.toHaveProperty("playlist_id");

    const nowhere = await call(deps, "download_to_rekordbox", { urls: [url], playlist_name: "Sunday Brunch" });
    expect(nowhere.isError).toBe(true);
    // Only the two good requests were queued.
    expect(await deps.store.recentJobs(10)).toHaveLength(2);
  });
});

describe("move_tracks (connect-anywhere spec §1b)", () => {
  const jobOps = async (deps: Deps, jobId: string) => (await deps.store.getJob(jobId))!.ops;
  const DUPES = {
    ...SNAPSHOT,
    playlists: [
      ...SNAPSHOT.playlists,
      { id: "d1", name: "Dupes", folder: "Old", track_ids: ["t1"] },
      { id: "d2", name: "Dupes", folder: "New", track_ids: [] },
    ],
  };

  it("moves chosen tracks in source order: adds to the target, then removes from the source", async () => {
    const { deps } = await withLibrary();
    // Asked in a different order than the playlist holds them.
    const r = await call(deps, "move_tracks", { from_playlist: "amapiano bangers", to_playlist: "warm up", track_ids: ["t4", "t1"] });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ kind: "library", summary: 'Move 2 tracks from "Amapiano Bangers" to "Warmup"' });
    expect(await jobOps(deps, r.structuredContent.job_id)).toEqual([
      { op: "add_to_playlist", playlist: "Warmup", content_id: "t1", playlist_id: "p3" },
      { op: "add_to_playlist", playlist: "Warmup", content_id: "t4", playlist_id: "p3" },
      { op: "remove_from_playlist", playlist: "Amapiano Bangers", content_id: "t1", playlist_id: "p1" },
      { op: "remove_from_playlist", playlist: "Amapiano Bangers", content_id: "t4", playlist_id: "p1" },
    ]);
    expect(text(r)).toContain(APPLY);
    // Retried while still queued: the same job.
    const again = await call(deps, "move_tracks", { from_playlist: "Amapiano Bangers", to_playlist: "Warmup", track_ids: ["t1", "t4"] });
    expect(again.structuredContent).toMatchObject({ job_id: r.structuredContent.job_id, deduplicated: true });
  });

  it("moves a whole playlist with all: true", async () => {
    const { deps } = await withLibrary();
    const r = await call(deps, "move_tracks", { from_playlist: "Warmup", to_playlist: "Closing", all: true });
    expect(r.structuredContent.summary).toBe('Move 2 tracks from "Warmup" to "Closing"');
    const ops = await jobOps(deps, r.structuredContent.job_id);
    expect(ops!.map((o: Any) => `${o.op}:${o.content_id}`)).toEqual([
      "add_to_playlist:t2",
      "add_to_playlist:t1",
      "remove_from_playlist:t2",
      "remove_from_playlist:t1",
    ]);
    const empty = await call(deps, "move_tracks", { from_playlist: "afro house", to_playlist: "Closing", all: true });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toContain("has no tracks to move");
  });

  it("refuses tracks that aren't in the source, and queues nothing", async () => {
    const { deps } = await withLibrary();
    const r = await call(deps, "move_tracks", { from_playlist: "Warmup", to_playlist: "Closing", track_ids: ["t1", "t3", "ghost"] });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ error: "tracks_not_in_playlist", track_ids_not_in_playlist: ["t3", "ghost"] });
    expect(text(r)).toContain('aren\'t in "Warmup"');
    expect(await deps.store.recentJobs(5)).toHaveLength(0);
    for (const bad of [
      { from_playlist: "Warmup", to_playlist: "Closing" },
      { from_playlist: "Warmup", to_playlist: "Closing", all: true, track_ids: ["t1"] },
      { from_playlist: "Warmup", to_playlist: "Closing", all: "yes" },
      { from_playlist: "Warmup", to_playlist: "Closing", track_ids: [] },
    ]) {
      expect((await call(deps, "move_tracks", bad)).isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it("asks when either playlist is ambiguous, and accepts the picked ids", async () => {
    const { deps } = makeDeps();
    expect((await upload(deps, DUPES)).status).toBe(200);
    const src = await call(deps, "move_tracks", { from_playlist: "Dupes", to_playlist: "Closing", all: true });
    expect(src.structuredContent.error).toBe("playlist_ambiguous");
    const dst = await call(deps, "move_tracks", { from_playlist: "Warmup", to_playlist: "Dupes", track_ids: ["t1"] });
    expect(dst.structuredContent.error).toBe("playlist_ambiguous");
    const unknown = await call(deps, "move_tracks", { from_playlist: "Warmup", to_playlist: "Nowhere", track_ids: ["t1"] });
    expect(unknown.structuredContent.error).toBe("playlist_not_found");
    expect(text(unknown)).toContain("create_playlist: true");
    expect(await deps.store.recentJobs(5)).toHaveLength(0);

    const r = await call(deps, "move_tracks", {
      from_playlist: "Dupes",
      from_playlist_id: "d1",
      to_playlist: "Dupes",
      to_playlist_id: "d2",
      all: true,
    });
    expect(await jobOps(deps, r.structuredContent.job_id)).toEqual([
      { op: "add_to_playlist", playlist: "Dupes", content_id: "t1", playlist_id: "d2" },
      { op: "remove_from_playlist", playlist: "Dupes", content_id: "t1", playlist_id: "d1" },
    ]);
  });

  it("creates the target with create_playlist, and won't move a playlist into itself", async () => {
    const { deps } = await withLibrary();
    const r = await call(deps, "move_tracks", { from_playlist: "Closing", to_playlist: "Late Night", all: true, create_playlist: true });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('"Late Night" will be created in the DJ Sync folder.');
    expect(await jobOps(deps, r.structuredContent.job_id)).toEqual([
      { op: "ensure_playlist", name: "Late Night" },
      { op: "add_to_playlist", playlist: "Late Night", content_id: "t5" },
      { op: "remove_from_playlist", playlist: "Closing", content_id: "t5", playlist_id: "p4" },
    ]);
    const self = await call(deps, "move_tracks", { from_playlist: "Warmup", to_playlist: "warm up", all: true });
    expect(self.isError).toBe(true);
    expect(text(self)).toContain("both the source and the target");
  });
});

describe("copy_tracks", () => {
  const jobOps = async (deps: Deps, jobId: string) => (await deps.store.getJob(jobId))!.ops;

  it("copies a whole playlist, leaving the source alone and skipping tracks already there", async () => {
    const { deps } = await withLibrary();
    // Amapiano Bangers = t1, t3, t4; Warmup already has t1.
    const r = await call(deps, "copy_tracks", { from_playlist: "amapiano bangers", to_playlist: "warm up", all: true });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.summary).toBe('Copy 2 tracks from "Amapiano Bangers" to "Warmup" (1 already there)');
    expect(await jobOps(deps, r.structuredContent.job_id)).toEqual([
      { op: "add_to_playlist", playlist: "Warmup", content_id: "t3", playlist_id: "p3" },
      { op: "add_to_playlist", playlist: "Warmup", content_id: "t4", playlist_id: "p3" },
    ]);
  });

  it("copies chosen tracks into a new playlist when asked", async () => {
    const { deps } = await withLibrary();
    const no = await call(deps, "copy_tracks", { from_playlist: "Warmup", to_playlist: "Oct 29", track_ids: ["t2"] });
    expect(no.isError).toBe(true);
    expect(text(no)).toContain("To copy them into a new playlist, call again with create_playlist: true");
    const r = await call(deps, "copy_tracks", { from_playlist: "Warmup", to_playlist: "Oct 29", track_ids: ["t2"], create_playlist: true });
    expect(await jobOps(deps, r.structuredContent.job_id)).toEqual([
      { op: "ensure_playlist", name: "Oct 29" },
      { op: "add_to_playlist", playlist: "Oct 29", content_id: "t2" },
    ]);
  });

  it("says so when there's nothing to copy", async () => {
    const { deps } = await withLibrary();
    const same = await call(deps, "copy_tracks", { from_playlist: "Warmup", to_playlist: "Warmup", all: true });
    expect(text(same)).toContain("both the source and the target");
    const already = await call(deps, "copy_tracks", { from_playlist: "Warmup", to_playlist: "Amapiano Bangers", track_ids: ["t1"] });
    expect(text(already)).toContain('already in "Amapiano Bangers"; nothing to copy');
    expect(text(await call(deps, "copy_tracks", { from_playlist: "Warmup", to_playlist: "Closing" }))).toContain("Say which tracks to copy");
  });
});
