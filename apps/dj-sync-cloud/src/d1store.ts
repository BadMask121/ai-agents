import type { AgentRow, JobResult, JobRow, Store } from "./store";

interface JobRecord {
  id: string;
  state: JobRow["state"];
  playlist: string;
  urls: string;
  dedupe_key: string;
  source: JobRow["source"];
  created_at: string;
  claimed_at: string | null;
  lease_until: string | null;
  attempts: number;
  finished_at: string | null;
  message: string;
  result: string | null;
}

const COLUMNS =
  "id, state, playlist, urls, dedupe_key, source, created_at, claimed_at, lease_until, attempts, finished_at, message, result";

function toRow(r: JobRecord | null): JobRow | null {
  if (!r) return null;
  return {
    ...r,
    urls: JSON.parse(r.urls) as string[],
    result: r.result ? (JSON.parse(r.result) as JobResult) : null,
  };
}

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async findActiveByDedupe(key: string) {
    const r = await this.db
      .prepare(`SELECT ${COLUMNS} FROM jobs WHERE dedupe_key = ?1 AND state IN ('queued', 'running') LIMIT 1`)
      .bind(key)
      .first<JobRecord>();
    return toRow(r);
  }

  async insertJob(j: JobRow) {
    await this.db
      .prepare(
        `INSERT INTO jobs (${COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        j.id,
        j.state,
        j.playlist,
        JSON.stringify(j.urls),
        j.dedupe_key,
        j.source,
        j.created_at,
        j.claimed_at,
        j.lease_until,
        j.attempts,
        j.finished_at,
        j.message,
        j.result ? JSON.stringify(j.result) : null,
      )
      .run();
  }

  async getJob(id: string) {
    const r = await this.db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?1`).bind(id).first<JobRecord>();
    return toRow(r);
  }

  async recentJobs(limit: number) {
    const { results } = await this.db
      .prepare(`SELECT ${COLUMNS} FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?1`)
      .bind(limit)
      .all<JobRecord>();
    return results.map((r) => toRow(r)!);
  }

  async countActiveBefore(createdAt: string, id: string) {
    const r = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running') AND created_at < ?1 AND id != ?2",
      )
      .bind(createdAt, id)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async countQueued() {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'").first<{ n: number }>();
    return r?.n ?? 0;
  }

  async extendLeases(ids: string[], leaseUntil: string) {
    if (ids.length === 0) return;
    const stmt = this.db.prepare("UPDATE jobs SET lease_until = ?1 WHERE id = ?2 AND state = 'running'");
    await this.db.batch(ids.map((id) => stmt.bind(leaseUntil, id)));
  }

  async claimNext(now: string, leaseUntil: string, message: string) {
    // One statement, so two pollers can never claim the same job.
    const r = await this.db
      .prepare(
        `UPDATE jobs
            SET state = 'running', claimed_at = ?1, lease_until = ?2, attempts = attempts + 1, message = ?3
          WHERE id = (
            SELECT id FROM jobs
             WHERE state = 'queued' OR (state = 'running' AND lease_until < ?1)
             ORDER BY created_at, rowid
             LIMIT 1)
        RETURNING ${COLUMNS}`,
      )
      .bind(now, leaseUntil, message)
      .first<JobRecord>();
    return toRow(r);
  }

  async finishJob(id: string, state: "done" | "failed", message: string, result: JobResult, finishedAt: string) {
    await this.db
      .prepare(
        "UPDATE jobs SET state = ?2, message = ?3, result = ?4, finished_at = ?5, lease_until = NULL WHERE id = ?1",
      )
      .bind(id, state, message, JSON.stringify(result), finishedAt)
      .run();
  }

  async getAgent() {
    return this.db.prepare("SELECT last_seen, version, protocol FROM agent WHERE id = 1").first<AgentRow>();
  }

  async touchAgent(a: AgentRow) {
    await this.db
      .prepare(
        `INSERT INTO agent (id, last_seen, version, protocol) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET last_seen = ?1, version = ?2, protocol = ?3`,
      )
      .bind(a.last_seen, a.version, a.protocol)
      .run();
  }

  async purgeFinishedBefore(before: string) {
    const r = await this.db
      .prepare("DELETE FROM jobs WHERE state IN ('done', 'failed') AND finished_at < ?1")
      .bind(before)
      .run();
    return r.meta.changes ?? 0;
  }
}
