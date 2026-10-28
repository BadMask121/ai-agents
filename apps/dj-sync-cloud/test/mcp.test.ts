import { describe, expect, it } from "vitest";
import { SUPPORTED_MCP_VERSIONS, WORKER_VERSION } from "../src/constants";
import { normalizePlaylistName } from "../src/jobs";
import { dispatch } from "../src/mcp";
import { makeDeps } from "./helpers";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function call(deps: ReturnType<typeof makeDeps>["deps"], name: string, args: unknown): Promise<Any> {
  return dispatch({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, deps).then(
    (r: Any) => r.result,
  );
}

describe("protocol", () => {
  it("negotiates the version and identifies itself", async () => {
    const { deps } = makeDeps();
    const r: Any = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      deps,
    );
    expect(r.id).toBe(1);
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.serverInfo).toMatchObject({ name: "dj-sync", version: WORKER_VERSION });
    const r2: Any = await dispatch(
      { jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2099-01-01" } },
      deps,
    );
    expect(r2.result.protocolVersion).toBe(SUPPORTED_MCP_VERSIONS[0]);
  });

  it("answers notifications with nothing and unknowns with errors", async () => {
    const { deps } = makeDeps();
    expect(await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }, deps)).toBeNull();
    expect(((await dispatch({ jsonrpc: "2.0", id: 2, method: "resources/list" }, deps)) as Any).error.code).toBe(-32601);
    expect(((await dispatch([{ jsonrpc: "2.0", id: 1, method: "ping" }], deps)) as Any).error.code).toBe(-32600);
    expect(
      ((await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rm_rf" } }, deps)) as Any).error
        .code,
    ).toBe(-32602);
    expect(((await dispatch({ jsonrpc: "2.0", id: 4, method: "ping" }, deps)) as Any).result).toEqual({});
    expect(((await dispatch({ jsonrpc: "1.0", id: 5, method: "ping" }, deps)) as Any).error.code).toBe(-32600);
  });

  it("lists every tool with object schemas and honest annotations", async () => {
    const { deps } = makeDeps();
    const r: Any = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps);
    const tools = r.result.tools;
    expect(tools.map((t: Any) => t.name)).toEqual([
      "download_to_rekordbox",
      "get_download_status",
      "list_playlists",
      "search_tracks",
      "get_playlist",
      "create_playlist",
      "add_tracks_to_playlist",
      "remove_tracks_from_playlist",
      "move_tracks",
      "rename_playlist",
      "delete_playlist",
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    expect(tools[0].inputSchema.properties.urls.maxItems).toBe(3);
    const byName = Object.fromEntries(tools.map((t: Any) => [t.name, t]));
    for (const n of ["get_download_status", "list_playlists", "search_tracks", "get_playlist"]) {
      expect(byName[n].annotations.readOnlyHint, n).toBe(true);
    }
    for (const n of ["create_playlist", "add_tracks_to_playlist", "remove_tracks_from_playlist", "move_tracks", "rename_playlist"]) {
      expect(byName[n].annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    expect(byName.delete_playlist.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.search_tracks.inputSchema.properties.limit).toMatchObject({ minimum: 1, maximum: 50 });
    expect(byName.add_tracks_to_playlist.inputSchema.properties.track_ids).toMatchObject({ minItems: 1, maxItems: 500 });
  });
});

describe("download_to_rekordbox", () => {
  it("queues valid links, reports bad ones, and says the Mac is offline", async () => {
    const { deps } = makeDeps();
    const r = await call(deps, "download_to_rekordbox", {
      urls: ["https://youtu.be/dQw4w9WgXcQ", "https://evil.example/x", "https://youtu.be/dQw4w9WgXcQ?si=dup"],
      playlist_name: "Fri",
    });
    expect(r.isError).toBe(false);
    const s = r.structuredContent;
    expect(s.job_id).toMatch(/^[0-9a-f]{12}$/);
    expect(s).toMatchObject({ state: "queued", playlist: "Fri", position: 0, deduplicated: false, mac_online: false });
    expect(s.urls).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    expect(s.rejected).toHaveLength(1);
    const text: string = r.content[0].text;
    expect(text).toContain(`Queued job ${s.job_id}: 1 link(s) → Rekordbox playlist "Fri"`);
    expect(text).toContain("Skipped 1 unsupported link(s).");
    expect(text).toContain("Your Mac is offline (last seen never); it will download when it's back online.");
  });

  it("deduplicates an identical active request and counts jobs ahead", async () => {
    const { deps, advance } = makeDeps();
    const a = await call(deps, "download_to_rekordbox", { urls: ["https://youtu.be/dQw4w9WgXcQ"], playlist_name: "X" });
    advance(1);
    const b = await call(deps, "download_to_rekordbox", { urls: ["https://youtu.be/dQw4w9WgXcQ"], playlist_name: "X" });
    expect(b.structuredContent.job_id).toBe(a.structuredContent.job_id);
    expect(b.structuredContent.deduplicated).toBe(true);
    expect(b.content[0].text).toContain("already in progress");
    const c = await call(deps, "download_to_rekordbox", { urls: ["https://youtu.be/dQw4w9WgXcQ"], playlist_name: "Y" });
    expect(c.structuredContent.job_id).not.toBe(a.structuredContent.job_id);
    expect(c.structuredContent.position).toBe(1);
    expect(c.content[0].text).toContain("(1 job(s) ahead)");
  });

  it("omits the offline note when the Mac polled recently", async () => {
    const { deps, store } = makeDeps();
    await store.touchAgent({ last_seen: deps.now().toISOString(), version: "0.2.0", protocol: "1.0.0" });
    const r = await call(deps, "download_to_rekordbox", { urls: ["https://open.spotify.com/track/abc123"] });
    expect(r.structuredContent.mac_online).toBe(true);
    expect(r.structuredContent.playlist).toBe("ChatGPT Downloads");
    expect(r.content[0].text).not.toContain("offline");
  });

  it("rejects bad input as tool errors without queueing", async () => {
    const { deps, store } = makeDeps();
    for (const args of [
      {},
      { urls: [] },
      { urls: "https://youtu.be/dQw4w9WgXcQ" },
      { urls: ["https://a.example/1", "https://a.example/2"] },
      { urls: ["https://youtu.be/dQw4w9WgXcQ"], playlist_name: 5 },
      { urls: ["a", "b", "c", "d"] },
      { urls: ["https://youtu.be/dQw4w9WgXcQ"], playlist_name: "x".repeat(101) },
    ]) {
      const r = await call(deps, "download_to_rekordbox", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(await store.recentJobs(10)).toHaveLength(0);
  });
});

describe("get_download_status", () => {
  it("shows one job, summarising errors to the downloader's ERROR line", async () => {
    const { deps, store } = makeDeps();
    const q = await call(deps, "download_to_rekordbox", { urls: ["https://youtu.be/dQw4w9WgXcQ"] });
    const id = q.structuredContent.job_id;

    const queued = await call(deps, "get_download_status", { job_id: id });
    expect(queued.content[0].text).toContain(`Job ${id} is queued.`);
    expect(queued.content[0].text).toContain("Your Mac is offline");

    await store.finishJob(
      id,
      "failed",
      "No tracks were downloaded. 1 link(s) failed — see errors.",
      {
        tracks: [],
        errors: [
          {
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            error: "yt-dlp failed: exited with exit status: 1:\nWARNING: retry\nERROR: [youtube] x: Video unavailable",
          },
        ],
        xml_version: null,
      },
      deps.now().toISOString(),
    );
    const failed = await call(deps, "get_download_status", { job_id: ` ${id} ` });
    expect(failed.isError).toBe(false);
    expect(failed.content[0].text).toContain(`Job ${id} is failed.`);
    expect(failed.content[0].text).toContain("- https://www.youtube.com/watch?v=dQw4w9WgXcQ: ERROR: [youtube] x: Video unavailable");
    expect(failed.structuredContent).toMatchObject({ state: "failed", xml_version: null });
  });

  it("lists recent jobs newest first, and handles unknown ids", async () => {
    const { deps, advance } = makeDeps();
    expect((await call(deps, "get_download_status", {})).content[0].text).toContain("No jobs yet");
    await call(deps, "download_to_rekordbox", { urls: ["https://youtu.be/dQw4w9WgXcQ"], playlist_name: "A" });
    advance(5);
    await call(deps, "download_to_rekordbox", { urls: ["https://youtu.be/dQw4w9WgXcQ"], playlist_name: "B" });
    const list = await call(deps, "get_download_status", {});
    expect(list.structuredContent.jobs.map((j: Any) => j.playlist)).toEqual(["B", "A"]);
    expect(list.content[0].text).toContain("Your Mac is offline");
    expect((await call(deps, "get_download_status", { job_id: "nope" })).isError).toBe(true);
  });
});

describe("normalizePlaylistName", () => {
  it("cleans, defaults and bounds names like jobs.rs", () => {
    expect(normalizePlaylistName(null, "D")).toEqual({ ok: true, value: "D" });
    expect(normalizePlaylistName(" \t ", "D")).toEqual({ ok: true, value: "D" });
    expect(normalizePlaylistName("a\u0000b\n c", "D")).toEqual({ ok: true, value: "a b c" });
    expect(normalizePlaylistName("x".repeat(101), "D").ok).toBe(false);
    expect(normalizePlaylistName("🔥".repeat(100), "D").ok).toBe(true);
  });
});
