// The name of a Spotify, YouTube or SoundCloud playlist (or album) from its
// link, so "download this playlist" lands in a Rekordbox playlist of the same
// name. All three answer oEmbed without a key; the title is all we read.

import { MAX_PLAYLIST_NAME, OEMBED_TIMEOUT_MS } from "./constants";
import { cleanName } from "./library";

/** A link to a whole playlist or album (not one track or video). */
export function isCollection(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === "open.spotify.com") return /^\/(playlist|album)\//u.test(u.pathname);
    if (SOUNDCLOUD_HOSTS.has(u.hostname)) return /^\/[^/]+\/sets\//u.test(u.pathname);
    return u.pathname === "/playlist" && u.searchParams.has("list");
  } catch {
    return false;
  }
}

const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]);

function oembedUrl(url: string): string | null {
  const u = new URL(url);
  if (u.hostname === "open.spotify.com") return `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  if (u.hostname.endsWith("youtube.com")) return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  if (SOUNDCLOUD_HOSTS.has(u.hostname)) return `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  return null;
}

/** The playlist's or album's title, or null (not a collection, private, slow or down). */
export async function collectionTitle(url: string, fetcher: typeof fetch = fetch, timeoutMs = OEMBED_TIMEOUT_MS): Promise<string | null> {
  if (!isCollection(url)) return null;
  const endpoint = oembedUrl(url);
  if (!endpoint) return null;
  try {
    const res = await fetcher(endpoint, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const title = ((await res.json()) as { title?: unknown }).title;
    if (typeof title !== "string") return null;
    const name = cleanName(title).slice(0, MAX_PLAYLIST_NAME).trim();
    return name === "" ? null : name;
  } catch {
    return null;
  }
}
