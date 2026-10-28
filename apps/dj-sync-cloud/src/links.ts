// Port of apps/dj-sync/src/parser.rs `extract_media_ref`: validate a link and
// rebuild it in canonical form. Keep the two in step — the Mac re-validates
// every URL it claims with the Rust version.

export type MediaKind = "spotify" | "youtube";

export interface MediaRef {
  kind: MediaKind;
  /** Canonical https URL (tracking params and YouTube Mix lists dropped). */
  url: string;
}

export type LinkResult = { ok: true; media: MediaRef } | { ok: false; reason: string };

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

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
  return err(`unsupported site ${JSON.stringify(host)}: send a Spotify or YouTube link`);
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

function err(reason: string): LinkResult {
  return { ok: false, reason };
}

/** Share sheets sometimes hand over "Song by Artist https://…" — keep the link. */
export function linkIn(text: string): string {
  const word = text.split(/\s+/u).find((w) => w.startsWith("https://") || w.startsWith("spotify:"));
  return word ?? text.trim();
}
