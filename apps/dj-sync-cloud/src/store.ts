// Persistence behind a small interface: D1Store in production, MemoryStore in
// tests. All timestamps are `Date#toISOString()` strings, which sort
// lexically in time order, so comparisons work the same in SQL and JS.

export type JobState = "queued" | "running" | "done" | "failed";
export type JobSource = "mcp" | "shortcut";

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
}

export interface JobRow {
  id: string;
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
}

export interface AgentRow {
  last_seen: string | null;
  version: string | null;
  protocol: string | null;
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
   * out (the Mac went away mid-download) — and mark it running.
   */
  claimNext(now: string, leaseUntil: string, message: string): Promise<JobRow | null>;
  finishJob(id: string, state: "done" | "failed", message: string, result: JobResult, finishedAt: string): Promise<void>;
  getAgent(): Promise<AgentRow | null>;
  touchAgent(agent: AgentRow): Promise<void>;
  /** Delete done/failed jobs finished before `before`; returns how many. */
  purgeFinishedBefore(before: string): Promise<number>;
}

const isActive = (j: JobRow) => j.state === "queued" || j.state === "running";

export class MemoryStore implements Store {
  private jobs: JobRow[] = []; // insertion order doubles as the tiebreak (rowid in D1)
  private agent: AgentRow | null = null;

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

  async claimNext(now: string, leaseUntil: string, message: string) {
    const candidates = this.jobs
      .map((j, i) => ({ j, i }))
      .filter(({ j }) => j.state === "queued" || (j.state === "running" && (j.lease_until ?? "") < now))
      .sort((a, b) => a.j.created_at.localeCompare(b.j.created_at) || a.i - b.i);
    const next = candidates[0]?.j;
    if (!next) return null;
    next.state = "running";
    next.claimed_at = now;
    next.lease_until = leaseUntil;
    next.attempts += 1;
    next.message = message;
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

  async touchAgent(agent: AgentRow) {
    this.agent = clone(agent);
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
