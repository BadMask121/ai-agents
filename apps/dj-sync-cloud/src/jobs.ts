// Job submission and status, shared by the MCP tools and the Shortcut REST
// routes. Mirrors apps/dj-sync/src/jobs.rs (playlist rules, dedupe, wording).

import { AGENT_ONLINE_SECONDS, MAX_PLAYLIST_NAME } from "./constants";
import type { MediaRef } from "./links";
import { DJ_APPS } from "./store";
import type { AppChoice, DjApp, JobKind, JobRow, JobSource, JobState, LibraryOp, Store } from "./store";
import { newJobId, relativeTime } from "./util";

export interface Config {
  defaultPlaylist: string;
  maxUrls: number;
  publicHost: string;
}

export interface Deps {
  store: Store;
  now: () => Date;
  config: Config;
  /**
   * Checked before a new job is stored (not for a deduplicated retry).
   * Returns why it's refused, or null. Per-DJ limits (spec §3.7); v1 has none.
   */
  admit?: () => Promise<string | null>;
  /** The songs in a Spotify playlist/album or YouTube playlist link (link-tracks.ts), or null; optional. */
  linkTracks?: (url: string) => Promise<import("./link-tracks").LinkTrackList | null>;
  /** The name of a Spotify / YouTube playlist or album link (oEmbed), or null; optional. */
  mediaTitle?: (url: string) => Promise<string | null>;
  /** Hears how each track search went (the owner's /metrics); optional. */
  onSearch?: (match: "exact" | "close" | "none") => void;
  /** The app this request named. Unset: the Mac's default. */
  app?: AppChoice;
}

export interface AgentStatus {
  online: boolean;
  last_seen: string | null;
  version: string | null;
}

export interface Submitted {
  job: JobRow;
  position: number;
  deduplicated: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Control chars → space, whitespace runs collapsed; empty → default; ≤100 chars. */
export function normalizePlaylistName(name: string | null | undefined, fallback: string): Result<string> {
  const cleaned = (name ?? "")
    .replace(/\p{Cc}/gu, " ")
    .split(/\s+/u)
    .filter((w) => w !== "")
    .join(" ");
  const value = cleaned === "" ? fallback : cleaned;
  if ([...value].length > MAX_PLAYLIST_NAME) {
    return { ok: false, error: `playlist_name must be at most ${MAX_PLAYLIST_NAME} characters` };
  }
  return { ok: true, value };
}

export async function submit(
  deps: Deps,
  media: MediaRef[],
  playlistName: string | null | undefined,
  source: JobSource,
  /** The existing playlist `playlistName` was resolved to. */
  playlistId: string | null = null,
): Promise<Result<Submitted>> {
  if (media.length === 0) return { ok: false, error: "no links to download" };
  const playlist = normalizePlaylistName(playlistName, deps.config.defaultPlaylist);
  if (!playlist.ok) return playlist;
  const urls = media.map((m) => m.url);
  const dedupeKey = JSON.stringify(deps.app ? [playlist.value, urls, deps.app] : [playlist.value, urls]);

  // ChatGPT may retry a tool call; don't queue the same work twice.
  const existing = await deps.store.findActiveByDedupe(dedupeKey);
  if (existing) {
    const position = await deps.store.countActiveBefore(existing.created_at, existing.id);
    return { ok: true, value: { job: existing, position, deduplicated: true } };
  }

  const refused = await deps.admit?.();
  if (refused) return { ok: false, error: refused };
  const job = newJob(deps, "download", playlist.value, urls, dedupeKey, source);
  job.playlist_id = playlistId;
  job.app = deps.app ?? null;
  return { ok: true, value: await insert(deps, job) };
}

/**
 * Queue playlist ops for the Mac (`playlist` is the target the
 * ops are about). Identical active work is reused, like downloads.
 */
export async function submitLibrary(
  deps: Deps,
  playlist: string,
  ops: LibraryOp[],
  summary: string,
): Promise<Result<Submitted>> {
  const dedupeKey = JSON.stringify(deps.app ? ["library", ops, deps.app] : ["library", ops]);
  const existing = await deps.store.findActiveByDedupe(dedupeKey);
  if (existing) {
    const position = await deps.store.countActiveBefore(existing.created_at, existing.id);
    return { ok: true, value: { job: existing, position, deduplicated: true } };
  }
  const refused = await deps.admit?.();
  if (refused) return { ok: false, error: refused };
  const job = newJob(deps, "library", playlist, [], dedupeKey, "mcp");
  job.ops = ops;
  job.summary = summary;
  job.app = deps.app ?? null;
  return { ok: true, value: await insert(deps, job) };
}

function newJob(
  deps: Deps,
  kind: JobKind,
  playlist: string,
  urls: string[],
  dedupeKey: string,
  source: JobSource,
): JobRow {
  return {
    id: newJobId(),
    kind,
    state: "queued",
    playlist,
    urls,
    dedupe_key: dedupeKey,
    source,
    created_at: deps.now().toISOString(),
    claimed_at: null,
    lease_until: null,
    attempts: 0,
    finished_at: null,
    message: "Queued.",
    result: null,
    ops: null,
    summary: null,
  };
}

async function insert(deps: Deps, job: JobRow): Promise<Submitted> {
  await deps.store.insertJob(job);
  const position = await deps.store.countActiveBefore(job.created_at, job.id);
  return { job, position, deduplicated: false };
}

export async function agentStatus(deps: Deps): Promise<AgentStatus> {
  const a = await deps.store.getAgent();
  const lastSeen = a?.last_seen ?? null;
  const online =
    lastSeen !== null && deps.now().getTime() - Date.parse(lastSeen) <= AGENT_ONLINE_SECONDS * 1000;
  return { online, last_seen: lastSeen, version: a?.version ?? null };
}

export const APP_NAMES: Record<DjApp, string> = { rekordbox: "Rekordbox", serato: "Serato" };

export const isDjApp = (v: unknown): v is DjApp => DJ_APPS.includes(v as DjApp);

/** Reads through this store come from one app's snapshot; everything else is untouched. */
export function storeFor<T extends Store>(store: T, app: DjApp): T {
  const scoped = new Set<PropertyKey>(["getLibraryPlaylists", "getLibraryTracks", "getSearchIndex", "getAgent"]);
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      return scoped.has(key) ? () => (value as (a: DjApp) => unknown).call(target, app) : value.bind(target);
    },
  });
}

export type Scoped<T extends Store = Store> = { deps: Deps & { store: T } } | { refused: string };

/**
 * Point a request at the app it named, or say why it can't go there. A Mac
 * that doesn't report its apps is too old to honour this, so it's refused
 * here: it would ignore `app` and quietly use its default.
 */
export async function scopeToApp<T extends Store>(
  raw: unknown,
  deps: Deps & { store: T },
  allowBoth: boolean,
): Promise<Scoped<T>> {
  if (raw === undefined || raw === null || raw === "") return { deps };
  if (raw !== "both" && !isDjApp(raw)) return { refused: "`app` must be rekordbox, serato or both." };
  const apps = await deps.store.getDjApps();
  if (!apps) return { refused: "This Mac's DJ Sync is too old to choose an app. Update DJ Sync on the Mac, or leave the app out." };
  if (raw === "both") {
    if (!allowBoth) {
      return {
        refused: "Each app has its own playlists, so this works on one app at a time. Pick rekordbox or serato.",
      };
    }
    if (apps.enabled.length < 2) return { refused: turnedOff(DJ_APPS.find((a) => a !== apps.default)!) };
    return { deps: { ...deps, app: "both", store: storeFor(deps.store, apps.default) } };
  }
  if (!apps.enabled.includes(raw)) return { refused: turnedOff(raw) };
  return { deps: { ...deps, app: raw, store: storeFor(deps.store, raw) } };
}

const turnedOff = (app: DjApp) =>
  `${APP_NAMES[app]} isn't turned on in DJ Sync on this Mac. If it's installed, turn it on in the DJ Sync menu bar app, then ask again.`;

/**
 * Which app(s) a job lands in, for replies, or null when there's nothing to
 * tell apart: a Mac with one app on, or one too old to say.
 */
export async function whereItGoes(deps: Deps, app: AppChoice | null | undefined): Promise<string | null> {
  const apps = await deps.store.getDjApps();
  if (!apps || apps.enabled.length < 2) return null;
  const choice = app ?? apps.default;
  return choice === "both" ? apps.enabled.map((a) => APP_NAMES[a]).join(" and ") : APP_NAMES[choice];
}

/** " Your Mac is offline (last seen 3 h ago); it will download when it's back online." */
export function offlineNote(agent: AgentStatus, now: Date, kind: JobKind = "download"): string {
  const seen = agent.last_seen ? relativeTime(agent.last_seen, now) : "never";
  const what = kind === "library" ? "update your library" : "download";
  return ` Your Mac is offline (last seen ${seen}); it will ${what} when it's back online.`;
}

export function stateWord(state: JobState, kind: JobKind = "download"): string {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
      return kind === "library" ? "updating your library" : "downloading";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

/** The job as the tools and REST routes show it. */
export function jobView(j: JobRow) {
  return {
    job_id: j.id,
    kind: j.kind,
    state: j.state,
    playlist: j.playlist,
    app: j.app ?? null,
    summary: j.summary,
    urls: j.urls,
    source: j.source,
    created_at: j.created_at,
    started_at: j.claimed_at,
    finished_at: j.finished_at,
    attempts: j.attempts,
    message: j.message,
    tracks: j.result?.tracks ?? [],
    errors: j.result?.errors ?? [],
    xml_version: j.result?.xml_version ?? null,
    library_version: j.result?.library_version ?? null,
  };
}
