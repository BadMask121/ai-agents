import { describe, expect, it, vi } from "vitest";
import {
  matchSong,
  parseEmbed,
  parseYoutubePlaylist,
  songFromVideo,
  spotifyCollection,
  youtubePlaylistId,
  type LinkTrackList,
} from "../src/link-tracks";
import { buildIndex } from "../src/search";
import type { LibTrack } from "../src/store";
import { FakeAi, type Any } from "./cloud";
import { CHAT, hook, msg, paired, storeOf, tgCloud, upload } from "./telegram-helpers";

const embedHtml = (entity: unknown) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;

const ytHtml = (title: string, videos: [string, string, string][], total: number) => {
  const data = {
    metadata: { playlistMetadataRenderer: { title } },
    contents: {
      list: videos.map(([t, channel, length]) => ({
        lockupViewModel: {
          contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
          contentImage: { thumbnailViewModel: { overlays: [{ badges: [{ text: length }] }] } },
          metadata: {
            lockupMetadataViewModel: {
              title: { content: t },
              metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: channel } }] }] } },
            },
          },
        },
      })),
    },
    sidebar: { playlistSidebarRenderer: { items: [{ stats: [{ runs: [{ text: String(total) }, { text: " videos" }] }] }] } },
  };
  return `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
};

describe("reading a link's songs", () => {
  it("recognises the links it can read", () => {
    expect(spotifyCollection("https://open.spotify.com/playlist/4xQysUTVHdjc2S2ikkxiNm")).toEqual({ kind: "playlist", id: "4xQysUTVHdjc2S2ikkxiNm" });
    expect(spotifyCollection("https://open.spotify.com/intl-fr/album/6kZ42qRrzov54LcAk4onW9")).toEqual({ kind: "album", id: "6kZ42qRrzov54LcAk4onW9" });
    expect(spotifyCollection("https://open.spotify.com/track/1ixulEp1Zbq1SEZa0tIMM3")).toBeNull();
    expect(youtubePlaylistId("https://www.youtube.com/playlist?list=PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i")).toBe("PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i");
    expect(youtubePlaylistId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("parses Spotify's embed page, and says when it may be cut off", () => {
    const list = parseEmbed(
      embedHtml({ name: "October 29", trackList: [{ title: "Rush", subtitle: "Ayra Starr", duration: 185093 }, { title: "" }] }),
      "playlist",
    );
    expect(list).toEqual({
      name: "October 29",
      source: "spotify",
      kind: "playlist",
      tracks: [{ title: "Rush", artists: "Ayra Starr", durationSecs: 185 }],
      total: null,
      mayHaveMore: false,
    });
    const hundred = Array.from({ length: 100 }, (_, i) => ({ title: `T${i}`, subtitle: "A" }));
    expect(parseEmbed(embedHtml({ name: "Big", trackList: hundred }), "playlist")?.mayHaveMore).toBe(true);
    expect(parseEmbed("<html>changed</html>", "playlist")).toBeNull();
  });

  it("parses a YouTube playlist page, with its real total", () => {
    const list = parseYoutubePlaylist(
      ytHtml("Popular", [["Shakira, Burna Boy - Dai Dai (Official Video)", "Shakira", "4:01"], ["BELLAKEO (Video Oficial) - Peso Pluma, Anitta", "Peso Pluma", "3:55"]], 182),
    );
    expect(list?.name).toBe("Popular");
    expect(list?.tracks).toEqual([
      { title: "Dai Dai", artists: "Shakira, Burna Boy", durationSecs: 241 },
      { title: "BELLAKEO", artists: "Peso Pluma, Anitta", durationSecs: 235 },
    ]);
    expect([list?.total, list?.mayHaveMore]).toEqual([182, true]);
  });

  it("turns video titles into songs", () => {
    expect(songFromVideo("Burna Boy - Last Last [Official Music Video]", "Burna Boy", 200)).toMatchObject({ title: "Last Last", artists: "Burna Boy" });
    expect(songFromVideo("Ye | Lyric Video", "Burna Boy - Topic", null)).toMatchObject({ title: "Ye", artists: "Burna Boy" });
    expect(songFromVideo("KALYANI (with Shreya Ghoshal) OFFICIAL MUSIC VIDEO", "MONEY VERSE RECORDS", null).title).toBe("KALYANI (with Shreya Ghoshal)");
    expect(songFromVideo("Real Boston Richey - The Type (Official Music Video) ft. YTB Fatt", "Real Boston Richey", null)).toMatchObject({ title: "The Type", artists: "Real Boston Richey" });
  });
});

describe("matching a link's songs to the library", () => {
  const t = (id: string, title: string, artist: string, secs: number | null = 200): LibTrack => ({
    id, title, artist, album: null, genre: "Afrobeats", bpm: 100, key: "8A", duration_secs: secs,
  });
  const index = buildIndex([
    t("t1", "Rush", "Ayra Starr", 185),
    t("t2", "No Wahala", "1da Banton", 180),
    t("t3", "Monalisa", "Lojay & Sarz", 250),
    t("t4", "Rush Hour", "Ayra Starr", 190),
  ]);

  it("calls it exact only for the same title, version, artist and about the same length", () => {
    expect(matchSong(index, { title: "Rush", artists: "Ayra Starr", durationSecs: 186 })).toMatchObject({ match: "exact", track: { id: "t1" } });
    // A remix isn't the original.
    expect(matchSong(index, { title: "No Wahala - Remix", artists: "1da Banton, Kizz Daniel", durationSecs: 178 })).toMatchObject({ match: "close", track: { id: "t2" } });
    // Same song name, but 36 s longer: probably another recording.
    expect(matchSong(index, { title: "Monalisa", artists: "Lojay, Sarz", durationSecs: 214 })).toMatchObject({ match: "close", track: { id: "t3" } });
    // …which a music video's longer intro is allowed on YouTube.
    expect(matchSong(index, { title: "Monalisa", artists: "Lojay, Sarz", durationSecs: 226 }, "youtube").match).toBe("exact");
    expect(matchSong(index, { title: "Dem Dey", artists: "Burna Boy", durationSecs: 200 })).toEqual({ song: expect.anything(), match: "none", track: null });
  });
});

describe("“copy the songs from this link that are in Friday to Oct 29”", () => {
  const LINK = "https://open.spotify.com/playlist/4xQysUTVHdjc2S2ikkxiNm";
  const LIST: LinkTrackList = {
    name: "October 29",
    source: "spotify",
    kind: "playlist",
    tracks: [
      { title: "Ye", artists: "Burna Boy", durationSecs: 231 },
      { title: "Ongcwele", artists: "Sizwe Mdlalose", durationSecs: 300 },
      { title: "Rush", artists: "Ayra Starr", durationSecs: 185 },
    ],
    total: null,
    mayHaveMore: false,
  };

  it("reads the link, finds which are in Friday, and copies those — without downloading anything", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ai = new FakeAi().script(
      { calls: [{ name: "link_tracks", args: { url: LINK } }] },
      (inputs) => {
        const result = inputs.messages.at(-1).content as string;
        expect(result).toContain("“October 29” (Spotify playlist, 3 songs): 2 in the library, 0 close matches, 1 not in the library.");
        expect(result).toContain("- Ye — Burna Boy [track_id t1] · in DJ Sync/Friday, GQOM/Gqom");
        expect(result).toContain("Not in the library: Rush — Ayra Starr");
        return { calls: [{ name: "copy_tracks", args: { from_playlist: "Friday", to_playlist: "Oct 29", track_ids: ["t1"], create_playlist: true } }] };
      },
      { text: "Done: Ye by Burna Boy is in Friday, so I copied it to a new playlist, Oct 29." },
    );
    const { c, tg } = tgCloud(ai, undefined, undefined, { [LINK]: LIST });
    const { t } = await paired(c);
    expect((await upload(c, t)).status).toBe(200);
    await hook(c, msg(CHAT, `Check the songs we have in this playlist ${LINK}?si=x And make sure we find the songs in friday and copy it to the another playlist named oct 29`));
    expect(tg.last(CHAT).text).toBe("Done: Ye by Burna Boy is in Friday, so I copied it to a new playlist, Oct 29.");
    const jobs: Any[] = await storeOf(c, t).recentJobs(5);
    expect(jobs).toHaveLength(1); // a playlist change, no download
    expect(jobs[0].kind).toBe("library");
    expect(jobs[0].ops).toEqual([
      { op: "ensure_playlist", name: "Oct 29" },
      { op: "add_to_playlist", playlist: "Oct 29", content_id: "t1" },
    ]);
    log.mockRestore();
  });

  it("says plainly when it can't read the link", async () => {
    const ai = new FakeAi().script(
      { calls: [{ name: "link_tracks", args: { url: LINK } }] },
      (inputs) => ({ text: String(inputs.messages.at(-1).content) }),
    );
    const { c, tg } = tgCloud(ai); // no track list known
    const { t } = await paired(c);
    expect((await upload(c, t)).status).toBe(200);
    await hook(c, msg(CHAT, `what songs are in this playlist ${LINK}`));
    expect(tg.last(CHAT).text).toContain("Couldn't read the songs in that Spotify link right now");
  });
});
