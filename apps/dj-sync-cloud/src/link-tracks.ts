// The songs in a Spotify playlist/album or YouTube playlist link, without
// downloading it, and which of them the DJ already has. Neither is an
// official API (Spotify's Web API no longer lists a playlist's songs without a
// signed-in user; YouTube's needs a key): Spotify's public embed player page
// and YouTube's public playlist page both carry the first 100 songs. Anything
// unexpected comes back as null and the caller says it couldn't read the link.

import { LINK_TRACKS_TIMEOUT_MS } from "./constants";
import { normalizeText, searchIndex, type SearchIndex } from "./search";
import type { LibTrack } from "./store";

export interface LinkTrack {
  title: string;
  /** "Artist, Artist" as Spotify shows them. */
  artists: string;
  durationSecs: number | null;
}

export interface LinkTrackList {
  name: string;
  source: "spotify" | "youtube";
  kind: "playlist" | "album";
  tracks: LinkTrack[];
  /** How many songs the playlist has, when the page says. */
  total: number | null;
  /** The pages stop at about 100 songs: true when some weren't read. */
  mayHaveMore: boolean;
}

/** The embed page shows at most this many songs. */
export const EMBED_MAX_TRACKS = 100;

const SPOTIFY = /^\/(playlist|album)\/([A-Za-z0-9]{10,40})\/?$/u;

/** "playlist"/"album" and the id of a Spotify link, or null. */
export function spotifyCollection(url: string): { kind: "playlist" | "album"; id: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "open.spotify.com") return null;
    const m = SPOTIFY.exec(u.pathname.replace(/^\/intl-[a-z]{2}(-[a-z]{2})?/u, ""));
    return m ? { kind: m[1] as "playlist" | "album", id: m[2]! } : null;
  } catch {
    return null;
  }
}

/** Parse the embed page's __NEXT_DATA__ (exported for tests). */
export function parseEmbed(html: string, kind: "playlist" | "album"): LinkTrackList | null {
  const m = /<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/su.exec(html);
  if (!m) return null;
  try {
    const entity = JSON.parse(m[1]!)?.props?.pageProps?.state?.data?.entity;
    if (!entity || typeof entity.name !== "string" || !Array.isArray(entity.trackList)) return null;
    const tracks: LinkTrack[] = entity.trackList
      .filter((t: { title?: unknown }) => typeof t?.title === "string" && t.title !== "")
      .map((t: { title: string; subtitle?: unknown; duration?: unknown }) => ({
        title: t.title,
        artists: typeof t.subtitle === "string" ? t.subtitle : "",
        durationSecs: typeof t.duration === "number" && t.duration > 0 ? Math.round(t.duration / 1000) : null,
      }));
    return { name: entity.name, source: "spotify", kind, tracks, total: null, mayHaveMore: tracks.length >= EMBED_MAX_TRACKS };
  } catch {
    return null;
  }
}

/** The songs in a Spotify playlist or album link, or null (not one, private, changed, slow). */
export async function spotifyTrackList(url: string, fetcher: typeof fetch = fetch, timeoutMs = LINK_TRACKS_TIMEOUT_MS): Promise<LinkTrackList | null> {
  const ref = spotifyCollection(url);
  if (!ref) return null;
  try {
    const res = await fetcher(`https://open.spotify.com/embed/${ref.kind}/${ref.id}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Mozilla/5.0 (compatible; DJSync/1.0)", accept: "text/html" },
    });
    if (!res.ok) return null;
    return parseEmbed(await res.text(), ref.kind);
  } catch {
    return null;
  }
}

// ---------- YouTube ----------

/** The playlist id of a YouTube playlist link, or null. */
export function youtubePlaylistId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/u.test(u.hostname) || u.pathname !== "/playlist") return null;
    const list = u.searchParams.get("list");
    return list && /^[A-Za-z0-9_-]{10,64}$/u.test(list) ? list : null;
  } catch {
    return null;
  }
}

/** "(Official Video)", "[Lyric Video]", "| Full Video" and the like. */
const VIDEO_NOISE =
  /\s*[([](?:[^)\]]*?\b(?:official|video|audio|lyrics?|visuali[sz]er|oficial|performance|hd|4k|explicit|clip|mv)\b[^)\]]*)[)\]]/giu;
/** Unbracketed: "… OFFICIAL MUSIC VIDEO", "… - Lyric Video", "… | Audio". */
const TRAILING_NOISE = /\s*(?:[-–—|]\s*)?\b(?:official\s+)?(?:music\s+)?(?:lyrics?\s+)?(?:video|audio|visuali[sz]er)(?:\s+oficial)?\s*$/iu;
const CHANNEL_NOISE = /\s*(?:-\s*topic|vevo|oficial|official(?:\s+channel)?|tv|music)\s*$/iu;
const FEAT = /\s+(?:ft\.?|feat\.?|featuring)\s+.*$/iu;

/**
 * A video title as a song: "Artist - Title (Official Video)" or "Title (Video
 * Oficial) - Artist", using the channel to tell which side is the artist.
 * Without a " - ", the channel is the artist.
 */
export function songFromVideo(rawTitle: string, channel: string, durationSecs: number | null): LinkTrack {
  const cleaned = rawTitle.replace(VIDEO_NOISE, "").split(/\s+\|\s+/u)[0]!.replace(TRAILING_NOISE, "").trim();
  const artistGuess = channel.replace(CHANNEL_NOISE, "").trim();
  const dash = cleaned.split(/\s+[-–—]\s+/u);
  if (dash.length >= 2) {
    const [left, right] = [dash[0]!.trim(), dash.slice(1).join(" - ").trim()];
    const ch = normalizeText(artistGuess);
    const rightIsArtist = ch !== "" && normalizeText(right).includes(ch) && !normalizeText(left).includes(ch);
    const [artists, title] = rightIsArtist ? [right, left] : [left, right];
    return { title: title.replace(FEAT, "").trim(), artists, durationSecs };
  }
  return { title: cleaned.replace(FEAT, "").trim(), artists: artistGuess, durationSecs };
}

const seconds = (s: string | undefined) => {
  if (!s || !/^\d+(:\d{2}){1,2}$/u.test(s)) return null;
  return s.split(":").reduce((n, part) => n * 60 + Number(part), 0);
};

/** Parse the playlist page's ytInitialData (exported for tests). */
export function parseYoutubePlaylist(html: string): LinkTrackList | null {
  const m = /var ytInitialData = (\{.+?\});<\/script>/su.exec(html);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]!);
    const name = data?.metadata?.playlistMetadataRenderer?.title;
    if (typeof name !== "string") return null;
    const lockups: Record<string, any>[] = [];
    JSON.stringify(data, (k, v) => {
      if (k === "lockupViewModel" && v?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") lockups.push(v);
      return v;
    });
    // The older layout, in case YouTube serves it.
    const legacy: Record<string, any>[] = [];
    JSON.stringify(data, (k, v) => {
      if (k === "playlistVideoRenderer") legacy.push(v);
      return v;
    });
    const tracks: LinkTrack[] = [
      ...lockups.map((l) => {
        const md = l?.metadata?.lockupMetadataViewModel;
        const title = md?.title?.content;
        const channel = md?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content ?? "";
        const badge = /"text":"(\d+:\d{2}(?::\d{2})?)"/u.exec(JSON.stringify(l?.contentImage ?? {}))?.[1];
        return typeof title === "string" ? songFromVideo(title, String(channel), seconds(badge)) : null;
      }),
      ...legacy.map((v) => {
        const title = v?.title?.runs?.[0]?.text;
        const channel = v?.shortBylineText?.runs?.[0]?.text ?? "";
        const len = Number(v?.lengthSeconds);
        return typeof title === "string" ? songFromVideo(title, String(channel), Number.isFinite(len) && len > 0 ? len : null) : null;
      }),
    ].filter((t): t is LinkTrack => t !== null && t.title !== "");
    const stats = JSON.stringify(data?.sidebar?.playlistSidebarRenderer ?? {});
    const total = Number(/"text":"([\d,]+)"\},\{"text":" videos?"/u.exec(stats)?.[1]?.replace(/,/g, "") ?? NaN);
    const known = Number.isFinite(total) && total > 0 ? total : null;
    return {
      name,
      source: "youtube",
      kind: "playlist",
      tracks,
      total: known,
      mayHaveMore: known !== null ? tracks.length < known : tracks.length >= EMBED_MAX_TRACKS,
    };
  } catch {
    return null;
  }
}

async function youtubeTrackList(list: string, fetcher: typeof fetch, timeoutMs: number): Promise<LinkTrackList | null> {
  try {
    const res = await fetcher(`https://www.youtube.com/playlist?list=${list}&hl=en&gl=US`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        cookie: "CONSENT=YES+1",
      },
    });
    if (!res.ok) return null;
    return parseYoutubePlaylist(await res.text());
  } catch {
    return null;
  }
}

/** The songs in a Spotify playlist/album or YouTube playlist link, or null. */
export async function linkTrackList(url: string, fetcher: typeof fetch = fetch, timeoutMs = LINK_TRACKS_TIMEOUT_MS): Promise<LinkTrackList | null> {
  const list = youtubePlaylistId(url);
  if (list) return youtubeTrackList(list, fetcher, timeoutMs);
  return spotifyTrackList(url, fetcher, timeoutMs);
}

// ---------- matching against the library ----------

export interface LinkMatch {
  song: LinkTrack;
  /** exact: this song; close: probably (check first); none: not in the library. */
  match: "exact" | "close" | "none";
  track: LibTrack | null;
}

/** The title without "(feat. …)", "[…]" or " - Remix" parts. */
const coreTitle = (t: string) => normalizeText(t.replace(/\s*[([].*?[)\]]/gu, "").replace(/\s+-\s+.*$/u, ""));
const VERSION = /\b(remix|edit|mix|version|live|acoustic|instrumental|acapella|a cappella|sped up|slowed|remaster(ed)?|dub|vip|bootleg|extended)\b/u;
const versionOf = (t: string) => (normalizeText(t).match(new RegExp(VERSION, "gu")) ?? []).sort().join(" ");
/** Lengths further apart than this (seconds) are probably different recordings (videos run longer). */
const DURATION_SLACK = { spotify: 10, youtube: 30 } as const;

/**
 * Find one linked song in the library. Exact needs the same core title, the
 * same version (a remix isn't the original) and, when both are known, about
 * the same length; anything weaker is close, so nothing acts on it unasked.
 */
export function matchSong(index: SearchIndex, song: LinkTrack, source: LinkTrackList["source"] = "spotify"): LinkMatch {
  const firstArtist = song.artists.split(",")[0]?.trim() ?? "";
  const queries = [`${song.title} ${song.artists}`, `${coreTitle(song.title)} ${firstArtist}`, coreTitle(song.title)];
  let close: LibTrack | null = null;
  for (const q of queries) {
    const r = searchIndex(index, { query: q });
    for (const t of r.tracks.slice(0, 5)) {
      const sameTitle = coreTitle(t.title) === coreTitle(song.title);
      const sameVersion = versionOf(t.title) === versionOf(song.title);
      const sameArtist = firstArtist === "" || normalizeText(t.artist).includes(normalizeText(firstArtist));
      const sameLength =
        song.durationSecs === null || t.duration_secs === null || Math.abs(song.durationSecs - t.duration_secs) <= DURATION_SLACK[source];
      if (r.match === "exact" && sameTitle && sameVersion && sameArtist && sameLength) return { song, match: "exact", track: t };
      if (!close && sameTitle && sameArtist) close = t;
    }
    if (!close && r.match !== "none") close = r.tracks[0] ?? null;
    if (close && coreTitle(close.title) === coreTitle(song.title)) break;
  }
  // Only a near-miss worth showing: same core title, or a close search hit.
  return close && coreTitle(close.title) === coreTitle(song.title) ? { song, match: "close", track: close } : { song, match: "none", track: null };
}
