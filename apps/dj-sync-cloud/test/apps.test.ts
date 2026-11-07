// A Mac with both Rekordbox and Serato: a default, a second app that's on or
// off, and requests that name one. The two libraries stay separate.

import { describe, expect, it } from "vitest";
import { parseApps, parseLibrary } from "../src/agent";
import { appInMessage, mentionsApp } from "../src/routing";
import { SqlStore } from "../src/sqlstore";
import { makeCloud, type Any } from "./cloud";
import { FakeStorage } from "./do-harness";
import { CHAT, LIBRARY, hook, msg, paired, pushedJob, tap, tgCloud, upload } from "./telegram-helpers";

const YT = (n: number) => `https://youtu.be/dQw4w9WgXc${n}`;
const REKORDBOX = {
  ...LIBRARY,
  hash: "rb1",
};
const SERATO = {
  app: "serato",
  hash: "se1",
  generated_at: "2026-11-07T01:00:00Z",
  library_version: "1.1.0",
  playlists: [{ id: "DJ Sync%%Friday", name: "Friday", folder: "DJ Sync", track_ids: ["s1"] }],
  tracks: [{ id: "s1", title: "Only In Serato", artist: "A", album: null, genre: null, bpm: 120, key: "8A", duration_secs: 200 }],
};
const BOTH_ON = { default: "rekordbox", enabled: ["rekordbox", "serato"] };

async function macWith(apps: Any = BOTH_ON) {
  const c = makeCloud();
  const t = await c.registered();
  const { url } = await c.link(t);
  const ws = await c.connect(t);
  await c.hello(t, ws, { apps, library_hashes: {} });
  expect((await upload(c, t, { ...REKORDBOX, app: "rekordbox" })).status).toBe(200);
  if (apps.enabled.includes("serato")) expect((await upload(c, t, SERATO)).status).toBe(200);
  return { c, t, url, ws };
}

const text = (r: Any) => r.content.map((x: Any) => x.text).join("");

describe("reading a message for an app", () => {
  const cases: [string, string | null, string][] = [
    ["https://youtu.be/x to serato", "serato", "https://youtu.be/x"],
    ["to serato https://youtu.be/x", "serato", "https://youtu.be/x"],
    ["https://youtu.be/x friday in rekordbox only", "rekordbox", "https://youtu.be/x friday"],
    ["https://youtu.be/x in my Serato library please", "serato", "https://youtu.be/x"],
    ["https://youtu.be/x serato", "serato", "https://youtu.be/x"],
    ["https://youtu.be/x to rekorbox", "rekordbox", "https://youtu.be/x"],
    ["https://youtu.be/x to both", "both", "https://youtu.be/x"],
    ["https://youtu.be/x friday in both apps", "both", "https://youtu.be/x friday"],
    ["https://youtu.be/x rekordbox and serato", "both", "https://youtu.be/x"],
  ];
  it.each(cases)("%s", (message, app, rest) => {
    expect(appInMessage(message)).toEqual({ app, text: rest, unclear: false });
  });

  it("leaves messages that don't name an app alone", () => {
    expect(appInMessage("https://youtu.be/x friday")).toEqual({ app: null, text: "https://youtu.be/x friday", unclear: false });
    expect(appInMessage("add both songs https://youtu.be/x")).toMatchObject({ app: null, unclear: false });
  });

  it("calls an app in the middle of a message unclear, not a playlist name", () => {
    expect(appInMessage("https://youtu.be/x to Serato Friday")).toMatchObject({ app: null, unclear: true });
    expect(appInMessage("put https://youtu.be/x in rekordbox friday")).toMatchObject({ app: null, unclear: true });
  });

  it("doesn't take a word in a link for a request", () => {
    expect(mentionsApp("https://soundcloud.com/serato/some-track")).toBe(false);
    expect(appInMessage("https://soundcloud.com/serato/some-track friday")).toMatchObject({ app: null, unclear: false });
  });
});

describe("a DJ whose account predates this", () => {
  it("gets the new columns on first use, keeps old jobs, and can take new ones", async () => {
    const storage = new FakeStorage();
    const db = { exec: storage.sql.exec.bind(storage.sql), transaction: <T>(fn: () => T) => storage.transactionSync(fn) } as Any;
    new SqlStore(db).init({});
    db.exec("ALTER TABLE jobs DROP COLUMN app");
    db.exec("ALTER TABLE tg_pending DROP COLUMN app");
    db.exec(
      "INSERT INTO jobs (id, state, playlist, urls, dedupe_key, source, created_at) VALUES ('old', 'queued', 'Fri', '[]', 'k', 'mcp', '2026-10-01T00:00:00Z')",
    );

    SqlStore.migrate(db);
    SqlStore.migrate(db); // runs every time a tenant wakes

    const store = new SqlStore(db);
    expect(await store.getJob("old")).toMatchObject({ playlist: "Fri", app: null });
    const job = { ...(await store.getJob("old"))!, id: "new", dedupe_key: "n", app: "serato" as const };
    await store.insertJob(job);
    expect(await store.getJob("new")).toMatchObject({ app: "serato" });
    store.addTgPending({ id: "p", chat_id: "1", urls: [], hint: null, created_at: "2026-11-07T00:00:00Z", app: "both" });
    expect(store.getTgPending("p")).toMatchObject({ app: "both" });
  });

  it("moves a snapshot stored the old way to per-app on the Mac's next hello", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const old = await c.connect(t);
    await c.hello(t, old, { library_hash: "legacy" });
    expect((await upload(c, t, { ...LIBRARY, hash: "legacy" })).status).toBe(200);
    expect(text(await c.tool(url, "list_playlists", {}))).toContain("Gqom");

    const updated = await c.connect(t);
    await c.hello(t, updated, { apps: { default: "rekordbox", enabled: ["rekordbox"] }, library_hashes: { rekordbox: "legacy" } });
    expect(updated.frames()[0]).toMatchObject({ libraries_wanted: ["rekordbox"] });
    expect((await upload(c, t, { ...LIBRARY, hash: "legacy", app: "rekordbox" })).status).toBe(200);
    expect(text(await c.tool(url, "list_playlists", {}))).toContain("Gqom");
  });
});

describe("what a Mac reports", () => {
  it("takes a default that's among the enabled apps", () => {
    expect(parseApps(BOTH_ON)).toEqual(BOTH_ON);
    expect(parseApps({ default: "serato", enabled: ["serato", "serato"] })).toEqual({ default: "serato", enabled: ["serato"] });
  });

  it.each([[undefined], [null], [{}], [{ default: "traktor", enabled: ["traktor"] }], [{ default: "serato", enabled: ["rekordbox"] }]])(
    "refuses %j",
    (v) => expect(parseApps(v)).toBeNull(),
  );

  it("refuses a snapshot for an app it doesn't know", () => {
    expect(parseLibrary({ ...SERATO, app: "traktor" })).toMatch(/app must be/);
  });
});

describe("one library per app", () => {
  it("reads the default app unless the request names the other", async () => {
    const { c, url } = await macWith();
    const def = await c.tool(url, "search_tracks", { query: "Ongcwele" });
    expect(text(def)).toContain("Ongcwele");
    const other = await c.tool(url, "search_tracks", { query: "Only In Serato", app: "serato" });
    expect(text(other)).toContain("Only In Serato");
    expect(text(other)).toContain("Serato library as of");
    const miss = await c.tool(url, "search_tracks", { query: "Only In Serato" });
    expect(text(miss)).not.toContain("Only In Serato");
  });

  it("follows the default when the DJ changes it, with no new upload", async () => {
    const { c, t, url, ws } = await macWith();
    await c.send(t, ws, { type: "apps", apps: { default: "serato", enabled: ["serato", "rekordbox"] } });
    const listed = text(await c.tool(url, "list_playlists", {}));
    expect(listed).toContain("Friday");
    expect(listed).not.toContain("Gqom");
  });

  it("asks only for the snapshots that changed", async () => {
    const { c, t } = await macWith();
    const again = await c.connect(t);
    await c.hello(t, again, { apps: BOTH_ON, library_hashes: { rekordbox: "rb1", serato: "changed" } });
    expect(again.frames()[0]).toMatchObject({ type: "welcome", library_wanted: false, libraries_wanted: ["serato"] });
    await c.send(t, again, { type: "library_hash", hash: "se2", app: "serato" });
    expect(again.frames().at(-1)).toEqual({ type: "library_wanted", app: "serato" });
    await c.send(t, again, { type: "library_hash", hash: "rb1", app: "rekordbox" });
    expect(again.frames().at(-1)).toEqual({ type: "library_wanted", app: "serato" });
  });

  it("keeps a library's own copy when the other is replaced", async () => {
    const { c, url } = await macWith();
    expect(text(await c.tool(url, "get_playlist", { name: "Gqom", playlist_id: "p1" }))).toContain("Ongcwele");
    expect(text(await c.tool(url, "get_playlist", { name: "Friday", app: "serato" }))).toContain("Only In Serato");
  });
});

describe("downloads", () => {
  it("go to the default with nothing named, and the reply says where", async () => {
    const { c, url, ws } = await macWith();
    const r = await c.tool(url, "download_tracks", { urls: [YT(1)] });
    expect(text(r)).toContain("in Rekordbox");
    const job = ws.frames().find((f: Any) => f.type === "job");
    expect(job).not.toHaveProperty("app");
  });

  it("carry the named app, and pin the playlist from that app", async () => {
    const { url, c, ws } = await macWith();
    const r = await c.tool(url, "download_tracks", { urls: [YT(1)], playlist_name: "Friday", app: "serato" });
    expect(text(r)).toContain('in Serato');
    expect(r.structuredContent).toMatchObject({ app: "serato", playlist_id: "DJ Sync%%Friday" });
    expect(ws.frames().find((f: Any) => f.type === "job")).toMatchObject({ app: "serato", playlist_id: "DJ Sync%%Friday" });
  });

  it("can go to both, pinned in the default", async () => {
    const { url, c } = await macWith();
    const r = await c.tool(url, "download_tracks", { urls: [YT(1)], playlist_name: "Friday", app: "both" });
    expect(text(r)).toContain("in Rekordbox and Serato");
    expect(r.structuredContent).toMatchObject({ app: "both", playlist_id: "p3" });
  });

  it("are separate jobs per app, not one deduplicated away", async () => {
    const { url, c } = await macWith();
    const a = await c.tool(url, "download_tracks", { urls: [YT(1)], app: "serato" });
    const b = await c.tool(url, "download_tracks", { urls: [YT(1)], app: "rekordbox" });
    expect(b.structuredContent.job_id).not.toBe(a.structuredContent.job_id);
    const again = await c.tool(url, "download_tracks", { urls: [YT(1)], app: "serato" });
    expect(again.structuredContent).toMatchObject({ job_id: a.structuredContent.job_id, deduplicated: true });
  });

  it("don't name an app on a Mac with just one on", async () => {
    const { url, c } = await macWith({ default: "rekordbox", enabled: ["rekordbox"] });
    const r = await c.tool(url, "download_tracks", { urls: [YT(1)] });
    expect(text(r)).not.toContain("Rekordbox");
  });
});

describe("refusals", () => {
  it("says how to turn on an app that's off, and changes nothing", async () => {
    const { url, c, ws } = await macWith({ default: "rekordbox", enabled: ["rekordbox"] });
    const r = await c.tool(url, "download_tracks", { urls: [YT(1)], app: "serato" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Serato isn't turned on");
    expect(text(await c.tool(url, "download_tracks", { urls: [YT(2)], app: "both" }))).toContain("Serato isn't turned on");
    expect(ws.frames().some((f: Any) => f.type === "job" && f.app)).toBe(false);
  });

  it("refuses an app choice for a Mac too old to honour it, instead of using its default", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const ws = await c.connect(t);
    await c.hello(t, ws, { library_hash: "abc" });
    const r = await c.tool(url, "download_tracks", { urls: [YT(1)], app: "serato" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("too old");
    expect(ws.frames().some((f: Any) => f.type === "job")).toBe(false);
  });

  it("keeps working with a Mac on the old protocol when nothing names an app", async () => {
    const c = makeCloud();
    const t = await c.registered();
    const { url } = await c.link(t);
    const ws = await c.connect(t, { "x-dj-sync-agent-protocol": "2.0.0" });
    await c.hello(t, ws, { library_hash: "abc" });
    expect(ws.frames()[0]).toMatchObject({ type: "welcome", library_wanted: true });
    expect(ws.frames()[0]).not.toHaveProperty("libraries_wanted");
    const r = await c.tool(url, "download_tracks", { urls: [YT(1)] });
    expect(r.isError).toBe(false);
    expect(ws.frames().find((f: Any) => f.type === "job")).not.toHaveProperty("app");
  });

  it("forgets a Mac's apps if it comes back on an older version", async () => {
    const { c, t, url } = await macWith();
    const old = await c.connect(t);
    await c.hello(t, old, { library_hash: "abc" });
    expect(text(await c.tool(url, "list_playlists", { app: "serato" }))).toContain("too old");
  });

  it("works on one app at a time for playlist changes", async () => {
    const { url, c } = await macWith();
    const r = await c.tool(url, "rename_playlist", { name: "Friday", new_name: "Sat", app: "both" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("one app at a time");
  });

  it("refuses an app it doesn't know", async () => {
    const { url, c } = await macWith();
    expect(text(await c.tool(url, "list_playlists", { app: "traktor" }))).toContain("must be rekordbox, serato or both");
  });
});

describe("playlist changes", () => {
  it("resolve names and track ids in the app named, and tell the Mac which", async () => {
    const { url, c, ws } = await macWith();
    const r = await c.tool(url, "add_tracks_to_playlist", { playlist: "Friday", track_ids: ["s1"], app: "serato" });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain("in Serato");
    const job: Any = ws.frames().find((f: Any) => f.type === "job");
    expect(job).toMatchObject({ kind: "library", app: "serato" });
    expect(job.ops[0]).toMatchObject({ playlist_id: "DJ Sync%%Friday", content_id: "s1" });
  });

  it("don't accept another app's track ids", async () => {
    const { url, c } = await macWith();
    const r = await c.tool(url, "add_tracks_to_playlist", { playlist: "Friday", track_ids: ["t1"], app: "serato" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Unknown track_ids");
  });
});

describe("the tools", () => {
  it("offer an app on everything but job status, and both only on downloads", async () => {
    const { url, c } = await macWith();
    const tools = (await c.mcp(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }))[1].result.tools as Any[];
    for (const tool of tools) {
      if (tool.name === "get_download_status") expect(tool.inputSchema.properties.app).toBeUndefined();
      else expect(tool.inputSchema.properties.app.enum).toEqual(tool.name === "download_tracks" ? ["rekordbox", "serato", "both"] : ["rekordbox", "serato"]);
    }
  });
});

describe("Telegram", () => {
  const LINK = YT(1);

  async function chat(apps: Any = BOTH_ON) {
    const { c, tg } = tgCloud();
    const { t } = await paired(c);
    const ws = await c.connect(t);
    await c.hello(t, ws, { apps, library_hashes: {} });
    await upload(c, t, { ...LIBRARY, app: "rekordbox" });
    if (apps.enabled.includes("serato")) await upload(c, t, SERATO);
    return { c, t, tg, ws };
  }
  const jobs = (ws: Any) => ws.frames().filter((f: Any) => f.type === "job");

  it("queues into the app the message names, using that app's playlists", async () => {
    const { c, tg, ws } = await chat();
    await hook(c, msg(CHAT, `${LINK} friday to serato`));
    expect(tg.last(CHAT).text).toContain("→ Friday (Serato)");
    expect(jobs(ws)[0]).toMatchObject({ app: "serato", playlist_id: "DJ Sync%%Friday" });
  });

  it("uses the default with no app named, and says so", async () => {
    const { c, tg, ws } = await chat();
    await hook(c, msg(CHAT, `${LINK} friday`));
    expect(tg.last(CHAT).text).toContain("→ Friday (Rekordbox)");
    expect(jobs(ws)[0]).not.toHaveProperty("app");
    expect(jobs(ws)[0].playlist_id).toBe("p3");
  });

  it("can send to both", async () => {
    const { c, tg, ws } = await chat();
    await hook(c, msg(CHAT, `${LINK} friday to both`));
    expect(tg.last(CHAT).text).toContain("(Rekordbox and Serato)");
    expect(jobs(ws)[0]).toMatchObject({ app: "both" });
  });

  it("explains an app that's off and queues nothing", async () => {
    const { c, tg, ws } = await chat({ default: "rekordbox", enabled: ["rekordbox"] });
    await hook(c, msg(CHAT, `${LINK} to serato`));
    expect(tg.last(CHAT).text).toContain("Serato isn't turned on");
    expect(jobs(ws)).toEqual([]);
  });

  it("never guesses a playlist when an app is mentioned unclearly", async () => {
    const { c, tg, ws } = await chat();
    await hook(c, msg(CHAT, `${LINK} to Serato Friday`));
    expect(tg.last(CHAT).text).toContain("Which app");
    expect(jobs(ws)).toEqual([]);
  });

  it("keeps the app through the buttons", async () => {
    const { c, tg, ws } = await chat();
    await hook(c, msg(CHAT, `${LINK} something unknown to serato`));
    const rows = tg.last(CHAT).reply_markup.inline_keyboard as Any[][];
    const def = rows.flat().find((b) => b.callback_data.endsWith(":def"))!;
    await hook(c, tap(CHAT, def.callback_data));
    expect(jobs(ws)[0]).toMatchObject({ app: "serato" });
  });

  it("offers that app's playlists on the buttons", async () => {
    const { c, tg } = await chat();
    await hook(c, msg(CHAT, `${LINK} fridy to serato`));
    const labels = (tg.last(CHAT).reply_markup.inline_keyboard as Any[][]).flat().map((b) => b.text);
    expect(labels.join()).toContain("DJ Sync/Friday");
    expect(labels.join()).not.toContain("Gqom");
  });
});
