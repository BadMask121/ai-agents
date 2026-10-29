// What the Telegram bot does with a message, cheapest and surest first:
//   1. code: commands, and links whose playlist name matches one exactly
//   2. Jev: loose wording, acted on only when it's sure AND the playlist's
//      name is really in the message; otherwise its best guesses become buttons
//   3. the assistant (DeepSeek, then Workers AI) for everything else
// Pure functions, shared by the bot and the router eval (evals/router-eval.mts).
// (router.ts is the HTTP router; this is the Telegram message router.)

import { JEV_ACT_CONFIDENCE } from "./constants";
import type { JevRoute } from "./jev";
import { normalizeName, resolvePlaylist } from "./library";
import type { LibPlaylist } from "./store";

export type Decision =
  | { kind: "queue"; playlist: LibPlaylist }
  | { kind: "buttons"; suggest: LibPlaylist[] }
  | { kind: "assistant" }
  | { kind: "list"; filter: string }
  | { kind: "search"; query: string };

const sure = (p: number) => p >= JEV_ACT_CONFIDENCE;
const words = (s: string) => normalizeName(s).split(" ").filter(Boolean);

// ---------- 1. code ----------

const PLAYLIST_LEAD = new Set(["my", "the", "a", "playlist"]);
const PLAYLIST_TAIL = new Set(["playlist", "please", "one", "pls", "thanks"]);
const BEFORE_NAME = new Set(["to", "into", "in", "onto"]);

/**
 * The words after "to" / "into" / "in" ("add this song to Afrobeat - Wa" →
 * "Afrobeat - Wa"), from the first and the last such word, without a leading
 * "my"/"the" or a trailing "playlist".
 */
export function namesAfterPreposition(text: string): string[] {
  const raw = text.split(/\s+/u).filter(Boolean);
  const at = raw.flatMap((w, i) => (BEFORE_NAME.has(w.toLocaleLowerCase()) ? [i] : []));
  const out: string[] = [];
  for (const i of [...new Set([at[0], at.at(-1)])]) {
    if (i === undefined) continue;
    const rest = raw.slice(i + 1);
    while (rest.length > 0 && PLAYLIST_LEAD.has(rest[0]!.toLocaleLowerCase())) rest.shift();
    while (rest.length > 0 && PLAYLIST_TAIL.has(rest.at(-1)!.toLocaleLowerCase())) rest.pop();
    if (rest.length > 0) out.push(rest.join(" "));
  }
  return out;
}

/**
 * The one playlist the words around a link name exactly (case, spacing and
 * punctuation aside), or null. If two readings name different playlists,
 * it's not exact.
 */
export function exactPlaylist(playlists: LibPlaylist[], full: string, hint: string): LibPlaylist | null {
  for (const candidate of [...new Set([full, hint])]) {
    if (candidate === "") continue;
    const m = resolvePlaylist(playlists, candidate);
    if (m.kind === "one") return m.playlist;
  }
  const found = new Map<string, LibPlaylist>();
  for (const candidate of namesAfterPreposition(full)) {
    const m = resolvePlaylist(playlists, candidate);
    if (m.kind === "one") found.set(m.playlist.id, m.playlist);
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

// ---------- 2. Jev ----------

const tokenMatch = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Is this playlist really named in the message? Every word of its name must
 * be there (loosely: "chill" ~ "chilled"), and its folder too when another
 * playlist has the same name. The second, independent check on Jev's pick.
 */
export function namedIn(playlist: LibPlaylist, text: string, playlists: LibPlaylist[]): boolean {
  const have = words(text);
  const has = (w: string) => have.some((h) => tokenMatch(h, w));
  const name = words(playlist.name);
  if (name.length === 0 || !name.every(has)) {
    // "Afrobeat - Wa" typed as "afrobeatwa"
    const squash = (s: string) => normalizeName(s).replace(/ /g, "");
    if (squash(playlist.name).length < 4 || !squash(text).includes(squash(playlist.name))) return false;
  }
  const twins = playlists.filter((p) => p.id !== playlist.id && normalizeName(p.name) === normalizeName(playlist.name));
  if (twins.length > 0) {
    // Only folder words that aren't also name words tell them apart ("3 step gqom"); for
    // GQOM/Gqom vs 3 STEP/Gqom, "gqom" alone can't.
    const own = words(playlist.folder).filter((w) => !name.includes(w));
    if (own.length === 0 || !own.every(has)) return false;
  }
  return true;
}

/** Jev's likely playlists, best first, for buttons. */
const suggestions = (r: JevRoute) => r.ranked.filter((x) => x.p >= 0.05).map((x) => x.playlist);

/** A message with links whose playlist code couldn't pin down. */
export function decideLink(r: JevRoute, hint: string, playlists: LibPlaylist[]): Decision {
  if (sure(r.actionConfidence) && r.action === "other") return { kind: "assistant" };
  if (
    r.action === "download" &&
    sure(r.actionConfidence) &&
    r.playlist !== null &&
    sure(r.playlistConfidence) &&
    namedIn(r.playlist, hint, playlists)
  ) {
    return { kind: "queue", playlist: r.playlist };
  }
  // More than a name's worth of words ("into a new playlist called Lagos
  // Nights") and no strong guess at an existing playlist: the assistant reads it.
  const top = r.ranked[0];
  if (words(hint).length >= 3 && !(top && top.p >= 0.5)) return { kind: "assistant" };
  return { kind: "buttons", suggest: suggestions(r) };
}

const LIST_WORDS = new Set(
  "what which show list me my all the playlists playlist do i have in folder of please can you see get give are there how many is it".split(" "),
);
const SEARCH_WORDS = new Set(
  ("find search look for me show any all my tracks songs track song music tunes tune by from in library the do i have " +
    "get list what which with of please can you up got there are some anything").split(" "),
);
// Searches only the assistant can run: by tempo, key, length, date, or across playlists.
const NEEDS_FILTERS = /\d|\b(bpm|key|keys|genre|genres|tempo|minor|major|longer|shorter|newest|oldest|recent|playlist|playlists)\b/u;

/** A message without links. */
export function decideText(r: JevRoute, text: string): Decision {
  if (!sure(r.actionConfidence)) return { kind: "assistant" };
  if (r.action === "list_playlists") {
    const folder = r.folder !== null && sure(r.folderConfidence) ? r.folder : "";
    const folderWords = new Set(words(folder));
    // Anything said beyond "list my playlists (in <folder>)" is a filter only the assistant can apply.
    const rest = words(text).filter((w) => !LIST_WORDS.has(w) && !folderWords.has(w));
    return rest.length === 0 ? { kind: "list", filter: folder } : { kind: "assistant" };
  }
  if (r.action === "search_tracks") {
    const norm = normalizeName(text);
    if (NEEDS_FILTERS.test(norm)) return { kind: "assistant" };
    const query = words(text).filter((w) => !SEARCH_WORDS.has(w)).join(" ");
    return query === "" ? { kind: "assistant" } : { kind: "search", query };
  }
  return { kind: "assistant" };
}
