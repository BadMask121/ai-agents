// Persistence behind a small interface: D1Store in production, MemoryStore in
// tests. All timestamps are `Date#toISOString()` strings, which sort
// lexically in time order, so comparisons work the same in SQL and JS.

export type JobState = "queued" | "running" | "done" | "failed";
export type JobSource = "mcp" | "shortcut";
/** `download`: links for spotdl/yt-dlp. `library`: playlist ops for Rekordbox. */
export type JobKind = "download" | "library";

/** One playlist operation, exactly as the Mac's rbdb.py consumes it. */
/**
 * rbdb.py ops. `playlist_id` (Rekordbox's id, from the snapshot) pins the
 * exact playlist when names are ambiguous; older Macs ignore it and match by
 * name.
 */
export type LibraryOp =
  | { op: "ensure_playlist"; name: string; playlist_id?: string }
  | { op: "add_to_playlist"; playlist: string; content_id: string; playlist_id?: string }
  | { op: "remove_from_playlist"; playlist: string; content_id: string; playlist_id?: string }
  | { op: "rename_playlist"; name: string; new_name: string; playlist_id?: string }
  | { op: "delete_playlist"; name: string; playlist_id?: string };

/** A track in the Mac's Rekordbox library snapshot. */
export interface LibTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  genre: string | null;
  bpm: number | null;
  key: string | null;
  duration_secs: number | null;
}

export interface LibPlaylist {
  id: string;
  name: string;
  /** "A/B" path of parent folders, "" at the top level. */
  folder: string;
  track_ids: string[];
}

export interface LibraryMeta {
  library_hash: string;
  library_generated_at: string;
  library_version: string | null;
}

export interface JobTrack {
  artist: string;
  title: string;
  file: string;
  already_downloaded: boolean;
}

export interface JobError {
  url: string;
  error: string;
}

export interface JobResult {
  tracks: JobTrack[];
  errors: JobError[];
  xml_version: string | null;
  /** Rekordbox library (master.db) version after a library job. */
  library_version?: string | null;
}

export interface JobRow {
  id: string;
  kind: JobKind;
  state: JobState;
  playlist: string;
  urls: string[];
  dedupe_key: string;
  source: JobSource;
  created_at: string;
  claimed_at: string | null;
  lease_until: string | null;
  attempts: number;
  finished_at: string | null;
  message: string;
  result: JobResult | null;
  /** Library jobs only. */
  ops: LibraryOp[] | null;
  /** Library jobs only: "Add 3 tracks to “Friday”". */
  summary: string | null;
  /** Download jobs into an existing Rekordbox playlist: its id. */
  playlist_id?: string | null;
}

/** What every agent call records. */
export interface AgentSeen {
  last_seen: string | null;
  version: string | null;
  protocol: string | null;
}

export interface AgentRow extends AgentSeen {
  library_hash: string | null;
  library_generated_at: string | null;
  library_version: string | null;
}

export interface Store {
  findActiveByDedupe(key: string): Promise<JobRow | null>;
  insertJob(job: JobRow): Promise<void>;
  getJob(id: string): Promise<JobRow | null>;
  /** Newest first. */
  recentJobs(limit: number): Promise<JobRow[]>;
  /** Queued/running jobs created before `createdAt` (excluding `id`). */
  countActiveBefore(createdAt: string, id: string): Promise<number>;
  countQueued(): Promise<number>;
  /** Push `lease_until` out for these ids if they're still running. */
  extendLeases(ids: string[], leaseUntil: string): Promise<void>;
  /**
   * Atomically take the oldest queued job — or a running one whose lease ran
   * out (the Mac went away mid-download) — and mark it running. Library jobs
   * are only handed out when `includeLibrary` (the agent understands them).
   */
  claimNext(now: string, leaseUntil: string, includeLibrary: boolean): Promise<JobRow | null>;
  finishJob(id: string, state: "done" | "failed", message: string, result: JobResult, finishedAt: string): Promise<void>;
  getAgent(): Promise<AgentRow | null>;
  /** Record a call from the Mac; leaves the library fields alone. */
  touchAgent(seen: AgentSeen): Promise<void>;
  setLibraryMeta(meta: LibraryMeta): Promise<void>;
  /** Replace the library snapshot (KV in production). */
  putLibrary(playlists: LibPlaylist[], tracks: LibTrack[]): Promise<void>;
  /** `null` until the Mac has uploaded a snapshot. */
  getLibraryPlaylists(): Promise<LibPlaylist[] | null>;
  getLibraryTracks(): Promise<LibTrack[] | null>;
  /** Delete done/failed jobs finished before `before`; returns how many. */
  purgeFinishedBefore(before: string): Promise<number>;
}

const isActive = (j: JobRow) => j.state === "queued" || j.state === "running";

/** Status messages while a claimed job runs on the Mac. */
export const CLAIMED_MESSAGE: Record<JobKind, string> = {
  download: "Downloading on your Mac…",
  library: "Updating Rekordbox on your Mac…",
};

export class MemoryStore implements Store {
  private jobs: JobRow[] = []; // insertion order doubles as the tiebreak (rowid in D1)
  private agent: AgentRow | null = null;
  private library: { playlists: LibPlaylist[]; tracks: LibTrack[] } | null = null;

  async findActiveByDedupe(key: string) {
    return clone(this.jobs.find((j) => isActive(j) && j.dedupe_key === key) ?? null);
  }

  async insertJob(job: JobRow) {
    this.jobs.push(clone(job)!);
  }

  async getJob(id: string) {
    return clone(this.jobs.find((j) => j.id === id) ?? null);
  }

  async recentJobs(limit: number) {
    return [...this.jobs]
      .map((j, i) => ({ j, i }))
      .sort((a, b) => (b.j.created_at.localeCompare(a.j.created_at)) || b.i - a.i)
      .slice(0, limit)
      .map(({ j }) => clone(j)!);
  }

  async countActiveBefore(createdAt: string, id: string) {
    return this.jobs.filter((j) => isActive(j) && j.id !== id && j.created_at < createdAt).length;
  }

  async countQueued() {
    return this.jobs.filter((j) => j.state === "queued").length;
  }

  async extendLeases(ids: string[], leaseUntil: string) {
    for (const j of this.jobs) {
      if (ids.includes(j.id) && j.state === "running") j.lease_until = leaseUntil;
    }
  }

  async claimNext(now: string, leaseUntil: string, includeLibrary: boolean) {
    const candidates = this.jobs
      .map((j, i) => ({ j, i }))
      .filter(({ j }) => includeLibrary || j.kind === "download")
      .filter(({ j }) => j.state === "queued" || (j.state === "running" && (j.lease_until ?? "") < now))
      .sort((a, b) => a.j.created_at.localeCompare(b.j.created_at) || a.i - b.i);
    const next = candidates[0]?.j;
    if (!next) return null;
    next.state = "running";
    next.claimed_at = now;
    next.lease_until = leaseUntil;
    next.attempts += 1;
    next.message = CLAIMED_MESSAGE[next.kind];
    return clone(next);
  }

  async finishJob(id: string, state: "done" | "failed", message: string, result: JobResult, finishedAt: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    j.state = state;
    j.message = message;
    j.result = clone(result);
    j.finished_at = finishedAt;
    j.lease_until = null;
  }

  async getAgent() {
    return clone(this.agent);
  }

  async touchAgent(seen: AgentSeen) {
    this.agent = { library_hash: null, library_generated_at: null, library_version: null, ...this.agent, ...clone(seen) };
  }

  async setLibraryMeta(meta: LibraryMeta) {
    this.agent = { last_seen: null, version: null, protocol: null, ...this.agent, ...clone(meta) };
  }

  async putLibrary(playlists: LibPlaylist[], tracks: LibTrack[]) {
    this.library = clone({ playlists, tracks });
  }

  async getLibraryPlaylists() {
    return clone(this.library?.playlists ?? null);
  }

  async getLibraryTracks() {
    return clone(this.library?.tracks ?? null);
  }

  async purgeFinishedBefore(before: string) {
    const keep = this.jobs.filter((j) => isActive(j) || (j.finished_at ?? "") >= before);
    const removed = this.jobs.length - keep.length;
    this.jobs = keep;
    return removed;
  }
}

function clone<T>(v: T): T {
  return v === null || v === undefined ? v : structuredClone(v);
}
