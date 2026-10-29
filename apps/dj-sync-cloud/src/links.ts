// Port of apps/dj-sync/src/parser.rs `extract_media_ref`: validate a link and
// rebuild it in canonical form. Keep the two in step — the Mac re-validates
// every URL it claims with the Rust version.

export type MediaKind = "spotify" | "youtube" | "soundcloud";

export interface MediaRef {
  kind: MediaKind;
  /** Canonical https URL (tracking params and YouTube Mix lists dropped). */
  url: string;
}

export type LinkResult = { ok: true; media: MediaRef } | { ok: false; reason: string };

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]);

export function extractMediaRef(raw: string): LinkResult {
  const input = raw.trim();
  if (input.startsWith("spotify:")) {
    const rest = input.slice("spotify:".length);
    const colon = rest.indexOf(":");
    if (colon < 0) return err(`unrecognised Spotify URI: ${input}`);
    return spotifyRef(rest.slice(0, colon), rest.slice(colon + 1));
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return err(`not a URL: ${input}`);
  }
  if (url.protocol !== "https:") return err(`only https links are accepted: ${input}`);

  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split("/").filter((s) => s !== "");

  if (host === "open.spotify.com") {
    // Optional locale prefix: /intl-fr/track/<id>
    const s = segs[0]?.startsWith("intl-") ? segs.slice(1) : segs;
    const [kind, id] = s;
    if (kind === undefined || id === undefined) {
      return err(`not a Spotify track, album or playlist link: ${input}`);
    }
    return spotifyRef(kind, id);
  }
  if (YOUTUBE_HOSTS.has(host)) {
    if (segs.length === 1 && segs[0] === "watch") {
      return youtubeVideo(url.searchParams.get("v") ?? "", input);
    }
    if (segs.length === 2 && (segs[0] === "shorts" || segs[0] === "live")) {
      return youtubeVideo(segs[1]!, input);
    }
    if (segs.length === 1 && segs[0] === "playlist") {
      return youtubePlaylist(url.searchParams.get("list") ?? "", input);
    }
    return err(`not a YouTube video or playlist link: ${input}`);
  }
  if (host === "youtu.be") {
    return segs.length === 1 ? youtubeVideo(segs[0]!, input) : err(`not a YouTube video link: ${input}`);
  }
  if (SOUNDCLOUD_HOSTS.has(host)) {
    return soundcloudRef(segs, url, input);
  }
  if (host === "on.soundcloud.com") {
    return err("SoundCloud share links can't be checked; open the link and send the full soundcloud.com address");
  }
  return err(`unsupported site ${JSON.stringify(host)}: send a Spotify, YouTube or SoundCloud link`);
}

function spotifyRef(kind: string, id: string): LinkResult {
  if (kind !== "track" && kind !== "album" && kind !== "playlist") {
    return err(`Spotify ${kind} links aren't supported; send a track, album or playlist`);
  }
  if (id.length === 0 || id.length > 64 || !/^[A-Za-z0-9]+$/.test(id)) {
    return err(`invalid Spotify ${kind} id: ${JSON.stringify(id)}`);
  }
  return { ok: true, media: { kind: "spotify", url: `https://open.spotify.com/${kind}/${id}` } };
}

function isYoutubeId(id: string, min: number, max: number): boolean {
  return id.length >= min && id.length <= max && /^[A-Za-z0-9_-]+$/.test(id);
}

function youtubeVideo(id: string, input: string): LinkResult {
  // Video ids are always 11 chars of [A-Za-z0-9_-] (and may start with '-').
  if (!isYoutubeId(id, 11, 11)) return err(`no valid YouTube video id in ${input}`);
  return { ok: true, media: { kind: "youtube", url: `https://www.youtube.com/watch?v=${id}` } };
}

function youtubePlaylist(list: string, input: string): LinkResult {
  if (!isYoutubeId(list, 2, 64)) return err(`no valid YouTube playlist id in ${input}`);
  // Auto-generated "Mix" playlists never end.
  if (list.startsWith("RD")) return err("YouTube Mix playlists aren't supported; send the video link");
  return { ok: true, media: { kind: "youtube", url: `https://www.youtube.com/playlist?list=${list}` } };
}

/** SoundCloud artist/track/set slugs: the URL-safe words its paths are built from. */
function isSoundcloudSlug(s: string): boolean {
  return s.length >= 1 && s.length <= 128 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** Profile tabs that share the `/artist/<word>` shape with tracks. */
function isSoundcloudTab(s: string): boolean {
  return ["sets", "tracks", "albums", "likes", "spotlight", "reposts", "followers", "following", "stats", "playlists", "groups", "posts", "permalink"].includes(s);
}

/**
 * SoundCloud track and set links: `/artist/track` or `/artist/sets/set-name`.
 * A trailing `/s-<token>` segment or `?secret_token=` param unlocks a private
 * track — kept either way, since the link is useless without its secret.
 */
function soundcloudRef(segs: string[], url: URL, input: string): LinkResult {
  // A token is only ever a third-or-later segment: `artist/s-foo` is a track
  // whose slug happens to start with "s-".
  const last = segs.at(-1);
  const hasToken = segs.length >= 3 && last !== undefined && last.startsWith("s-") && last.length > 2 && isSoundcloudSlug(last);
  const pathSegs = hasToken ? segs.slice(0, -1) : segs;
  const isTrack = pathSegs.length === 2 && pathSegs[0] !== undefined && pathSegs[1] !== undefined && !isSoundcloudTab(pathSegs[1]) && isSoundcloudSlug(pathSegs[0]) && isSoundcloudSlug(pathSegs[1]);
  const isSet = pathSegs.length === 3 && pathSegs[1] === "sets" && pathSegs[0] !== undefined && pathSegs[2] !== undefined && isSoundcloudSlug(pathSegs[0]) && isSoundcloudSlug(pathSegs[2]);
  if (!isTrack && !isSet) {
    return err(`not a SoundCloud track or set link: ${input}`);
  }
  let out = `https://soundcloud.com/${segs.join("/")}`;
  if (!hasToken) {
    const secret = url.searchParams.get("secret_token");
    if (secret !== null) out += `?secret_token=${encodeURIComponent(secret)}`;
  }
  return { ok: true, media: { kind: "soundcloud", url: out } };
}

function err(reason: string): LinkResult {
  return { ok: false, reason };
}

/** A word that is a link (sentence punctuation after it dropped), or null. */
export function asLink(word: string): string | null {
  return /^(https?:\/\/|spotify:)/iu.test(word) ? word.replace(/[),.!?]+$/u, "") : null;
}

/** Every link in free text, in order: what a Share sheet or a chat message hands over. */
export function linksIn(text: string): string[] {
  return text
    .split(/\s+/u)
    .map(asLink)
    .filter((l): l is string => l !== null && l !== "");
}

/** Share sheets sometimes hand over "Song by Artist https://…" — keep the link. */
export function linkIn(text: string): string {
  const word = text.split(/\s+/u).find((w) => w.startsWith("https://") || w.startsWith("spotify:"));
  return word ?? text.trim();
}
