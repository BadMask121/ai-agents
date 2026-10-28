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
  const q = lower(cleanName(name));
  if (q === "") return [];
  const words = q.split(" ");
  const scored = playlists
    .map((p) => {
      const pn = lower(p.name);
      const score = pn.includes(q) || q.includes(pn) ? 2 : words.some((w) => w.length > 2 && pn.includes(w)) ? 1 : 0;
      return { name: p.name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return [...new Set(scored.map((x) => x.name))].slice(0, n);
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
