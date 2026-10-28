// The Mac's Rekordbox library as ChatGPT sees it: a snapshot the Mac uploads
// (POST /agent/library) whenever its library changes. Reads answer from the
// snapshot even while the Mac is offline; writes are validated against it and
// queued as library jobs (see mcp.ts).

import { MAX_TRACK_IDS } from "./constants";
import type { Result } from "./jobs";
import type { LibPlaylist, LibTrack } from "./store";

export const NO_LIBRARY = "Your Mac hasn't shared its Rekordbox library yet — open DJ Sync on the Mac.";

/** The folder dj-sync creates its playlists in (mirrors rbdb.py). */
const DJ_SYNC_FOLDER = "DJ Sync";

export function trackView(t: LibTrack) {
  return {
    track_id: t.id,
    title: t.title,
    artist: t.artist,
    genre: t.genre,
    bpm: t.bpm,
    key: t.key,
    duration_secs: t.duration_secs,
  };
}

/** Same clean-up as playlist names: control chars → space, whitespace collapsed. */
export function cleanName(s: string): string {
  return s
    .replace(/\p{Cc}/gu, " ")
    .split(/\s+/u)
    .filter((w) => w !== "")
    .join(" ");
}

const lower = (s: string | null | undefined) => (s ?? "").toLocaleLowerCase();

/**
 * Exact name first, then case-insensitive. Among same-named playlists, the
 * one in dj-sync's own folder wins — the same choice rbdb.py makes on the Mac.
 */
export function findPlaylist(playlists: LibPlaylist[], name: string): LibPlaylist | undefined {
  const wanted = cleanName(name);
  let hits = playlists.filter((p) => p.name === wanted);
  if (hits.length === 0) hits = playlists.filter((p) => lower(p.name) === lower(wanted));
  return hits.find((p) => p.folder === DJ_SYNC_FOLDER) ?? hits[0];
}

/** Up to `n` playlist names that look like what was asked for. */
export function suggestPlaylists(playlists: LibPlaylist[], name: string, n = 5): string[] {
  return [...new Set(closestPlaylists(playlists, name, n).map((p) => p.name))];
}

/**
 * Lowercase, accents and emoji dropped, punctuation → spaces, collapsed:
 * "Afro House - Español " and "afro house espanol" compare equal.
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const compact = (s: string) => normalizeName(s).replace(/ /g, "");

export type PlaylistMatch =
  | { kind: "one"; playlist: LibPlaylist }
  | { kind: "many"; options: LibPlaylist[] }
  | { kind: "none"; suggestions: LibPlaylist[] };

/**
 * What the user most likely means by `input`: the exact name, then ignoring
 * case, then ignoring punctuation/emoji/accents, then spaces too; "Folder/Name" picks one of
 * several same-named playlists. Several equally good matches come back as
 * `many` (ask which), no match as `none` with the closest playlists.
 */
export function resolvePlaylist(playlists: LibPlaylist[], input: string): PlaylistMatch {
  const wanted = cleanName(input);
  const tiers: ((p: LibPlaylist) => boolean)[] = [
    (p) => p.name === wanted,
    (p) => lower(cleanName(p.name)) === lower(wanted),
    (p) => normalizeName(p.name) !== "" && normalizeName(p.name) === normalizeName(wanted),
    // "warm up" → "Warmup"
    (p) => compact(p.name) !== "" && compact(p.name) === compact(wanted),
  ];
  const slash = wanted.lastIndexOf("/");
  if (slash > 0) {
    const [folder, name] = [wanted.slice(0, slash).trim(), wanted.slice(slash + 1).trim()];
    const inFolder = (p: LibPlaylist) =>
      normalizeName(p.folder) === normalizeName(folder) ||
      normalizeName(p.folder.split("/").pop() ?? "") === normalizeName(folder);
    tiers.push((p) => inFolder(p) && normalizeName(p.name) === normalizeName(name));
  }
  for (const tier of tiers) {
    const hits = playlists.filter(tier);
    if (hits.length === 1) return { kind: "one", playlist: hits[0]! };
    if (hits.length > 1) return { kind: "many", options: hits };
  }
  // "afrobeats party mix" → "AFROBEATS PARTY MIX 2022_2023🔥": the words as a
  // phrase inside exactly one name (several → suggestions, not a guess).
  const phrase = ` ${normalizeName(wanted)} `;
  if (phrase.trim().length >= 4) {
    const inside = playlists.filter((p) => ` ${normalizeName(p.name)} `.includes(phrase));
    if (inside.length === 1) return { kind: "one", playlist: inside[0]! };
  }
  return { kind: "none", suggestions: closestPlaylists(playlists, wanted, 5) };
}

/** "GQOM/Gqom" — how to name one playlist unambiguously. */
export function playlistPath(p: LibPlaylist): string {
  return p.folder ? `${p.folder}/${p.name}` : p.name;
}

/** Playlists ranked by how much their name (or folder + name) looks like `input`. */
export function closestPlaylists(playlists: LibPlaylist[], input: string, n: number): LibPlaylist[] {
  const q = normalizeName(input);
  if (q === "") return [];
  return playlists
    .map((p) => ({
      p,
      score: Math.max(similarity(q, normalizeName(p.name)), 0.9 * similarity(q, normalizeName(`${p.folder} ${p.name}`))),
    }))
    .filter((x) => x.score >= 0.3)
    .sort((a, b) => b.score - a.score || b.p.track_ids.length - a.p.track_ids.length)
    .slice(0, n)
    .map((x) => x.p);
}

/** 0–1: containment, shared words, and shared letter pairs (for typos). */
function similarity(a: string, b: string): number {
  if (a === "" || b === "") return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.85;
  const wa = new Set(a.split(" ")), wb = new Set(b.split(" "));
  const sharedWords = [...wa].filter((w) => wb.has(w) || [...wb].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)))).length;
  const words = sharedWords / Math.max(wa.size, wb.size);
  const pairs = (s: string) => {
    const t = s.replace(/ /g, "");
    const out = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const pa = pairs(a), pb = pairs(b);
  let common = 0, total = 0;
  for (const [k, v] of pa) { common += Math.min(v, pb.get(k) ?? 0); total += v; }
  for (const v of pb.values()) total += v;
  const dice = total === 0 ? 0 : (2 * common) / total;
  return Math.max(words, dice);
}

export function sortPlaylists(playlists: LibPlaylist[]): LibPlaylist[] {
  return [...playlists].sort(
    (a, b) => lower(a.folder).localeCompare(lower(b.folder)) || lower(a.name).localeCompare(lower(b.name)),
  );
}

export interface TrackFilter {
  query?: string;
  artist?: string;
  genre?: string;
  bpmMin?: number;
  bpmMax?: number;
  key?: string;
}

/**
 * Every query word must appear (case-insensitively) in the title, artist,
 * album or genre; artist/genre are substring filters, key is exact, BPM is an
 * inclusive range (tracks without a BPM don't match a BPM filter).
 * Sorted by artist, then title.
 */
export function searchTracks(tracks: LibTrack[], f: TrackFilter): LibTrack[] {
  const words = lower(f.query).split(/\s+/u).filter((w) => w !== "");
  const artist = lower(f.artist);
  const genre = lower(f.genre);
  const key = lower(f.key);
  const hits = tracks.filter((t) => {
    if (words.length > 0) {
      const hay = [t.title, t.artist, t.album, t.genre].map(lower);
      if (!words.every((w) => hay.some((h) => h.includes(w)))) return false;
    }
    if (artist !== "" && !lower(t.artist).includes(artist)) return false;
    if (genre !== "" && !lower(t.genre).includes(genre)) return false;
    if (key !== "" && lower(t.key) !== key) return false;
    if (f.bpmMin !== undefined || f.bpmMax !== undefined) {
      if (t.bpm === null) return false;
      if (f.bpmMin !== undefined && t.bpm < f.bpmMin) return false;
      if (f.bpmMax !== undefined && t.bpm > f.bpmMax) return false;
    }
    return true;
  });
  return hits.sort((a, b) => lower(a.artist).localeCompare(lower(b.artist)) || lower(a.title).localeCompare(lower(b.title)));
}

/** Track ids from a tool call: strings, de-duplicated (order kept), at most MAX_TRACK_IDS. */
export function parseTrackIds(v: unknown, min: number): Result<string[]> {
  if (v === undefined || v === null) {
    return min === 0 ? { ok: true, value: [] } : { ok: false, error: "`track_ids` is required." };
  }
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" || typeof x === "number")) {
    return { ok: false, error: "`track_ids` must be a list of track ids from search_tracks or get_playlist." };
  }
  const ids = [...new Set(v.map((x) => String(x).trim()).filter((x) => x !== ""))];
  if (ids.length < min) return { ok: false, error: "`track_ids` is empty — pass at least one track id." };
  if (ids.length > MAX_TRACK_IDS) {
    return { ok: false, error: `Too many tracks (${ids.length}); pass at most ${MAX_TRACK_IDS} per call.` };
  }
  return { ok: true, value: ids };
}

/** Ids that aren't in the snapshot (at most 10, for the error message). */
export function unknownTrackIds(ids: string[], tracks: LibTrack[]): string[] {
  const known = new Set(tracks.map((t) => t.id));
  return ids.filter((id) => !known.has(id)).slice(0, 10);
}

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
