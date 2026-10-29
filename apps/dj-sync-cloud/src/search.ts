// Track search over a DJ's library snapshot: an in-memory index built once
// per snapshot, ranked with BM25 (title counts most, then artist, album,
// genre; rare words count more than common ones), tolerant of accents,
// punctuation, filler words and small typos. Results say whether they are
// exact (every word found, whole or as the start of a word) or only close
// (a typo was forgiven or a word wasn't found), so nothing acts on a
// near-miss without asking.

import type { LibTrack } from "./store";

export interface TrackFilter {
  query?: string;
  artist?: string;
  genre?: string;
  bpmMin?: number;
  bpmMax?: number;
  key?: string;
}

export type MatchKind = "exact" | "close" | "none";

export interface SearchResult {
  tracks: LibTrack[];
  /** "exact": every query word found; "close": only near-misses; "none": nothing. No query → "exact". */
  match: MatchKind;
}

// ---------- text ----------

/** Lowercase, no accents, "&" → "and", apostrophes dropped, other punctuation → space. */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const tokens = (s: string | null | undefined) => normalizeText(s).split(" ").filter(Boolean);

/** Words that say nothing about which track: dropped from queries (unless that leaves nothing). */
const FILLER = new Set(
  "a an and the of by ft feat featuring with x vs song songs track tracks tune tunes music remixes version".split(" "),
);

export function queryWords(query: string | undefined): string[] {
  const all = tokens(query);
  const kept = all.filter((w) => !FILLER.has(w));
  return [...new Set(kept.length > 0 ? kept : all)];
}

// ---------- the index ----------

const FIELDS = ["title", "artist", "album", "genre"] as const;
/** BM25F field weights: a title match counts most. */
const WEIGHT: Record<(typeof FIELDS)[number], number> = { title: 3, artist: 2, album: 1, genre: 1 };
const K1 = 1.2;
const B = 0.75;

export interface SearchIndex {
  tracks: LibTrack[];
  /** Every indexed word, sorted (prefix lookups by binary search); a word's id is its position. */
  vocab: string[];
  wordId: Map<string, number>;
  /** Word i's tracks are docs[start[i]..start[i+1]), with their weighted term frequencies in tf. */
  start: Int32Array;
  docs: Int32Array;
  tf: Float32Array;
  idf: Float32Array;
  /** "<first letter><length>" → word ids, for the typo scan. */
  buckets: Map<string, number[]>;
  /** Per track, normalised once: artist and genre (filters) and the artist/title sort key. */
  artist: string[];
  genre: string[];
  sortKey: string[];
}

/**
 * Build the index for a snapshot, in a few flat arrays (a 50,000-track
 * library is tens of thousands of words). Artist names are also indexed with
 * adjacent words joined ("burna boy" → "burnaboy"), so a name typed as one
 * word, or with a letter off, still matches.
 */
export function buildIndex(tracks: LibTrack[]): SearchIndex {
  const artist = tracks.map((t) => normalizeText(t.artist));
  const genre = tracks.map((t) => normalizeText(t.genre));
  const sortKey = tracks.map((t, i) => `${artist[i]}\u0000${normalizeText(t.title)}`);
  const fieldWords = tracks.map((t) =>
    FIELDS.map((f) => {
      const w = tokens(t[f]);
      return f === "artist" ? [...w, ...w.slice(1).map((x, i) => w[i] + x)] : w;
    }),
  );
  const avg = FIELDS.map((_, fi) => Math.max(1, fieldWords.reduce((n, fw) => n + fw[fi]!.length, 0) / Math.max(1, tracks.length)));

  // Pass 1: each track's weighted term frequencies, and each word's document count.
  const perDoc: [string, number][][] = [];
  const df = new Map<string, number>();
  fieldWords.forEach((fw) => {
    const wtf = new Map<string, number>();
    FIELDS.forEach((f, fi) => {
      const words = fw[fi]!;
      const norm = 1 - B + B * (words.length / avg[fi]!);
      for (const w of words) wtf.set(w, (wtf.get(w) ?? 0) + WEIGHT[f] / norm);
    });
    for (const w of wtf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    perDoc.push([...wtf]);
  });

  // Pass 2: flat postings in vocabulary order.
  const vocab = [...df.keys()].sort();
  const wordId = new Map(vocab.map((w, i) => [w, i]));
  const start = new Int32Array(vocab.length + 1);
  vocab.forEach((w, i) => (start[i + 1] = start[i]! + df.get(w)!));
  const docs = new Int32Array(start[vocab.length]!);
  const tf = new Float32Array(start[vocab.length]!);
  const cursor = start.slice(0, vocab.length);
  perDoc.forEach((entries, doc) => {
    for (const [w, v] of entries) {
      const id = wordId.get(w)!;
      docs[cursor[id]!] = doc;
      tf[cursor[id]!++] = v;
    }
  });
  const n = tracks.length;
  const idf = new Float32Array(vocab.length);
  const buckets = new Map<string, number[]>();
  vocab.forEach((w, i) => {
    const d = df.get(w)!;
    idf[i] = Math.log(1 + (n - d + 0.5) / (d + 0.5));
    const key = `${w[0]}${w.length}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(i);
  });
  return { tracks, vocab, wordId, start, docs, tf, idf, buckets, artist, genre, sortKey };
}

// ---------- matching words ----------

/** Optimal string alignment distance (a swap of neighbours is one edit), giving up above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      cur.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]!;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Edits forgiven for a word this long: none below 4 letters, 1 up to 7, 2 from 8. */
const typosAllowed = (len: number) => (len < 4 ? 0 : len < 8 ? 1 : 2);
/** How much a match counts: the word itself, a word it starts, a near-miss. */
const EXACT = 1;
const PREFIX = 0.8;
const TYPO = 0.6;
const PREFIX_MIN = 3;

interface WordMatch {
  id: number;
  weight: number;
  /** A typo was forgiven. */
  close: boolean;
}

function lowerBound(sorted: string[], key: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index words that match a query word, and how well: the word itself and
 * words it starts; only if there are none, words a typo or two away with the
 * same first letter (or the first two letters swapped).
 */
function matchesFor(index: SearchIndex, q: string): WordMatch[] {
  const out: WordMatch[] = [];
  const self = index.wordId.get(q);
  if (self !== undefined) out.push({ id: self, weight: EXACT, close: false });
  if (q.length >= PREFIX_MIN) {
    for (let i = lowerBound(index.vocab, q); i < index.vocab.length && index.vocab[i]!.startsWith(q); i++) {
      if (i !== self) out.push({ id: i, weight: PREFIX, close: false });
    }
  }
  if (out.length > 0) return out;
  const max = typosAllowed(q.length);
  if (max === 0) return out;
  const firsts = q.length > 1 && q[1] !== q[0] ? [q[0], q[1]] : [q[0]];
  for (const first of firsts) {
    for (let len = q.length - max; len <= q.length + max; len++) {
      for (const id of index.buckets.get(`${first}${len}`) ?? []) {
        if (editDistance(q, index.vocab[id]!, max) <= max) out.push({ id, weight: TYPO, close: true });
      }
    }
  }
  return out;
}

// ---------- searching ----------

function passesFilters(index: SearchIndex, doc: number, f: TrackFilter, artist: string, genre: string, key: string): boolean {
  const t = index.tracks[doc]!;
  if (artist !== "" && !index.artist[doc]!.includes(artist)) return false;
  if (genre !== "" && !index.genre[doc]!.includes(genre)) return false;
  if (key !== "" && (t.key ?? "").toLocaleLowerCase() !== key) return false;
  if (f.bpmMin !== undefined || f.bpmMax !== undefined) {
    if (t.bpm === null) return false;
    if (f.bpmMin !== undefined && t.bpm < f.bpmMin) return false;
    if (f.bpmMax !== undefined && t.bpm > f.bpmMax) return false;
  }
  return true;
}


/**
 * Tracks for a filter, best first. With query words: tracks with every word
 * (whole, or a word starting with it) are "exact"; if there are none, the
 * tracks with most words — typos forgiven — come back as "close". Without a
 * query, the filtered tracks by artist then title.
 */
export function searchIndex(index: SearchIndex, f: TrackFilter): SearchResult {
  const artist = normalizeText(f.artist);
  const genre = normalizeText(f.genre);
  const key = (f.key ?? "").trim().toLocaleLowerCase();
  const words = queryWords(f.query);
  const filtering = artist !== "" || genre !== "" || key !== "" || f.bpmMin !== undefined || f.bpmMax !== undefined;
  const allowed = (doc: number) => !filtering || passesFilters(index, doc, f, artist, genre, key);
  const byKey = (a: number, b: number) => (index.sortKey[a]! < index.sortKey[b]! ? -1 : index.sortKey[a]! > index.sortKey[b]! ? 1 : 0);

  if (words.length === 0) {
    const docs = index.tracks.map((_, i) => i).filter(allowed).sort(byKey);
    return { tracks: docs.map((d) => index.tracks[d]!), match: docs.length > 0 ? "exact" : "none" };
  }

  // Per track: summed score, how many query words it has, and whether any needed a typo forgiven.
  const score = new Map<number, number>();
  const found = new Map<number, number>();
  const typo = new Map<number, boolean>();
  for (const q of words) {
    const best = new Map<number, { s: number; close: boolean }>();
    for (const m of matchesFor(index, q)) {
      const idf = index.idf[m.id]!;
      for (let i = index.start[m.id]!; i < index.start[m.id + 1]!; i++) {
        const doc = index.docs[i]!;
        const tf = index.tf[i]!;
        const s = m.weight * idf * ((tf * (K1 + 1)) / (tf + K1));
        const prev = best.get(doc);
        if (!prev || s > prev.s) best.set(doc, { s, close: m.close });
      }
    }
    for (const [doc, { s, close }] of best) {
      score.set(doc, (score.get(doc) ?? 0) + s);
      found.set(doc, (found.get(doc) ?? 0) + 1);
      if (close) typo.set(doc, true);
    }
  }

  const candidates = [...found.keys()].filter(allowed);
  const exact = candidates.filter((d) => found.get(d) === words.length && !typo.get(d));
  const rank = (a: number, b: number) => found.get(b)! - found.get(a)! || score.get(b)! - score.get(a)! || byKey(a, b);
  if (exact.length > 0) return { tracks: exact.sort(rank).map((d) => index.tracks[d]!), match: "exact" };
  // Close: at least half the words (and at least one) found.
  const need = Math.max(1, Math.ceil(words.length / 2));
  const close = candidates.filter((d) => found.get(d)! >= need).sort(rank);
  return close.length > 0 ? { tracks: close.map((d) => index.tracks[d]!), match: "close" } : { tracks: [], match: "none" };
}

/** A store that may keep the index for its snapshot (SqlStore does). */
export interface IndexSource {
  getLibraryTracks(): Promise<LibTrack[] | null>;
  getSearchIndex?(): Promise<SearchIndex | null>;
}

/** The snapshot's index: the store's cached one, or built now. Null without a snapshot. */
export async function libraryIndex(store: IndexSource): Promise<SearchIndex | null> {
  if (store.getSearchIndex) return store.getSearchIndex();
  const tracks = await store.getLibraryTracks();
  return tracks ? buildIndex(tracks) : null;
}

/** One-off search without a cached index (tests, small lists). */
export function searchTracks(tracks: LibTrack[], f: TrackFilter): SearchResult {
  return searchIndex(buildIndex(tracks), f);
}
