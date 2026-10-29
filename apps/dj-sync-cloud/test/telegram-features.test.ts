// Telegram: downloads named after the linked playlist, renaming from chat,
// and a whole instruction around a link reaching the assistant.

import { describe, expect, it, vi } from "vitest";
import type { JevClient, JevRoute } from "../src/jev";
import { collectionTitle, isCollection } from "../src/oembed";
import { renameRequest } from "../src/routing";
import type { LibPlaylist } from "../src/store";
import { FakeAi, type Any } from "./cloud";
import { CHAT, hook, msg, paired, pushedJob, storeOf, tap, tgCloud, upload } from "./telegram-helpers";

const SPOTIFY_PLAYLIST = "https://open.spotify.com/playlist/4xQysUTVHdjc2S2ikkxiNm";
const SHARED = `${SPOTIFY_PLAYLIST}?si=pVVsVa6mQfyKFpurPnGlMw&utm_source=copy-link`;
const TRACK = "https://open.spotify.com/track/1ixulEp1Zbq1SEZa0tIMM3";

async function setup(opts: { ai?: FakeAi; jev?: JevClient; titles?: Record<string, string> } = {}) {
  const { c, tg } = tgCloud(opts.ai, opts.jev, opts.titles);
  const { t } = await paired(c);
  expect((await upload(c, t)).status).toBe(200);
  return { c, tg, t };
}
const say = (c: Any, text: string) => hook(c, msg(CHAT, text));

describe("playlist names from links (oEmbed)", () => {
  it("knows playlist and album links from single tracks", () => {
    expect(isCollection(SPOTIFY_PLAYLIST)).toBe(true);
    expect(isCollection("https://open.spotify.com/album/abc")).toBe(true);
    expect(isCollection("https://www.youtube.com/playlist?list=PL123")).toBe(true);
    expect(isCollection(TRACK)).toBe(false);
    expect(isCollection("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false);
  });

  it("reads the title, and gives up quietly", async () => {
    const seen: string[] = [];
    const ok = (async (u: string) => (seen.push(u), Response.json({ title: "  October 29 " }))) as unknown as typeof fetch;
    expect(await collectionTitle(SPOTIFY_PLAYLIST, ok)).toBe("October 29");
    expect(seen[0]).toBe(`https://open.spotify.com/oembed?url=${encodeURIComponent(SPOTIFY_PLAYLIST)}`);
    expect(await collectionTitle(TRACK, ok)).toBeNull();
    const down = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await collectionTitle(SPOTIFY_PLAYLIST, down)).toBeNull();
    const boom = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect(await collectionTitle(SPOTIFY_PLAYLIST, boom)).toBeNull();
  });
});

describe("“download this playlist” in Telegram", () => {
  it("puts it in a new Rekordbox playlist named after the Spotify one", async () => {
    const { c, tg, t } = await setup({ titles: { [SPOTIFY_PLAYLIST]: "October 29" } });
    await say(c, `download this playlist ${SHARED}`);
    expect(tg.last(CHAT).text).toContain("→ October 29 (a new playlist named after the Spotify one)");
    expect(tg.last(CHAT).reply_markup).toBeUndefined();
    expect((await pushedJob(c, t)).playlist).toBe("October 29");
  });

  it("uses the existing playlist when one has that name", async () => {
    const { c, tg, t } = await setup({ titles: { [SPOTIFY_PLAYLIST]: "amapiano chill" } });
    await say(c, SHARED);
    expect(tg.last(CHAT).text).toContain("→ Amapiano Chill.");
    expect((await pushedJob(c, t)).playlist_id).toBe("p4");
  });

  it("works for the assistant too: no playlist named → the linked playlist's name", async () => {
    const ai = new FakeAi().script(
      { calls: [{ name: "download_to_rekordbox", args: { urls: [SHARED] } }] },
      (inputs) => ({ text: (inputs.messages.at(-1).content as string).includes("(named after the linked playlist)") ? "On its way into October 29." : "?" }),
    );
    // Long enough to go to the assistant rather than the plain-code path.
    const { c, tg, t } = await setup({ ai, titles: { [SPOTIFY_PLAYLIST]: "October 29" } });
    await say(c, `${SHARED} grab every song on this one for tonight's set please`);
    expect(tg.last(CHAT).text).toBe("On its way into October 29.");
    expect((await pushedJob(c, t)).playlist).toBe("October 29");
  });

  it("still asks for single songs, and when the name can't be looked up", async () => {
    const { c, tg } = await setup();
    await say(c, TRACK);
    expect(tg.last(CHAT).text).toBe("Which playlist should 1 link go into?");
    await say(c, SHARED); // no title known
    expect(tg.last(CHAT).text).toBe("Which playlist should 1 link go into?");
  });
});

describe("renaming a playlist from Telegram", () => {
  const P = (id: string, name: string, folder = ""): LibPlaylist => ({ id, name, folder, track_ids: [] });

  it("reads the old and new names, even when a name has 'to' in it", () => {
    const pls = [P("a", "Friday", "DJ Sync"), P("b", "Road to Lagos")];
    expect(renameRequest("rename Friday to Friday Night", pls)).toEqual({ kind: "rename", playlist: pls[0], newName: "Friday Night" });
    expect(renameRequest("please rename my friday playlist as “Friday Late”", pls)).toMatchObject({ playlist: pls[0], newName: "Friday Late" });
    expect(renameRequest("rename Road to Lagos to Lagos Road", pls)).toMatchObject({ playlist: pls[1], newName: "Lagos Road" });
    expect(renameRequest("rename sunday to monday", pls)).toEqual({ kind: "unknown", from: "sunday" });
    expect(renameRequest("move friday to gqom", pls)).toBeNull();
  });

  it("asks with a tap, then queues the rename for the Mac", async () => {
    const { c, tg, t } = await setup();
    await say(c, "rename friday to Friday Night");
    const ask = tg.last(CHAT);
    expect(ask.text).toBe("Rename “DJ Sync/Friday” to “Friday Night”?");
    expect(await storeOf(c, t).recentJobs(5)).toHaveLength(0);
    await hook(c, tap(CHAT, ask.reply_markup.inline_keyboard[0][0].callback_data, 60));
    const [job] = await storeOf(c, t).recentJobs(5);
    expect(job.ops).toEqual([{ op: "rename_playlist", name: "Friday", new_name: "Friday Night", playlist_id: "p3" }]);

    await say(c, "/rename Amapiano Chill to Amapiano Chill");
    expect(tg.last(CHAT).text).toBe("It's already called “Amapiano Chill”.");
    await say(c, "/rename");
    expect(tg.last(CHAT).text).toContain("Usage: /rename");
    await say(c, "rename sunday to monday"); // no assistant here: say so
    expect(tg.last(CHAT).text).toContain("I couldn't find a playlist called “sunday”");
  });
});

describe("a whole instruction around a link", () => {
  it("goes to the assistant, not to playlist buttons — whatever Jev guesses", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const jev: JevClient = {
      route: async (_t: string, _l: string[], pls: LibPlaylist[]): Promise<JevRoute> => ({
        action: "download", actionConfidence: 1, playlist: pls[0]!, playlistConfidence: 0.7, ranked: [{ playlist: pls[0]!, p: 0.7 }],
        folder: null, folderConfidence: 1, model: "jev-test", ms: 100,
      }),
    };
    const ai = new FakeAi().script({ text: "I can't see what's inside a Spotify link until it's downloaded." });
    const { c, tg } = await setup({ ai, jev });
    await say(
      c,
      `Check the songs we have in this playlist ${SHARED} And make sure we find the songs in shayo 29 and copy it to the another playlist named oct 29`,
    );
    expect(tg.last(CHAT).text).toBe("I can't see what's inside a Spotify link until it's downloaded.");
    expect(tg.last(CHAT).reply_markup).toBeUndefined();
    expect(ai.inputs).toHaveLength(1);
    log.mockRestore();
  });
});

