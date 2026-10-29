import { describe, expect, it } from "vitest";
import { buildIndex, editDistance, libraryIndex, normalizeText, queryWords, searchIndex } from "../src/search";
import type { LibTrack } from "../src/store";
import { SEARCH_CASES, SEARCH_LIBRARY } from "./search-cases";

const index = buildIndex(SEARCH_LIBRARY);
const ids = (q: string) => searchIndex(index, { query: q }).tracks.map((t) => t.id);

describe("the search test set (test/search-cases.ts)", () => {
  for (const c of SEARCH_CASES) {
    it(`${c.q} — ${c.why}`, () => {
      const r = searchIndex(index, { query: c.q });
      const got = r.tracks.map((t) => t.id);
      if (c.none) expect(r.match).not.toBe("exact");
      if (c.top) expect(c.top, `first result was ${got[0]}`).toContain(got[0]);
      if (c.all) for (const id of c.all) expect(got.slice(0, 5), `${id} in the first five`).toContain(id);
    });
  }
});

describe("search", () => {
  it("normalises accents, case, '&', apostrophes and punctuation", () => {
    expect(normalizeText("Beyoncé — CUFF IT")).toBe("beyonce cuff it");
    expect(normalizeText("Me & U")).toBe("me and u");
    expect(normalizeText("Who's Dat Girl")).toBe("whos dat girl");
    expect(normalizeText("Essence (Remix) [feat. Tems]")).toBe("essence remix feat tems");
  });

  it("drops filler words, unless that leaves nothing", () => {
    expect(queryWords("the jealous song by Fireboy")).toEqual(["jealous", "fireboy"]);
    expect(queryWords("the")).toEqual(["the"]);
    expect(queryWords("")).toEqual([]);
  });

  it("counts a swap of neighbouring letters as one edit, and gives up early", () => {
    expect(editDistance("davdio", "davido", 1)).toBe(1);
    expect(editDistance("jealouse", "jealous", 2)).toBe(1);
    expect(editDistance("metallica", "afrobeats", 2)).toBe(3);
  });

  it("calls typo-forgiven or partial results close, never exact", () => {
    expect(searchIndex(index, { query: "jealous fireboy" }).match).toBe("exact");
    expect(searchIndex(index, { query: "jealouse fireboy" }).match).toBe("close");
    expect(searchIndex(index, { query: "jealous fireboy acoustic" }).match).toBe("close");
    expect(searchIndex(index, { query: "zzzz" })).toEqual({ tracks: [], match: "none" });
  });

  it("treats the start of a word as exact", () => {
    expect(searchIndex(index, { query: "unavail" })).toMatchObject({ match: "exact" });
    expect(ids("unavail")[0]).toBe("t30");
  });

  it("keeps the filters: artist and genre (accent-insensitive), exact key, BPM range", () => {
    const f = (x: object) => searchIndex(index, x).tracks.map((t) => t.id);
    expect(f({ artist: "beyonce" })).toEqual(["t26", "t25"]); // by title: CUFF IT, Halo
    expect(f({ query: "remix", genre: "afrobeats" })).toEqual(expect.arrayContaining(["t09", "t16", "t46"]));
    expect(f({ genre: "gqom", bpmMin: 127 })).toEqual(["t52"]);
    expect(f({ key: "12a" })).toEqual(["t25"]);
    expect(f({ query: "jealous", artist: "lagos band" })).toEqual(["t59"]);
  });

  it("lists by artist then title without a query", () => {
    const r = searchIndex(index, { genre: "pop" });
    expect(r.tracks.map((t) => t.title)).toEqual(["CUFF IT", "Halo"]);
  });

  it("uses the store's cached index when it has one, else builds one", async () => {
    const cached = buildIndex(SEARCH_LIBRARY.slice(0, 2));
    expect(await libraryIndex({ getLibraryTracks: async () => null, getSearchIndex: async () => cached })).toBe(cached);
    const built = await libraryIndex({ getLibraryTracks: async () => SEARCH_LIBRARY.slice(0, 3) });
    expect(built?.tracks).toHaveLength(3);
    expect(await libraryIndex({ getLibraryTracks: async () => null })).toBeNull();
  });

  it("stays fast on a 20,000-track library", () => {
    const words = Array.from({ length: 20_000 }, (_, i) => `w${(i * 7919) % 15_000}x${i % 97}`);
    const big: LibTrack[] = [
      ...SEARCH_LIBRARY,
      ...words.map((w, i) => ({ id: `s${i}`, title: `${w} ${words[(i * 31) % words.length]}`, artist: `artist ${i % 900}`, album: null, genre: "Afrobeats", bpm: 100, key: "8A", duration_secs: 200 })),
    ];
    const big_index = buildIndex(big);
    const started = performance.now();
    for (const q of ["jealouse fireboy", "metallica enter sandman", "fireboi jealous", "afrobeats"]) searchIndex(big_index, { query: q });
    // Generous for slow CI machines; locally each search is a few ms.
    expect(performance.now() - started).toBeLessThan(400);
    expect(searchIndex(big_index, { query: "jealouse fireboy" }).tracks.slice(0, 2).map((t) => t.id).sort()).toEqual(["t01", "t02"]);
  });
});
