import {
  CLAIMED_MESSAGE,
  type AgentRow,
  type AgentSeen,
  type JobResult,
  type JobRow,
  type LibPlaylist,
  type LibTrack,
  type LibraryMeta,
  type LibraryOp,
  type Store,
} from "./store";

interface JobRecord {
  id: string;
  kind: JobRow["kind"];
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
  ops: string | null;
  summary: string | null;
}

const COLUMNS =
  "id, kind, state, playlist, urls, dedupe_key, source, created_at, claimed_at, lease_until, attempts, finished_at, message, result, ops, summary";

function toRow(r: JobRecord | null): JobRow | null {
  if (!r) return null;
  return {
    ...r,
    urls: JSON.parse(r.urls) as string[],
    result: r.result ? (JSON.parse(r.result) as JobResult) : null,
    ops: r.ops ? (JSON.parse(r.ops) as LibraryOp[]) : null,
  };
}

// The library snapshot lives in KV as two compact JSON keys, so the common
// reads parse as little as possible (the Workers free plan allows ~10 ms of
// CPU per request): list_playlists only touches the small playlists key.
const PLAYLISTS_KEY = "library:playlists";
const TRACKS_KEY = "library:tracks";

type PlaylistTuple = [id: string, name: string, folder: string, trackIds: string[]];
type TrackTuple = [
  id: string,
  title: string,
  artist: string | null,
  album: string | null,
  genre: string | null,
  bpm: number | null,
  key: string | null,
  duration: number | null,
];

export class D1Store implements Store {
  constructor(
    private db: D1Database,
    private kv?: KVNamespace,
  ) {}

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
        `INSERT INTO jobs (${COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
      .bind(
        j.id,
        j.kind,
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
        j.ops ? JSON.stringify(j.ops) : null,
        j.summary,
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

  async claimNext(now: string, leaseUntil: string, includeLibrary: boolean) {
    // One statement, so two pollers can never claim the same job. Agents on
    // protocol 1.0 don't know library jobs and must never be handed one.
    const r = await this.db
      .prepare(
        `UPDATE jobs
            SET state = 'running', claimed_at = ?1, lease_until = ?2, attempts = attempts + 1,
                message = CASE kind WHEN 'library' THEN ?4 ELSE ?3 END
          WHERE id = (
            SELECT id FROM jobs
             WHERE (state = 'queued' OR (state = 'running' AND lease_until < ?1))
               AND (?5 = 1 OR kind = 'download')
             ORDER BY created_at, rowid
             LIMIT 1)
        RETURNING ${COLUMNS}`,
      )
      .bind(now, leaseUntil, CLAIMED_MESSAGE.download, CLAIMED_MESSAGE.library, includeLibrary ? 1 : 0)
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
    return this.db
      .prepare(
        "SELECT last_seen, version, protocol, library_hash, library_generated_at, library_version FROM agent WHERE id = 1",
      )
      .first<AgentRow>();
  }

  async touchAgent(a: AgentSeen) {
    await this.db
      .prepare(
        `INSERT INTO agent (id, last_seen, version, protocol) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET last_seen = ?1, version = ?2, protocol = ?3`,
      )
      .bind(a.last_seen, a.version, a.protocol)
      .run();
  }

  async setLibraryMeta(m: LibraryMeta) {
    await this.db
      .prepare(
        `INSERT INTO agent (id, library_hash, library_generated_at, library_version) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET library_hash = ?1, library_generated_at = ?2, library_version = ?3`,
      )
      .bind(m.library_hash, m.library_generated_at, m.library_version)
      .run();
  }

  async putLibrary(playlists: LibPlaylist[], tracks: LibTrack[]) {
    if (!this.kv) throw new Error("library storage (KV binding LIBRARY) is not configured");
    const p: PlaylistTuple[] = playlists.map((x) => [x.id, x.name, x.folder, x.track_ids]);
    const t: TrackTuple[] = tracks.map((x) => [
      x.id,
      x.title,
      x.artist,
      x.album,
      x.genre,
      x.bpm,
      x.key,
      x.duration_secs,
    ]);
    // Tracks first: a reader that sees the new playlists finds their tracks.
    await this.kv.put(TRACKS_KEY, JSON.stringify(t));
    await this.kv.put(PLAYLISTS_KEY, JSON.stringify(p));
  }

  async getLibraryPlaylists() {
    const raw = await this.kv?.get(PLAYLISTS_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as PlaylistTuple[]).map(([id, name, folder, track_ids]) => ({ id, name, folder, track_ids }));
  }

  async getLibraryTracks() {
    const raw = await this.kv?.get(TRACKS_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as TrackTuple[]).map(([id, title, artist, album, genre, bpm, key, duration_secs]) => ({
      id,
      title,
      artist,
      album,
      genre,
      bpm,
      key,
      duration_secs,
    }));
  }

  async purgeFinishedBefore(before: string) {
    const r = await this.db
      .prepare("DELETE FROM jobs WHERE state IN ('done', 'failed') AND finished_at < ?1")
      .bind(before)
      .run();
    return r.meta.changes ?? 0;
  }
}
