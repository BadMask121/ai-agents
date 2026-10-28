import { describe, expect, it } from "vitest";
import { YT, agentHeaders, makeCloud, req, type Any, type Registered } from "./cloud";
import { SHORTCUT_KEY } from "./helpers";

// The iPhone Shortcut (connect-anywhere spec §2): it lists playlists with
// GET /api/playlists, the DJ picks a `path`, and it POSTs /api/downloads
// with that path as playlist_name.

const LIBRARY = {
  hash: "h1",
  generated_at: "2026-10-28T11:00:00Z",
  library_version: "1.2.0",
  playlists: [
    { id: "p1", name: "Gqom", folder: "GQOM", track_ids: ["t1", "t2"] },
    { id: "p2", name: "Gqom", folder: "3 STEP", track_ids: [] },
    { id: "p3", name: "Friday", folder: "DJ Sync", track_ids: ["t1"] },
    { id: "p4", name: "Amapiano Chill", folder: "AMAPIANO", track_ids: [] },
    { id: "p5", name: "Zouk", folder: "", track_ids: [] },
  ],
  tracks: [{ id: "t1", title: "Ye", artist: "Burna Boy", album: null, genre: null, bpm: null, key: null, duration_secs: null }],
};

type Cloud = ReturnType<typeof makeCloud>;
const get = (c: Cloud, path: string, bearer?: string) =>
  c.call(req("GET", path, undefined, bearer ? { authorization: `Bearer ${bearer}` } : {}));
const post = (c: Cloud, body: unknown, bearer: string) =>
  c.call(req("POST", "/api/downloads", body, { authorization: `Bearer ${bearer}` }));

async function setup(withLibrary = true) {
  const c = makeCloud();
  const t: Registered = await c.registered();
  const shortcut = (await c.link(t, "shortcut")) as Any;
  if (withLibrary) expect((await c.call(req("PUT", "/v2/agent/library", LIBRARY, agentHeaders(t)))).status).toBe(200);
  return { c, t, token: shortcut.token as string };
}

describe("iPhone Shortcut REST", () => {
  it("lists playlists for Choose from List: DJ Sync folder first, then A–Z by path", async () => {
    const { c, token } = await setup();
    expect((await get(c, "/api/playlists")).status).toBe(401);
    expect((await get(c, "/api/playlists", "nope")).status).toBe(401);
    const res = await get(c, "/api/playlists", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Any;
    expect(body.playlists.map((p: Any) => p.path)).toEqual(["DJ Sync/Friday", "3 STEP/Gqom", "AMAPIANO/Amapiano Chill", "GQOM/Gqom", "Zouk"]);
    expect(body.playlists[3]).toEqual({ playlist_id: "p1", name: "Gqom", folder: "GQOM", path: "GQOM/Gqom", tracks: 2 });
    // `names` (spec §2b): what the signed Shortcut's Choose from List shows, the default first.
    expect(body.names).toEqual(["ChatGPT Downloads", "DJ Sync/Friday", "3 STEP/Gqom", "AMAPIANO/Amapiano Chill", "GQOM/Gqom", "Zouk"]);
  });

  it("lists nothing (not an error) before the Mac has shared its library", async () => {
    const { c, token } = await setup(false);
    expect(await (await get(c, "/api/playlists", token)).json()).toEqual({ playlists: [], names: ["ChatGPT Downloads"] });
  });

  it("downloads into the picked path, pinned by playlist_id", async () => {
    const { c, t, token } = await setup();
    const res = await post(c, { url: YT(1), playlist_name: "GQOM/Gqom" }, token);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ playlist: "Gqom", playlist_id: "p1", state: "queued" });

    // `urls` works too; a loose name that matches one playlist is pinned.
    expect(await (await post(c, { urls: [YT(2)], playlist_name: "friday" }, token)).json()).toMatchObject({
      playlist: "Friday",
      playlist_id: "p3",
    });
    // Ambiguous or unknown names are used as given (no conversation here).
    expect(await (await post(c, { url: YT(3), playlist_name: "gqom" }, token)).json()).toMatchObject({ playlist: "gqom", playlist_id: null });
    expect(await (await post(c, { url: YT(4), playlist_name: "Brand New" }, token)).json()).toMatchObject({
      playlist: "Brand New",
      playlist_id: null,
    });
    // An explicit playlist_id wins; a stale one is refused.
    expect(await (await post(c, { url: YT(5), playlist_id: "p4" }, token)).json()).toMatchObject({ playlist: "Amapiano Chill", playlist_id: "p4" });
    expect((await post(c, { url: YT(6), playlist_id: "gone" }, token)).status).toBe(400);
    expect((await post(c, { url: YT(6), playlist_id: 7 }, token)).status).toBe(400);

    const ws = await c.connect(t);
    await c.hello(t, ws);
    expect(ws.frames().find((f) => f.type === "job")).toMatchObject({ playlist: "Gqom", playlist_id: "p1" });
  });

  it("serves /api/playlists on the legacy Shortcut key too, once v1 is retired", async () => {
    const { c, t } = await setup();
    c.secrets.V1_RETIRED = "true";
    c.secrets.LEGACY_TENANT_ID = t.tenant_id;
    const res = await get(c, "/api/playlists", SHORTCUT_KEY);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Any).playlists).toHaveLength(5);
    const queued = await post(c, { url: YT(7), playlist_name: "GQOM/Gqom" }, SHORTCUT_KEY);
    expect(await queued.json()).toMatchObject({ playlist_id: "p1" });
  });

  it("takes the Share sheet's text as is (spec §2b) and pulls the links out", async () => {
    const { c, t, token } = await setup();
    const shared = "Ye by Burna Boy https://open.spotify.com/track/abc123?si=x, and https://youtu.be/aaaaaaaaaa9.";
    const res = await post(c, { text: shared, playlist_name: "GQOM/Gqom" }, token);
    expect(res.status).toBe(202);
    const job = (await res.json()) as Any;
    expect(job).toMatchObject({
      urls: ["https://open.spotify.com/track/abc123", "https://www.youtube.com/watch?v=aaaaaaaaaa9"],
      playlist: "Gqom",
      playlist_id: "p1",
    });
    expect(job.message).toBe(
      "Sent 2 links to “Gqom” — it'll be in Rekordbox in a few minutes. Your Mac is offline (last seen never); it will download when it's back online.",
    );
    // The same share again is the same job.
    const again = (await (await post(c, { text: shared, playlist_name: "GQOM/Gqom" }, token)).json()) as Any;
    expect(again).toMatchObject({ job_id: job.job_id, deduplicated: true });
    expect(again.message).toMatch(/^Already sent to “Gqom” — it'll be in Rekordbox in a few minutes\./u);

    // Online, the default playlist: no offline note.
    const ws = await c.connect(t);
    await c.hello(t, ws);
    const def = (await (await post(c, { text: `${YT(8)}`, playlist_name: "ChatGPT Downloads" }, token)).json()) as Any;
    expect(def.message).toBe("Sent 1 link to “ChatGPT Downloads” — it'll be in Rekordbox in a few minutes.");
  });

  it("says what went wrong in `message`, for the notification", async () => {
    const { c, t, token } = await setup();
    const fail = async (res: Response, status: number) => {
      expect(res.status).toBe(status);
      const b = (await res.json()) as Any;
      expect(typeof b.error).toBe("string");
      expect(typeof b.message).toBe("string");
      return b.message as string;
    };
    expect(await fail(await post(c, { text: "no link here" }, token), 400)).toMatch(/^No Spotify or YouTube link found/u);
    expect(await fail(await post(c, { text: "https://example.com/song" }, token), 400)).toMatch(/^No Spotify or YouTube link found/u);
    expect(await fail(await post(c, { text: 7 }, token), 400)).toMatch(/^No Spotify or YouTube link found/u);
    expect(await fail(await post(c, {}, token), 400)).toMatch(/^No Spotify or YouTube link found/u);
    expect(await fail(await post(c, { text: `${YT(1)} ${YT(2)} ${YT(3)} ${YT(4)}` }, token), 400)).toBe(
      "That's 4 links — send at most 3 at a time.",
    );
    expect(await fail(await post(c, { url: YT(1), playlist_id: "gone" }, token), 400)).toContain("isn't in your Rekordbox library any more");
    expect(await fail(await c.call(req("POST", "/api/downloads", "{nope", { authorization: `Bearer ${token}` })), 400)).toContain(
      "couldn't read that request",
    );
    expect(await fail(await get(c, "/api/downloads/nope", token), 404)).toBe("DJ Sync doesn't know that download.");
    // A wrong key, a deleted link and the legacy key all explain how to reconnect.
    for (const bad of ["nope", `${t.tenant_id}.${"x".repeat(43)}`, `${SHORTCUT_KEY}X`]) {
      expect(await fail(await post(c, { url: YT(1) }, bad), 401)).toMatch(/^This Shortcut isn't connected to DJ Sync any more/u);
    }
    expect(await fail(await get(c, "/api/playlists", "nope"), 401)).toMatch(/^This Shortcut isn't connected/u);
  });
});
