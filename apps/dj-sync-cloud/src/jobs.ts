// Job submission and status, shared by the MCP tools and the Shortcut REST
// routes. Mirrors apps/dj-sync/src/jobs.rs (playlist rules, dedupe, wording).

import { AGENT_ONLINE_SECONDS, MAX_PLAYLIST_NAME } from "./constants";
import type { MediaRef } from "./links";
import type { JobRow, JobSource, JobState, Store } from "./store";
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
): Promise<Result<Submitted>> {
  if (media.length === 0) return { ok: false, error: "no links to download" };
  const playlist = normalizePlaylistName(playlistName, deps.config.defaultPlaylist);
  if (!playlist.ok) return playlist;
  const urls = media.map((m) => m.url);
  const dedupeKey = JSON.stringify([playlist.value, urls]);

  // ChatGPT may retry a tool call; don't queue the same work twice.
  const existing = await deps.store.findActiveByDedupe(dedupeKey);
  if (existing) {
    const position = await deps.store.countActiveBefore(existing.created_at, existing.id);
    return { ok: true, value: { job: existing, position, deduplicated: true } };
  }

  const job: JobRow = {
    id: newJobId(),
    state: "queued",
    playlist: playlist.value,
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
  };
  await deps.store.insertJob(job);
  const position = await deps.store.countActiveBefore(job.created_at, job.id);
  return { ok: true, value: { job, position, deduplicated: false } };
}

export async function agentStatus(deps: Deps): Promise<AgentStatus> {
  const a = await deps.store.getAgent();
  const lastSeen = a?.last_seen ?? null;
  const online =
    lastSeen !== null && deps.now().getTime() - Date.parse(lastSeen) <= AGENT_ONLINE_SECONDS * 1000;
  return { online, last_seen: lastSeen, version: a?.version ?? null };
}

/** " Your Mac is offline (last seen 3 h ago); it will download when it's back online." */
export function offlineNote(agent: AgentStatus, now: Date): string {
  const seen = agent.last_seen ? relativeTime(agent.last_seen, now) : "never";
  return ` Your Mac is offline (last seen ${seen}); it will download when it's back online.`;
}

export function stateWord(state: JobState): string {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
      return "downloading";
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
    state: j.state,
    playlist: j.playlist,
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
  };
}
