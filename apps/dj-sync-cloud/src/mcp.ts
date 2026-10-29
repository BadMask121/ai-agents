// Stateless MCP (JSON-RPC 2.0) dispatch — port of apps/dj-sync/src/mcp.rs.
// Transport concerns (status codes, headers) live in router.ts; this maps one
// message to at most one response (`null` = notification → 202).

import {
  MAX_PLAYLIST_NAME,
  MAX_TRACK_IDS,
  PLAYLISTS_LISTED,
  PLAYLIST_PAGE_MAX,
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
  parseTrackIds,
  playlistPath,
  plural,
  resolvePlaylist,
  searchTracks,
  sortPlaylists,
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
const MOVE_TRACKS = "move_tracks";

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
      "job_id when the user asks how something went. Playlist names can be loose (\"gqom\", no emoji, " +
      "\"Folder/Name\"): the tools match them to the DJ's playlists, and when they can't tell which " +
      "one is meant they return the closest playlists instead of acting — then ask the user to pick " +
      "and call again with that exact name. To put downloads in a brand-new playlist, set " +
      "create_playlist: true. get_playlist pages through long playlists with offset. To move tracks " +
      "from one playlist to another use move_tracks (add_tracks_to_playlist copies them instead).",
  };
}

const PLAYLIST_ID_SCHEMA = {
  type: "string",
  maxLength: 32,
  description:
    "Only when a previous answer listed several playlists with the same name: the playlist_id of the one " +
    "the user picked.",
};

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
            description:
              "Existing Rekordbox playlist to add the tracks to, as the user said it (case, emoji and " +
              "punctuation don't matter; \"Folder/Name\" picks one of two same-named playlists). If it " +
              "doesn't clearly match one playlist, nothing is queued and the closest playlists come back " +
              "to ask the user about. Omit to use the default playlist.",
          },
          playlist_id: PLAYLIST_ID_SCHEMA,
          create_playlist: {
            type: "boolean",
            description:
              "Set true only when the user wants a NEW playlist called playlist_name (it's created in " +
              "the DJ Sync folder).",
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
        "album or genre; narrow with artist, genre, key and a BPM range. Each track lists the " +
        "playlists it's in, so this also answers \"which playlist has <song>\". Returns track_ids to " +
        "use with the playlist tools.",
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
      description:
        `Every track in one Rekordbox playlist, ${PLAYLIST_TRACKS_SHOWN} per page (use offset for the ` +
        "next page), with their track_ids. The name can be loose; unclear names return suggestions.",
      inputSchema: {
        type: "object",
        properties: {
          name: nameSchema("Playlist name, e.g. from list_playlists (or \"Folder/Name\")."),
          playlist_id: PLAYLIST_ID_SCHEMA,
          offset: { type: "integer", minimum: 0, description: "Skip this many tracks (for the next page)." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: PLAYLIST_PAGE_MAX,
            description: `Tracks per page (default ${PLAYLIST_TRACKS_SHOWN}).`,
          },
        },
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
      description:
        "Add (copy) tracks, by track_id, to an existing Rekordbox playlist; they stay in any other playlists. " +
        "To move them out of a playlist instead, use move_tracks. Queued for the Mac; returns a job_id.",
      inputSchema: {
        type: "object",
        properties: { playlist: nameSchema("Existing playlist name."), track_ids: trackIdsSchema(1), playlist_id: PLAYLIST_ID_SCHEMA },
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
        properties: { playlist: nameSchema("Playlist name."), track_ids: trackIdsSchema(1), playlist_id: PLAYLIST_ID_SCHEMA },
        required: ["playlist", "track_ids"],
        additionalProperties: false,
      },
      annotations: writes("Remove tracks from a Rekordbox playlist"),
    },
    {
      name: MOVE_TRACKS,
      title: "Move tracks between Rekordbox playlists",
      description:
        "Move tracks from one Rekordbox playlist to another in a single change: they're added to " +
        "to_playlist and removed from from_playlist (they stay in the library). Give track_ids " +
        "(from get_playlist on from_playlist) or all: true for every track. To copy instead, use " +
        "add_tracks_to_playlist. Queued for the Mac; returns a job_id.",
      inputSchema: {
        type: "object",
        properties: {
          from_playlist: nameSchema("Playlist the tracks are in now."),
          from_playlist_id: PLAYLIST_ID_SCHEMA,
          to_playlist: nameSchema("Playlist to move them to."),
          to_playlist_id: PLAYLIST_ID_SCHEMA,
          track_ids: trackIdsSchema(1),
          all: { type: "boolean", description: "Move every track in from_playlist (instead of track_ids)." },
          create_playlist: {
            type: "boolean",
            description: "Make to_playlist (in the DJ Sync folder) if it doesn't exist yet.",
          },
        },
        required: ["from_playlist", "to_playlist"],
        additionalProperties: false,
      },
      annotations: writes("Move tracks between Rekordbox playlists"),
    },
    {
      name: RENAME_PLAYLIST,
      title: "Rename a Rekordbox playlist",
      description: "Rename a Rekordbox playlist. Queued for the Mac; returns a job_id.",
      inputSchema: {
        type: "object",
        properties: {
          name: nameSchema("Current playlist name."),
          new_name: nameSchema("New playlist name."),
          playlist_id: PLAYLIST_ID_SCHEMA,
        },
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
        properties: { name: nameSchema("Playlist to delete."), playlist_id: PLAYLIST_ID_SCHEMA },
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

  // Into an existing playlist unless the user asked for a new one; when the
  // name is unclear, ask (with the closest playlists) instead of guessing.
  let playlistName: string | null = (rawPlaylist as string | undefined) ?? null;
  let playlistId: string | null = null;
  const wantsNew = args?.create_playlist === true;
  if (playlistName !== null && cleanName(playlistName) !== "") {
    const playlists = await deps.store.getLibraryPlaylists();
    const pinned = typeof args?.playlist_id === "string" ? playlists?.find((p) => p.id === args.playlist_id) : undefined;
    if (pinned) {
      playlistName = pinned.name;
      playlistId = pinned.id;
    } else if (playlists) {
      const m = resolvePlaylist(playlists, playlistName);
      if (m.kind === "one") {
        playlistName = m.playlist.name;
        playlistId = m.playlist.id;
      } else if (m.kind === "many") {
        return ambiguousPlaylist(m.options, playlistName);
      } else if (!wantsNew) {
        return noSuchPlaylist(
          m.suggestions,
          playlistName,
          " Or, if they want a new playlist with this name, call again with create_playlist: true.",
        );
      }
    }
  }

  const sub = await submit(deps, media, playlistName, "mcp", playlistId);
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
      playlist_id: job.playlist_id ?? null,
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
  [MOVE_TRACKS]: callMoveTracks,
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

/** One playlist, or the question to ask the user (as the tool's answer). */
function pickPlaylist(
  playlists: LibPlaylist[],
  name: string,
  hint = "",
  id?: unknown,
): { playlist: LibPlaylist } | { ask: Json } {
  if (typeof id === "string" && id !== "") {
    const pinned = playlists.find((p) => p.id === id);
    if (pinned) return { playlist: pinned };
    return { ask: toolError(`No playlist has playlist_id ${id}; use one from list_playlists or a previous answer.`) };
  }
  const m = resolvePlaylist(playlists, name);
  if (m.kind === "one") return { playlist: m.playlist };
  if (m.kind === "many") return { ask: ambiguousPlaylist(m.options, name) };
  return { ask: noSuchPlaylist(m.suggestions, name, hint) };
}

const describe = (p: LibPlaylist) =>
  `"${playlistPath(p)}" (${plural(p.track_ids.length, "track")}, playlist_id ${p.id})`;

const suggestionView = (p: LibPlaylist) => ({
  playlist_id: p.id,
  name: p.name,
  folder: p.folder,
  path: playlistPath(p),
  tracks: p.track_ids.length,
});

function noSuchPlaylist(suggestions: LibPlaylist[], name: string, hint = ""): Json {
  const close =
    suggestions.length > 0
      ? ` The closest playlists are ${suggestions.map(describe).join(", ")}. Ask the user which one they ` +
        "mean (or whether they want a new playlist), then call again with that exact name."
      : " Use list_playlists to see the DJ's playlists.";
  return toolResult(
    `Nothing was changed: there's no Rekordbox playlist called "${cleanName(name)}".${close}${hint}`,
    { error: "playlist_not_found", suggestions: suggestions.map(suggestionView) },
    true,
  );
}

function ambiguousPlaylist(options: LibPlaylist[], name: string): Json {
  return toolResult(
    `Nothing was changed: ${options.length} playlists are called "${cleanName(name)}": ` +
      `${options.map(describe).join(", ")}. Ask the user which one (get_playlist with a playlist_id shows ` +
      `its tracks), then call again with that playlist_id.`,
    { error: "playlist_ambiguous", suggestions: options.map(suggestionView) },
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

/** Playlists named in a search result line; the rest are counted. */
const TRACK_PLAYLISTS_SHOWN = 5;

/** track_id → the "Folder/Name" of every playlist it's in. */
function playlistsByTrack(playlists: LibPlaylist[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of sortPlaylists(playlists)) {
    for (const id of new Set(p.track_ids)) out.set(id, [...(out.get(id) ?? []), playlistPath(p)]);
  }
  return out;
}

async function callListPlaylists(args: Obj | undefined, deps: Deps): Promise<Json> {
  const playlists = await deps.store.getLibraryPlaylists();
  if (!playlists) return toolError(NO_LIBRARY);
  const q = (str(args?.query) ?? "").trim().toLocaleLowerCase();
  const rows = sortPlaylists(playlists)
    .filter((p) => q === "" || p.name.toLocaleLowerCase().includes(q) || p.folder.toLocaleLowerCase().includes(q))
    .map((p) => ({ name: p.name, folder: p.folder, tracks: p.track_ids.length }));
  const f = await freshness(deps);

  const shown = rows.slice(0, PLAYLISTS_LISTED);
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

  const [tracks, playlists] = await Promise.all([deps.store.getLibraryTracks(), deps.store.getLibraryPlaylists()]);
  if (!tracks) return toolError(NO_LIBRARY);
  const hits = searchTracks(tracks, {
    query: str(args?.query),
    artist: str(args?.artist),
    genre: str(args?.genre),
    key: str(args?.key),
    bpmMin: bpm.bpm_min,
    bpmMax: bpm.bpm_max,
  });
  const inPlaylists = playlistsByTrack(playlists ?? []);
  const shown = hits.slice(0, limit).map((t) => ({ ...trackView(t), playlists: inPlaylists.get(t.id) ?? [] }));
  const f = await freshness(deps);
  const where = (names: string[]) =>
    names.length === 0
      ? " · in no playlist"
      : ` · in ${names.slice(0, TRACK_PLAYLISTS_SHOWN).join(", ")}` +
        (names.length > TRACK_PLAYLISTS_SHOWN ? ` (+${names.length - TRACK_PLAYLISTS_SHOWN} more)` : "");
  let text =
    hits.length === 0
      ? "No tracks match."
      : `${plural(hits.length, "track")} match` +
        (hits.length > shown.length ? ` (showing ${shown.length})` : "") +
        `:\n${shown.map((t) => `- ${trackLine(t)}${where(t.playlists)}`).join("\n")}`;
  text += f.note;
  return toolResult(text, { tracks: shown, total_matches: hits.length, ...freshnessFields(f) }, false);
}

async function callGetPlaylist(args: Obj | undefined, deps: Deps): Promise<Json> {
  const name = nameArg(args?.name, "name");
  if ("error" in name) return name.error;
  const page = pageArgs(args);
  if ("error" in page) return page.error;
  const [playlists, tracks] = await Promise.all([deps.store.getLibraryPlaylists(), deps.store.getLibraryTracks()]);
  if (!playlists || !tracks) return toolError(NO_LIBRARY);
  const picked = pickPlaylist(playlists, name.value, "", args?.playlist_id);
  if ("ask" in picked) return picked.ask;
  const playlist = picked.playlist;

  const byId = new Map(tracks.map((t) => [t.id, t]));
  const total = playlist.track_ids.length;
  const ids = playlist.track_ids.slice(page.offset, page.offset + page.limit);
  const rows = ids
    .map((id, i) => ({ n: page.offset + i + 1, t: byId.get(id) }))
    .filter((r): r is { n: number; t: LibTrack } => r.t !== undefined);
  const end = page.offset + ids.length;
  const next = end < total ? end : null;
  const f = await freshness(deps);
  let text = `"${playlist.name}"${playlist.folder ? ` (in ${playlist.folder})` : ""} has ${plural(total, "track")}`;
  if (total > 0 && (page.offset > 0 || next !== null)) {
    text += ` (showing ${ids.length === 0 ? "none" : `${page.offset + 1}–${end}`}` +
      (next !== null ? `; call get_playlist again with offset ${next} for the rest` : "") + ")";
  }
  text += rows.length > 0 ? `:\n${rows.map((r) => `${r.n}. ${trackLine(trackView(r.t))}`).join("\n")}` : ".";
  text += f.note;
  return toolResult(
    text,
    {
      name: playlist.name,
      folder: playlist.folder,
      playlist_id: playlist.id,
      tracks: rows.map((r) => trackView(r.t)),
      total,
      offset: page.offset,
      next_offset: next,
      ...freshnessFields(f),
    },
    false,
  );
}

function pageArgs(args: Obj | undefined): { offset: number; limit: number } | { error: Json } {
  const whole = (v: unknown, field: string, min: number, max: number, dflt: number) => {
    if (v === undefined || v === null) return dflt;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw toolError(`\`${field}\` must be a whole number from ${min} to ${max}.`);
    }
    return v;
  };
  try {
    return {
      offset: whole(args?.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0),
      limit: whole(args?.limit, "limit", 1, PLAYLIST_PAGE_MAX, PLAYLIST_TRACKS_SHOWN),
    };
  } catch (e) {
    return { error: e as Json };
  }
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

  // An existing playlist (however it was typed) keeps its exact name and id.
  const m = resolvePlaylist(playlists, name.value);
  if (m.kind === "many") return ambiguousPlaylist(m.options, name.value);
  const existing = m.kind === "one" ? m.playlist : undefined;
  const target = existing?.name ?? name.value;
  const pin = existing ? { playlist_id: existing.id } : {};
  const ops: LibraryOp[] = [
    { op: "ensure_playlist", name: target, ...pin },
    ...ids.value.map((id): LibraryOp => ({ op: "add_to_playlist", playlist: target, content_id: id, ...pin })),
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
  const picked = pickPlaylist(
    playlists,
    name.value,
    mode === "add" ? " To make a new one, use create_playlist." : "",
    args?.playlist_id,
  );
  if ("ask" in picked) return picked.ask;
  const playlist = picked.playlist;
  const unknown = unknownTrackIds(ids.value, tracks);
  if (unknown.length > 0) return unknownTracksError(unknown);

  const ops: LibraryOp[] = ids.value.map(
    (id): LibraryOp =>
      mode === "add"
        ? { op: "add_to_playlist", playlist: playlist.name, content_id: id, playlist_id: playlist.id }
        : { op: "remove_from_playlist", playlist: playlist.name, content_id: id, playlist_id: playlist.id },
  );
  const n = plural(ids.value.length, "track");
  const summary = mode === "add" ? `Add ${n} to "${playlist.name}"` : `Remove ${n} from "${playlist.name}"`;
  return queueLibrary(deps, playlist.name, ops, summary);
}

/**
 * One library job (so one rbdb transaction): add to the target in source
 * order, then remove from the source. Copying is add_tracks_to_playlist.
 */
async function callMoveTracks(args: Obj | undefined, deps: Deps): Promise<Json> {
  const from = nameArg(args?.from_playlist, "from_playlist");
  if ("error" in from) return from.error;
  const to = nameArg(args?.to_playlist, "to_playlist");
  if ("error" in to) return to.error;
  for (const flag of ["all", "create_playlist"]) {
    const v = args?.[flag];
    if (v !== undefined && v !== null && typeof v !== "boolean") return toolError(`\`${flag}\` must be true or false.`);
  }
  const all = args?.all === true;
  const hasIds = args?.track_ids !== undefined && args?.track_ids !== null;
  if (all && hasIds) return toolError("Give either track_ids or all: true, not both.");
  if (!all && !hasIds) {
    return toolError("Say which tracks to move: track_ids (from get_playlist on from_playlist), or all: true for every track.");
  }
  const ids = all ? null : parseTrackIds(args?.track_ids, 1);
  if (ids && !ids.ok) return toolError(ids.error);

  const playlists = await deps.store.getLibraryPlaylists();
  if (!playlists) return toolError(NO_LIBRARY);
  const src = pickPlaylist(playlists, from.value, "", args?.from_playlist_id);
  if ("ask" in src) return src.ask;
  const source = src.playlist;

  let target: LibPlaylist | null = null;
  if (typeof args?.to_playlist_id === "string" && args.to_playlist_id !== "") {
    const picked = pickPlaylist(playlists, to.value, "", args.to_playlist_id);
    if ("ask" in picked) return picked.ask;
    target = picked.playlist;
  } else {
    const m = resolvePlaylist(playlists, to.value);
    if (m.kind === "one") target = m.playlist;
    else if (m.kind === "many") return ambiguousPlaylist(m.options, to.value);
    else if (args?.create_playlist !== true) {
      return noSuchPlaylist(m.suggestions, to.value, " To move them into a new playlist, call again with create_playlist: true.");
    }
  }
  if (target?.id === source.id) {
    return toolError(`"${source.name}" is both the source and the target; pick a different to_playlist.`);
  }

  // Source order, each track once.
  const inSource = [...new Set(source.track_ids)];
  let moving: string[];
  if (ids) {
    const present = new Set(inSource);
    const absent = ids.value.filter((id) => !present.has(id));
    if (absent.length > 0) {
      return toolResult(
        `Nothing was changed: ${plural(absent.length, "track")} (${absent.slice(0, 10).join(", ")}) ` +
          `${absent.length === 1 ? "isn't" : "aren't"} in "${source.name}". Use track_ids from get_playlist on "${source.name}".`,
        { error: "tracks_not_in_playlist", track_ids_not_in_playlist: absent.slice(0, 10) },
        true,
      );
    }
    const wanted = new Set(ids.value);
    moving = inSource.filter((id) => wanted.has(id));
  } else {
    moving = inSource;
  }
  if (moving.length === 0) return toolError(`"${source.name}" has no tracks to move.`);

  const toName = target?.name ?? to.value;
  const pinTo = target ? { playlist_id: target.id } : {};
  const ops: LibraryOp[] = [
    ...(target ? [] : [{ op: "ensure_playlist", name: toName } as LibraryOp]),
    ...moving.map((id): LibraryOp => ({ op: "add_to_playlist", playlist: toName, content_id: id, ...pinTo })),
    ...moving.map(
      (id): LibraryOp => ({ op: "remove_from_playlist", playlist: source.name, content_id: id, playlist_id: source.id }),
    ),
  ];
  const summary = `Move ${plural(moving.length, "track")} from "${source.name}" to "${toName}"`;
  return queueLibrary(deps, toName, ops, summary, {
    before: target ? "" : `"${toName}" will be created in the DJ Sync folder. `,
  });
}

async function callRenamePlaylist(args: Obj | undefined, deps: Deps): Promise<Json> {
  const name = nameArg(args?.name, "name");
  if ("error" in name) return name.error;
  const newName = nameArg(args?.new_name, "new_name");
  if ("error" in newName) return newName.error;
  const playlists = await deps.store.getLibraryPlaylists();
  if (!playlists) return toolError(NO_LIBRARY);
  const picked = pickPlaylist(playlists, name.value, "", args?.playlist_id);
  if ("ask" in picked) return picked.ask;
  const playlist = picked.playlist;
  if (playlist.name === newName.value) return toolError(`The playlist is already called "${newName.value}".`);
  return queueLibrary(
    deps,
    playlist.name,
    [{ op: "rename_playlist", name: playlist.name, new_name: newName.value, playlist_id: playlist.id }],
    `Rename "${playlist.name}" to "${newName.value}"`,
  );
}

async function callDeletePlaylist(args: Obj | undefined, deps: Deps): Promise<Json> {
  const name = nameArg(args?.name, "name");
  if ("error" in name) return name.error;
  const playlists = await deps.store.getLibraryPlaylists();
  if (!playlists) return toolError(NO_LIBRARY);
  const picked = pickPlaylist(playlists, name.value, "", args?.playlist_id);
  if ("ask" in picked) return picked.ask;
  const playlist = picked.playlist;
  return queueLibrary(
    deps,
    playlist.name,
    [{ op: "delete_playlist", name: playlist.name, playlist_id: playlist.id }],
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
