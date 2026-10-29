// HTTP handlers shared by the v1 routes (router.ts) and each DJ's Tenant
// Durable Object (tenant.ts): MCP transport rules and the Shortcut REST API.
// Callers authenticate first; nothing here logs URLs (they hold secrets).

import { MAX_BODY_BYTES, SUPPORTED_MCP_VERSIONS } from "./constants";
import { agentStatus, jobView, offlineNote, submit, type Deps } from "./jobs";
import { cleanName, playlistPath, plural, resolvePlaylist, sortPlaylists } from "./library";
import { extractMediaRef, linkIn, linksIn, type MediaRef } from "./links";
import { dispatch, parseError } from "./mcp";
import { empty, json } from "./util";

/**
 * One MCP POST: size, Origin and protocol-version rules, then dispatch.
 * `onMessage` sees the parsed message first and may answer it instead
 * (per-DJ rate limits).
 */
export async function mcpPost(
  req: Request,
  deps: Deps,
  onMessage?: (msg: unknown) => Promise<unknown | undefined>,
): Promise<Response> {
  const body = await readJson(req);
  if (body.kind === "too_large") return empty(413);

  if (!originAllowed(req.headers.get("origin"), deps.config.publicHost)) {
    return json({ jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } }, 403);
  }
  // A version we don't speak — including 2026-07-28's per-request probe — gets
  // a bare 400, which tells newer clients to fall back to `initialize`.
  const version = req.headers.get("mcp-protocol-version");
  if (version !== null && !(SUPPORTED_MCP_VERSIONS as readonly string[]).includes(version)) {
    return empty(400);
  }
  if (body.kind === "invalid") return json(parseError(), 400);

  const early = await onMessage?.(body.value);
  if (early !== undefined) return json(early);
  const reply = await dispatch(body.value, deps);
  return reply === null ? empty(202) : json(reply);
}

/**
 * DNS-rebinding guard from the MCP spec: browsers always send Origin, so a
 * present-but-foreign one is refused. ChatGPT's and Claude's backends
 * normally send none. `publicHosts`: our own hostname(s), comma-separated
 * (canonical first, then aliases).
 */
export function originAllowed(origin: string | null, publicHosts: string): boolean {
  if (origin === null) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    ["localhost", "127.0.0.1", "[::1]", "chatgpt.com", "chat.openai.com", "claude.ai"].includes(host) ||
    host.endsWith(".chatgpt.com") ||
    host.endsWith(".openai.com") ||
    host.endsWith(".claude.ai") ||
    host.endsWith(".anthropic.com") ||
    publicHosts
      .toLowerCase()
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)
      .includes(host)
  );
}

// ---------- REST for the iOS Shortcut (caller has checked the bearer) ----------

export function bearer(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

/** `message` is for people: the iPhone Shortcut shows it as a notification. */
export function unauthorized(message = "Wrong or missing key."): Response {
  return json({ error: "missing or wrong bearer token", message }, 401, { "www-authenticate": "Bearer" });
}

/** The Shortcut's key no longer works (link deleted or rotated, or a typo). */
export const SHORTCUT_DISCONNECTED =
  "This Shortcut isn't connected to DJ Sync any more — make a new one in DJ Sync on your Mac (Assistants → Connect iPhone).";

/** A Shortcut API error: `error` for programs, `message` for the notification. */
function apiError(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, message, ...extra }, status);
}

const NO_LINKS =
  "No Spotify, YouTube or SoundCloud link found — share a song, album or playlist from Spotify or SoundCloud, or a video from YouTube.";

export async function apiSubmit(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson(req);
  if (body.kind === "too_large") return apiError(413, "too large", "That's too much text to send to DJ Sync.");
  if (body.kind === "invalid" || typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
    return apiError(400, 'expected JSON {"url": …}', "DJ Sync couldn't read that request — update the Shortcut from DJ Sync on your Mac.");
  }
  const b = body.value as Record<string, unknown>;
  if (b.text !== undefined && b.text !== null && typeof b.text !== "string") {
    return apiError(400, "text must be a string", NO_LINKS);
  }
  // `text`: whatever the Share sheet handed over ("Song by Artist https://…").
  const inputs: unknown[] = [
    ...(b.url !== undefined && b.url !== null ? [b.url] : []),
    ...(Array.isArray(b.urls) ? b.urls : []),
    ...(typeof b.text === "string" ? linksIn(b.text) : []),
  ];
  if (inputs.length === 0) return apiError(400, "send `url`, `urls` or `text` with a link", NO_LINKS);
  if (inputs.length > deps.config.maxUrls) {
    return apiError(400, `at most ${deps.config.maxUrls} links per request`, `That's ${inputs.length} links — send at most ${deps.config.maxUrls} at a time.`);
  }
  if (b.playlist_name !== undefined && b.playlist_name !== null && typeof b.playlist_name !== "string") {
    return apiError(400, "playlist_name must be a string", "DJ Sync couldn't read the playlist — update the Shortcut from DJ Sync on your Mac.");
  }
  if (b.playlist_id !== undefined && b.playlist_id !== null && typeof b.playlist_id !== "string") {
    return apiError(400, "playlist_id must be a string", "DJ Sync couldn't read the playlist — update the Shortcut from DJ Sync on your Mac.");
  }

  const media: MediaRef[] = [];
  const rejected: { url: unknown; reason: string }[] = [];
  for (const raw of inputs) {
    if (typeof raw !== "string") {
      rejected.push({ url: raw, reason: "not a string" });
      continue;
    }
    const r = extractMediaRef(linkIn(raw));
    if (!r.ok) rejected.push({ url: raw, reason: r.reason });
    else if (!media.some((m) => m.url === r.media.url)) media.push(r.media);
  }
  if (media.length === 0) return apiError(400, "no supported Spotify, YouTube or SoundCloud links", NO_LINKS, { rejected });

  // A pinned playlist_id wins; a name (or "Folder/Name" path from
  // GET /api/playlists) that matches one playlist is pinned too; anything
  // else is used as given — the Shortcut is a direct action, not a chat.
  let playlistName = (b.playlist_name as string | undefined) ?? null;
  let playlistId: string | null = null;
  const pinned = typeof b.playlist_id === "string" && b.playlist_id !== "" ? b.playlist_id : null;
  if (pinned !== null || (playlistName !== null && cleanName(playlistName) !== "")) {
    const playlists = await deps.store.getLibraryPlaylists();
    if (pinned !== null) {
      const p = playlists?.find((x) => x.id === pinned);
      if (!p) {
        return apiError(
          400,
          "no playlist has that playlist_id; get one from GET /api/playlists",
          "That playlist isn't in your Rekordbox library any more — pick another one.",
        );
      }
      playlistName = p.name;
      playlistId = p.id;
    } else if (playlists) {
      const m = resolvePlaylist(playlists, playlistName!);
      if (m.kind === "one") {
        playlistName = m.playlist.name;
        playlistId = m.playlist.id;
      }
    }
  }

  const sub = await submit(deps, media, playlistName, "shortcut", playlistId);
  if (!sub.ok) return apiError(400, sub.error, sub.error);
  const { job, position, deduplicated } = sub.value;
  const agent = await agentStatus(deps);
  // The Shortcut shows `message` in a notification, so make it self-explanatory.
  const links = plural(job.urls.length, "link");
  const message =
    deduplicated && job.state === "done"
      ? `Already in Rekordbox, in “${job.playlist}”.`
      : (deduplicated ? `Already sent to “${job.playlist}”` : `Sent ${links} to “${job.playlist}”`) +
        " — it'll be in Rekordbox in a few minutes." +
        (agent.online ? "" : offlineNote(agent, deps.now()));
  return json(
    { ...jobView(job), playlist_id: job.playlist_id ?? null, message, position, deduplicated, rejected, mac_online: agent.online },
    202,
  );
}

/**
 * GET /api/playlists: the DJ's playlists for the Shortcut's "Choose from
 * List" — the DJ Sync folder first, then A–Z by path. `names` is that list
 * as plain strings with the default playlist first (spec §2b): the signed
 * Shortcut shows it as is and posts the pick back as playlist_name.
 */
export async function apiPlaylists(deps: Deps): Promise<Response> {
  const playlists = (await deps.store.getLibraryPlaylists()) ?? [];
  const djSync = (p: { folder: string }) => (p.folder === "DJ Sync" ? 0 : 1);
  const rows = sortPlaylists(playlists)
    .map((p) => ({ playlist_id: p.id, name: p.name, folder: p.folder, path: playlistPath(p), tracks: p.track_ids.length }))
    .sort((a, b) => djSync(a) - djSync(b) || a.path.toLocaleLowerCase().localeCompare(b.path.toLocaleLowerCase()));
  const names = [...new Set([deps.config.defaultPlaylist, ...rows.map((r) => r.path)])];
  return json({ playlists: rows, names });
}

export async function apiStatus(jobId: string, deps: Deps): Promise<Response> {
  const job = await deps.store.getJob(jobId);
  if (!job) return apiError(404, "no such job", "DJ Sync doesn't know that download.");
  const agent = await agentStatus(deps);
  return json({ ...jobView(job), mac_online: agent.online });
}

// ---------- helpers ----------

export type Body = { kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too_large" };

export async function readJson(req: Request, limit = MAX_BODY_BYTES): Promise<Body> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return { kind: "too_large" };
  const buf = await req.arrayBuffer();
  if (buf.byteLength > limit) return { kind: "too_large" };
  try {
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { kind: "invalid" };
  }
}
