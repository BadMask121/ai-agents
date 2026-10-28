// Stateless MCP (JSON-RPC 2.0) dispatch — port of apps/dj-sync/src/mcp.rs.
// Transport concerns (status codes, headers) live in router.ts; this maps one
// message to at most one response (`null` = notification → 202).

import {
  MAX_PLAYLIST_NAME,
  MAX_TRACK_IDS,
  PLAYLIST_TRACKS_SHOWN,
  RECENT_JOBS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SUPPORTED_MCP_VERSIONS,
  WORKER_VERSION,
} from "./constants";
import {
  agentStatus,
  jobView,
  normalizePlaylistName,
  offlineNote,
  stateWord,
  submit,
  submitLibrary,
  type AgentStatus,
  type Deps,
} from "./jobs";
import {
  NO_LIBRARY,
  cleanName,
  findPlaylist,
  parseTrackIds,
  plural,
  searchTracks,
  sortPlaylists,
  suggestPlaylists,
  trackView,
  unknownTrackIds,
} from "./library";
import { extractMediaRef, type MediaRef } from "./links";
import type { JobRow, LibPlaylist, LibTrack, LibraryOp } from "./store";
import { errorSummary, relativeTime } from "./util";

const DOWNLOAD_TOOL = "download_to_rekordbox";
const STATUS_TOOL = "get_download_status";
const LIST_PLAYLISTS = "list_playlists";
const SEARCH_TRACKS = "search_tracks";
const GET_PLAYLIST = "get_playlist";
const CREATE_PLAYLIST = "create_playlist";
const ADD_TRACKS = "add_tracks_to_playlist";
const REMOVE_TRACKS = "remove_tracks_from_playlist";
const RENAME_PLAYLIST = "rename_playlist";
const DELETE_PLAYLIST = "delete_playlist";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Json = unknown;
type Obj = Record<string, unknown>;

export function parseError(): Json {
  return error(null, PARSE_ERROR, "Parse error: body is not valid JSON");
}

export async function dispatch(msg: Json, deps: Deps): Promise<Json | null> {
  if (Array.isArray(msg)) return error(null, INVALID_REQUEST, "JSON-RPC batches are not supported");
  if (!isObj(msg)) return error(null, INVALID_REQUEST, "expected a JSON-RPC object");

  const hasId = "id" in msg;
  const method = typeof msg.method === "string" ? msg.method : undefined;
  if (!hasId || method === undefined) {
    // No id: a notification (e.g. notifications/initialized) — nothing to say.
    return hasId ? error(msg.id, INVALID_REQUEST, "missing method") : null;
  }
  const id = msg.id;
  if (msg.jsonrpc !== "2.0") return error(id, INVALID_REQUEST, 'jsonrpc must be "2.0"');
  const params = isObj(msg.params) ? msg.params : {};

  switch (method) {
    case "initialize":
      return ok(id, initialize(params));
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: toolDefinitions(deps.config.maxUrls) });
    case "tools/call": {
      const name = params.name;
      const args = isObj(params.arguments) ? params.arguments : undefined;
      const handler = typeof name === "string" && Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
      if (handler) return ok(id, await handler(args, deps));
      if (typeof name === "string") return error(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      return error(id, INVALID_PARAMS, "tools/call requires params.name");
    }
    default:
      return error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function initialize(params: Obj): Json {
  const requested = params.protocolVersion;
  const version =
    typeof requested === "string" && (SUPPORTED_MCP_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : SUPPORTED_MCP_VERSIONS[0];
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "dj-sync", title: "DJ Sync → Rekordbox", version: WORKER_VERSION },
    instructions:
      "Use download_to_rekordbox when the user shares Spotify or YouTube links they want in " +
      "Rekordbox. It queues a download for the DJ's Mac and returns a job_id right away; the Mac " +
      "picks it up as soon as it's online and downloads take a few minutes. To work with the DJ's " +
      "Rekordbox playlists, use list_playlists, search_tracks and get_playlist (they read the " +
      "library the Mac last shared), then create_playlist, add_tracks_to_playlist, " +
      "remove_tracks_from_playlist, rename_playlist or delete_playlist with track_ids from those " +
      "results; changes are queued for the Mac like downloads. Use get_download_status with a " +
      "job_id when the user asks how something went.",
  };
}

export function toolDefinitions(maxUrls: number): Json {
  return [
    {
      name: DOWNLOAD_TOOL,
      title: "Download to Rekordbox",
      description:
        "Download Spotify (track, album, playlist) or YouTube (video, playlist) links as audio files " +
        "on the DJ's Mac and add them to a playlist in the Rekordbox import XML. Returns immediately " +
        "with a job_id; the download runs on the Mac (queued until it's online) and takes a few " +
        "minutes — call get_download_status to check on it.",
      inputSchema: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: maxUrls,
            description: "Spotify or YouTube links, e.g. https://open.spotify.com/track/… or https://youtu.be/…",
          },
          playlist_name: {
            type: "string",
            maxLength: 100,
            description: "Rekordbox playlist to add the tracks to. Omit to use the default playlist.",
          },
        },
        required: ["urls"],
        additionalProperties: false,
      },
      annotations: {
        title: "Download to Rekordbox",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: STATUS_TOOL,
      title: "Download status",
      description:
        "Check a job started by download_to_rekordbox or by a playlist tool (create, add, remove, " +
        "rename, delete). Pass its job_id, or omit it to list the most recent jobs.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "The job_id returned by download_to_rekordbox or a playlist tool.",
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "Download status", readOnlyHint: true, openWorldHint: false },
    },
    ...libraryToolDefinitions(),
  ];
}

const trackIdsSchema = (minItems: number) => ({
  type: "array",
  items: { type: "string" },
  minItems,
  maxItems: MAX_TRACK_IDS,
  description: "Rekordbox track ids (track_id) from search_tracks or get_playlist.",
});

const nameSchema = (description: string) => ({
  type: "string",
  minLength: 1,
  maxLength: MAX_PLAYLIST_NAME,
  description,
});

const readOnly = (title: string) => ({ title, readOnlyHint: true, openWorldHint: false });

const writes = (title: string, destructive = false) => ({
  title,
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: true,
  openWorldHint: false,
});

function libraryToolDefinitions(): Json[] {
  return [
    {
      name: LIST_PLAYLISTS,
      title: "List Rekordbox playlists",
      description:
        "List the playlists in the DJ's Rekordbox library (name, folder, track count), from the " +
        "library their Mac last shared. Optionally filter by part of a name or folder.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Only playlists whose name or folder contains this." } },
        additionalProperties: false,
      },
      annotations: readOnly("List Rekordbox playlists"),
    },
    {
      name: SEARCH_TRACKS,
      title: "Search Rekordbox tracks",
      description:
        "Search the DJ's Rekordbox library. Every word of `query` must appear in the title, artist, " +
        "album or genre; narrow with artist, genre, key and a BPM range. Returns track_ids to use " +
        "with the playlist tools.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match in title/artist/album/genre." },
          artist: { type: "string", description: "Artist contains this." },
          genre: { type: "string", description: "Genre contains this." },
          bpm_min: { type: "number", description: "Lowest BPM (inclusive)." },
          bpm_max: { type: "number", description: "Highest BPM (inclusive)." },
          key: { type: "string", description: "Exact key as Rekordbox shows it, e.g. Am or 8A." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: SEARCH_MAX_LIMIT,
            description: `How many tracks to return (default ${SEARCH_DEFAULT_LIMIT}).`,
          },
        },
        additionalProperties: false,
      },
      annotations: readOnly("Search Rekordbox tracks"),
    },
    {
      name: GET_PLAYLIST,
      title: "Show a Rekordbox playlist",
      description: `The tracks in one Rekordbox playlist (the first ${PLAYLIST_TRACKS_SHOWN}), with their track_ids.`,
      inputSchema: {
        type: "object",
        properties: { name: nameSchema("Playlist name, e.g. from list_playlists.") },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: readOnly("Show a Rekordbox playlist"),
    },
    {
      name: CREATE_PLAYLIST,
      title: "Create a Rekordbox playlist",
      description:
        "Create a playlist in the DJ's Rekordbox library (in the DJ Sync folder), optionally with " +
        "tracks. If it already exists, the tracks are added to it. Queued for the Mac; returns a job_id.",
      inputSchema: {
        type: "object",
        properties: { name: nameSchema("Name of the new playlist."), track_ids: trackIdsSchema(0) },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: writes("Create a Rekordbox playlist"),
    },
    {
      name: ADD_TRACKS,
      title: "Add tracks to a Rekordbox playlist",
      description: "Add tracks (by track_id) to an existing Rekordbox playlist. Queued for the Mac; returns a job_id.",
      inputSchema: {
        type: "object",
        properties: { playlist: nameSchema("Existing playlist name."), track_ids: trackIdsSchema(1) },
        required: ["playlist", "track_ids"],
        additionalProperties: false,
      },
      annotations: writes("Add tracks to a Rekordbox playlist"),
    },
    {
      name: REMOVE_TRACKS,
      title: "Remove tracks from a Rekordbox playlist",
      description:
        "Remove tracks (by track_id) from a Rekordbox playlist; they stay in the library. Queued for " +
        "the Mac; returns a job_id.",
      inputSchema: {
        type: "object",
        properties: { playlist: nameSchema("Playlist name."), track_ids: trackIdsSchema(1) },
        required: ["playlist", "track_ids"],
        additionalProperties: false,
      },
      annotations: writes("Remove tracks from a Rekordbox playlist"),
    },
    {
      name: RENAME_PLAYLIST,
      title: "Rename a Rekordbox playlist",
      description: "Rename a Rekordbox playlist. Queued for the Mac; returns a job_id.",
      inputSchema: {
        type: "object",
        properties: { name: nameSchema("Current playlist name."), new_name: nameSchema("New playlist name.") },
        required: ["name", "new_name"],
        additionalProperties: false,
      },
      annotations: writes("Rename a Rekordbox playlist"),
    },
    {
      name: DELETE_PLAYLIST,
      title: "Delete a Rekordbox playlist",
      description:
        "Delete a Rekordbox playlist (its tracks stay in the library). Rekordbox's library is backed " +
        "up first and can be restored from DJ Sync on the Mac. Queued for the Mac; returns a job_id.",
      inputSchema: {
        type: "object",
        properties: { name: nameSchema("Playlist to delete.") },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: writes("Delete a Rekordbox playlist", true),
    },
  ];
}

async function callDownload(args: Obj | undefined, deps: Deps): Promise<Json> {
  const urls = args?.urls;
  if (!Array.isArray(urls)) return toolError("`urls` must be a list of Spotify or YouTube links.");
  if (urls.length === 0) return toolError("`urls` is empty — send at least one Spotify or YouTube link.");
  if (urls.length > deps.config.maxUrls) {
    return toolError(`Too many links (${urls.length}); send at most ${deps.config.maxUrls} per call.`);
  }
  const rawPlaylist = args?.playlist_name;
  if (rawPlaylist !== undefined && rawPlaylist !== null && typeof rawPlaylist !== "string") {
    return toolError("`playlist_name` must be a string.");
  }

  const media: MediaRef[] = [];
  const rejected: { url: unknown; reason: string }[] = [];
  for (const u of urls) {
    if (typeof u !== "string") {
      rejected.push({ url: u, reason: "not a string" });
      continue;
    }
    const r = extractMediaRef(u);
    if (!r.ok) rejected.push({ url: u, reason: r.reason });
    else if (!media.some((m) => m.url === r.media.url)) media.push(r.media); // duplicate in the same call
  }
  if (media.length === 0) {
    return toolResult(
      "None of the links can be downloaded: only https Spotify track/album/playlist and YouTube " +
        "video/playlist links are supported.",
      { rejected },
      true,
    );
  }

  const sub = await submit(deps, media, rawPlaylist ?? null, "mcp");
  if (!sub.ok) return toolError(sub.error);
  const { job, position, deduplicated } = sub.value;
  const agent = await agentStatus(deps);

  let text = deduplicated
    ? `That download is already in progress as job ${job.id} (${stateWord(job.state)}).`
    : `Queued job ${job.id}: ${job.urls.length} link(s) → Rekordbox playlist "${job.playlist}"` +
      (position > 0 ? ` (${position} job(s) ahead)` : "") +
      ". Downloads take a few minutes; check with get_download_status.";
  if (rejected.length > 0) text += ` Skipped ${rejected.length} unsupported link(s).`;
  if (!agent.online) text += offlineNote(agent, deps.now());

  return toolResult(
    text,
    {
      job_id: job.id,
      state: job.state,
      playlist: job.playlist,
      urls: job.urls,
      created_at: job.created_at,
      position,
      deduplicated,
      rejected,
      mac_online: agent.online,
    },
    false,
  );
}

async function callStatus(args: Obj | undefined, deps: Deps): Promise<Json> {
  const agent = await agentStatus(deps);
  const jobId = typeof args?.job_id === "string" ? args.job_id.trim() : undefined;

  if (jobId !== undefined) {
    const job = await deps.store.getJob(jobId);
    if (!job) {
      return toolError(`No job ${jobId}. Call get_download_status without a job_id to list recent jobs.`);
    }
    const view = jobView(job);
    let text = `Job ${job.id} is ${stateWord(job.state, job.kind)}.`;
    if (job.summary) text += ` ${job.summary}.`;
    text += ` ${job.message}`;
    if (view.library_version) text += ` Rekordbox library version ${view.library_version}.`;
    for (const e of view.errors) text += `\n- ${e.url}: ${errorSummary(e.error)}`;
    if (job.state === "queued" && !agent.online) text += offlineNote(agent, deps.now(), job.kind);
    return toolResult(text, { ...view, mac_online: agent.online }, false);
  }

  const jobs = await deps.store.recentJobs(RECENT_JOBS);
  let text =
    jobs.length === 0
      ? `No jobs yet. New downloads go to the "${deps.config.defaultPlaylist}" playlist unless you name one.`
      : jobs.map((j) => `${j.id} — ${stateWord(j.state, j.kind)} — ${jobLabel(j)} — ${j.message}`).join("\n");
  if (jobs.some((j) => j.state === "queued") && !agent.online) text += `\n${offlineNote(agent, deps.now()).trim()}`;
  return toolResult(text, { jobs: jobs.map(jobView), mac_online: agent.online }, false);
}

function jobLabel(j: JobRow): string {
  return j.summary ?? `"${j.playlist}"`;
}

// ---------- Rekordbox library tools ----------
// Reads answer from the snapshot the Mac last uploaded; writes are checked
// against it and queued as library jobs the Mac applies to master.db.

type Handler = (args: Obj | undefined, deps: Deps) => Promise<Json>;

const TOOLS: Record<string, Handler> = {
  [DOWNLOAD_TOOL]: callDownload,
  [STATUS_TOOL]: callStatus,
  [LIST_PLAYLISTS]: callListPlaylists,
  [SEARCH_TRACKS]: callSearchTracks,
  [GET_PLAYLIST]: callGetPlaylist,
  [CREATE_PLAYLIST]: callCreatePlaylist,
  [ADD_TRACKS]: (args, deps) => editTracks(args, deps, "add"),
  [REMOVE_TRACKS]: (args, deps) => editTracks(args, deps, "remove"),
  [RENAME_PLAYLIST]: callRenamePlaylist,
  [DELETE_PLAYLIST]: callDeletePlaylist,
};

const APPLY_NOTE =
  " Your Mac applies it to Rekordbox — straight away if Rekordbox is closed, otherwise when you quit it." +
  " It also shows under rekordbox xml right away.";

interface Freshness {
  agent: AgentStatus;
  /** When the Mac generated the snapshot being answered from. */
  asOf: string | null;
  /** " (Rekordbox library as of 5 min ago; your Mac is online.)" */
  note: string;
}

async function freshness(deps: Deps): Promise<Freshness> {
  const [agent, row] = await Promise.all([agentStatus(deps), deps.store.getAgent()]);
  const asOf = row?.library_generated_at ?? null;
  const when = asOf ? relativeTime(asOf, deps.now()) : "an unknown time";
  const note = ` (Rekordbox library as of ${when}; your Mac is ${agent.online ? "online" : "offline"}.)`;
  return { agent, asOf, note };
}

const freshnessFields = (f: Freshness) => ({ library_as_of: f.asOf, mac_online: f.agent.online });

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A playlist name argument, cleaned like playlist_name (control chars → space, whitespace collapsed). */
function nameArg(v: unknown, field: string): { value: string } | { error: Json } {
  if (typeof v !== "string") return { error: toolError(`\`${field}\` must be a playlist name.`) };
  const cleaned = normalizePlaylistName(v, "");
  if (!cleaned.ok) return { error: toolError(cleaned.error.replace("playlist_name", `\`${field}\``)) };
  if (cleaned.value === "") return { error: toolError(`\`${field}\` is empty.`) };
  return { value: cleaned.value };
}

function noSuchPlaylist(playlists: LibPlaylist[], name: string, hint = ""): Json {
  const close = suggestPlaylists(playlists, name);
  const didYouMean = close.length > 0 ? ` Did you mean ${close.map((n) => `"${n}"`).join(", ")}?` : "";
  return toolResult(
    `There's no Rekordbox playlist called "${cleanName(name)}".${didYouMean}${hint}`,
    { suggestions: close },
    true,
  );
}

function unknownTracksError(ids: string[]): Json {
  return toolResult(
    `Unknown track_ids: ${ids.join(", ")}. Use track_ids from search_tracks or get_playlist.`,
    { unknown_track_ids: ids },
    true,
  );
}

const trackLine = (t: ReturnType<typeof trackView>) =>
  `${t.artist ? `${t.artist} — ` : ""}${t.title}` +
  [t.bpm !== null ? `${Math.round(t.bpm * 10) / 10} BPM` : null, t.key, t.genre]
    .filter((x): x is string => x !== null && x !== "")
    .map((x) => ` · ${x}`)
    .join("") +
  ` [track_id ${t.track_id}]`;

async function callListPlaylists(args: Obj | undefined, deps: Deps): Promise<Json> {
  const playlists = await deps.store.getLibraryPlaylists();
  if (!playlists) return toolError(NO_LIBRARY);
  const q = (str(args?.query) ?? "").trim().toLocaleLowerCase();
  const rows = sortPlaylists(playlists)
    .filter((p) => q === "" || p.name.toLocaleLowerCase().includes(q) || p.folder.toLocaleLowerCase().includes(q))
    .map((p) => ({ name: p.name, folder: p.folder, tracks: p.track_ids.length }));
  const f = await freshness(deps);

  const shown = rows.slice(0, 100);
  let text =
    rows.length === 0
      ? q === ""
        ? "The Rekordbox library has no playlists."
        : `No playlists match "${q}".`
      : `${plural(rows.length, "playlist")}:\n` +
        shown.map((r) => `- ${r.folder ? `${r.folder}/` : ""}${r.name} (${plural(r.tracks, "track")})`).join("\n");
  if (rows.length > shown.length) text += `\n…and ${rows.length - shown.length} more; narrow it down with query.`;
  text += f.note;
  return toolResult(text, { playlists: rows, total: rows.length, ...freshnessFields(f) }, false);
}

async function callSearchTracks(args: Obj | undefined, deps: Deps): Promise<Json> {
  for (const field of ["query", "artist", "genre", "key"]) {
    const v = args?.[field];
    if (v !== undefined && v !== null && typeof v !== "string") return toolError(`\`${field}\` must be a string.`);
  }
  const bpm: Record<"bpm_min" | "bpm_max", number | undefined> = { bpm_min: undefined, bpm_max: undefined };
  for (const field of ["bpm_min", "bpm_max"] as const) {
    const v = args?.[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return toolError(`\`${field}\` must be a number.`);
    bpm[field] = v;
  }
  let limit = SEARCH_DEFAULT_LIMIT;
  const rawLimit = args?.limit;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > SEARCH_MAX_LIMIT) {
      return toolError(`\`limit\` must be a whole number from 1 to ${SEARCH_MAX_LIMIT}.`);
    }
    limit = rawLimit;
  }

  const tracks = await deps.store.getLibraryTracks();
  if (!tracks) return toolError(NO_LIBRARY);
  const hits = searchTracks(tracks, {
    query: str(args?.query),
    artist: str(args?.artist),
    genre: str(args?.genre),
    key: str(args?.key),
    bpmMin: bpm.bpm_min,
    bpmMax: bpm.bpm_max,
  });
  const shown = hits.slice(0, limit).map(trackView);
  const f = await freshness(deps);
  let text =
    hits.length === 0
      ? "No tracks match."
      : `${plural(hits.length, "track")} match` +
        (hits.length > shown.length ? ` (showing ${shown.length})` : "") +
        `:\n${shown.map((t) => `- ${trackLine(t)}`).join("\n")}`;
  text += f.note;
  return toolResult(text, { tracks: shown, total_matches: hits.length, ...freshnessFields(f) }, false);
}

async function callGetPlaylist(args: Obj | undefined, deps: Deps): Promise<Json> {
  const name = nameArg(args?.name, "name");
  if ("error" in name) return name.error;
  const [playlists, tracks] = await Promise.all([deps.store.getLibraryPlaylists(), deps.store.getLibraryTracks()]);
  if (!playlists || !tracks) return toolError(NO_LIBRARY);
  const playlist = findPlaylist(playlists, name.value);
  if (!playlist) return noSuchPlaylist(playlists, name.value);

  const byId = new Map(tracks.map((t) => [t.id, t]));
  const rows = playlist.track_ids
    .slice(0, PLAYLIST_TRACKS_SHOWN)
    .map((id) => byId.get(id))
    .filter((t): t is LibTrack => t !== undefined)
    .map(trackView);
  const total = playlist.track_ids.length;
  const f = await freshness(deps);
  let text =
    `"${playlist.name}"${playlist.folder ? ` (in ${playlist.folder})` : ""} has ${plural(total, "track")}` +
    (total > PLAYLIST_TRACKS_SHOWN ? ` (showing the first ${PLAYLIST_TRACKS_SHOWN})` : "") +
    (rows.length > 0 ? `:\n${rows.map((t, i) => `${i + 1}. ${trackLine(t)}`).join("\n")}` : ".");
  text += f.note;
  return toolResult(
    text,
    { name: playlist.name, folder: playlist.folder, tracks: rows, total, ...freshnessFields(f) },
    false,
  );
}

/** Queue playlist ops for the Mac and say what happens next. */
async function queueLibrary(
  deps: Deps,
  playlist: string,
  ops: LibraryOp[],
  summary: string,
  extra: { before?: string; after?: string } = {},
): Promise<Json> {
  const sub = await submitLibrary(deps, playlist, ops, summary);
  if (!sub.ok) return toolError(sub.error);
  const { job, position, deduplicated } = sub.value;
  const agent = await agentStatus(deps);
  let text =
    (extra.before ?? "") +
    (deduplicated
      ? `That change is already queued as job ${job.id} (${stateWord(job.state, job.kind)}).`
      : `Queued job ${job.id}: ${summary}` + (position > 0 ? ` (${position} job(s) ahead)` : "") + ".") +
    APPLY_NOTE +
    (extra.after ?? "");
  if (!agent.online) text += offlineNote(agent, deps.now(), "library");
  return toolResult(
    text,
    {
      job_id: job.id,
      kind: job.kind,
      state: job.state,
      playlist: job.playlist,
      summary: job.summary,
      created_at: job.created_at,
      position,
      deduplicated,
      mac_online: agent.online,
    },
    false,
  );
}

async function callCreatePlaylist(args: Obj | undefined, deps: Deps): Promise<Json> {
  const name = nameArg(args?.name, "name");
  if ("error" in name) return name.error;
  const ids = parseTrackIds(args?.track_ids, 0);
  if (!ids.ok) return toolError(ids.error);
  const [playlists, tracks] = await Promise.all([deps.store.getLibraryPlaylists(), deps.store.getLibraryTracks()]);
  if (!playlists || !tracks) return toolError(NO_LIBRARY);
  const unknown = unknownTrackIds(ids.value, tracks);
  if (unknown.length > 0) return unknownTracksError(unknown);

  // An existing playlist keeps its exact name, case included.
  const existing = findPlaylist(playlists, name.value);
  const target = existing?.name ?? name.value;
  const ops: LibraryOp[] = [
    { op: "ensure_playlist", name: target },
    ...ids.value.map((id): LibraryOp => ({ op: "add_to_playlist", playlist: target, content_id: id })),
  ];
  const n = ids.value.length;
  const summary = !existing
    ? `Create playlist "${target}"` + (n > 0 ? ` with ${plural(n, "track")}` : "")
    : n > 0
      ? `Add ${plural(n, "track")} to "${target}"`
      : `Make sure playlist "${target}" exists`;
  return queueLibrary(deps, target, ops, summary, {
    before: existing ? `Playlist "${target}" already exists; adding to it. ` : "",
  });
}

async function editTracks(args: Obj | undefined, deps: Deps, mode: "add" | "remove"): Promise<Json> {
  const name = nameArg(args?.playlist, "playlist");
  if ("error" in name) return name.error;
  const ids = parseTrackIds(args?.track_ids, 1);
  if (!ids.ok) return toolError(ids.error);
  const [playlists, tracks] = await Promise.all([deps.store.getLibraryPlaylists(), deps.store.getLibraryTracks()]);
  if (!playlists || !tracks) return toolError(NO_LIBRARY);
  const playlist = findPlaylist(playlists, name.value);
  if (!playlist) {
    return noSuchPlaylist(playlists, name.value, mode === "add" ? " To make a new one, use create_playlist." : "");
  }
  const unknown = unknownTrackIds(ids.value, tracks);
  if (unknown.length > 0) return unknownTracksError(unknown);

  const ops: LibraryOp[] = ids.value.map(
    (id): LibraryOp =>
      mode === "add"
        ? { op: "add_to_playlist", playlist: playlist.name, content_id: id }
        : { op: "remove_from_playlist", playlist: playlist.name, content_id: id },
  );
  const n = plural(ids.value.length, "track");
  const summary = mode === "add" ? `Add ${n} to "${playlist.name}"` : `Remove ${n} from "${playlist.name}"`;
  return queueLibrary(deps, playlist.name, ops, summary);
}

async function callRenamePlaylist(args: Obj | undefined, deps: Deps): Promise<Json> {
  const name = nameArg(args?.name, "name");
  if ("error" in name) return name.error;
  const newName = nameArg(args?.new_name, "new_name");
  if ("error" in newName) return newName.error;
  const playlists = await deps.store.getLibraryPlaylists();
  if (!playlists) return toolError(NO_LIBRARY);
  const playlist = findPlaylist(playlists, name.value);
  if (!playlist) return noSuchPlaylist(playlists, name.value);
  if (playlist.name === newName.value) return toolError(`The playlist is already called "${newName.value}".`);
  return queueLibrary(
    deps,
    playlist.name,
    [{ op: "rename_playlist", name: playlist.name, new_name: newName.value }],
    `Rename "${playlist.name}" to "${newName.value}"`,
  );
}

async function callDeletePlaylist(args: Obj | undefined, deps: Deps): Promise<Json> {
  const name = nameArg(args?.name, "name");
  if ("error" in name) return name.error;
  const playlists = await deps.store.getLibraryPlaylists();
  if (!playlists) return toolError(NO_LIBRARY);
  const playlist = findPlaylist(playlists, name.value);
  if (!playlist) return noSuchPlaylist(playlists, name.value);
  return queueLibrary(
    deps,
    playlist.name,
    [{ op: "delete_playlist", name: playlist.name }],
    `Delete playlist "${playlist.name}"`,
    {
      after:
        " Its tracks stay in the library, and the library is backed up before every change, so it can be " +
        "restored from DJ Sync on the Mac.",
    },
  );
}

function toolResult(text: string, structured: Json, isError: boolean): Json {
  return { content: [{ type: "text", text }], structuredContent: structured, isError };
}

function toolError(text: string): Json {
  return { content: [{ type: "text", text }], isError: true };
}

function ok(id: unknown, result: Json): Json {
  return { jsonrpc: "2.0", id, result };
}

function error(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
