// One DJ's storage inside their Tenant Durable Object (SQLite): the jobs
// queue (same rows and rules as D1Store), the assistant links, the agent's
// state and the library snapshot (spec §3.2, §3.5, §3.6). SQL runs through a
// tiny `SqlDb` seam: ctx.storage.sql in production, node:sqlite in tests.

import { gunzip, gzip } from "./bytes";
import { LIBRARY_CHUNK_BYTES, MAX_LIBRARY_JSON_BYTES } from "./constants";
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

export type SqlValue = ArrayBuffer | string | number | null;
export interface SqlDb {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] };
  /** Synchronous transaction (ctx.storage.transactionSync). */
  transaction<T>(fn: () => T): T;
}

export const TENANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'download' CHECK (kind IN ('download', 'library')),
  state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  playlist    TEXT NOT NULL,
  urls        TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('mcp', 'shortcut')),
  created_at  TEXT NOT NULL,
  claimed_at  TEXT,
  lease_until TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  message     TEXT NOT NULL DEFAULT 'Queued.',
  result      TEXT,
  ops         TEXT,
  summary     TEXT,
  playlist_id TEXT
);
CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs (state, created_at);
CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs (dedupe_key, state);
CREATE TABLE IF NOT EXISTS links (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS library_chunks (
  name TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (name, seq)
);
-- Telegram (connect-anywhere spec §1), added to older tenants by migrate()
CREATE TABLE IF NOT EXISTS telegram_chats (
  link_id    TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  username   TEXT,
  first_name TEXT,
  paired_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_pending (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  urls       TEXT NOT NULL,
  hint       TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_jobs (
  job_id  TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL
);
`;

const TELEGRAM_TABLES = TENANT_SCHEMA.slice(TENANT_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS telegram_chats"));

export type LinkKind = "chatgpt" | "claude" | "shortcut" | "telegram" | "other";
export const LINK_KINDS: readonly LinkKind[] = ["chatgpt", "claude", "shortcut", "telegram", "other"];

/** A Telegram chat paired to one `telegram` link. */
export interface TelegramChat {
  link_id: string;
  chat_id: string;
  username: string | null;
  first_name: string | null;
  paired_at: string;
}

/** Links sent to the bot, waiting for a playlist button. */
export interface TgPending {
  id: string;
  chat_id: string;
  urls: string[];
  hint: string | null;
  created_at: string;
}

export interface LinkRow {
  id: string;
  kind: LinkKind;
  label: string;
  secret_hash: string;
  created_at: string;
  last_used_at: string | null;
}

const COLUMNS =
  "id, kind, state, playlist, urls, dedupe_key, source, created_at, claimed_at, lease_until, attempts, finished_at, message, result, ops, summary, playlist_id";

function toJob(r: Record<string, SqlValue> | undefined): JobRow | null {
  if (!r) return null;
  return {
    id: r.id as string,
    kind: r.kind as JobRow["kind"],
    state: r.state as JobRow["state"],
    playlist: r.playlist as string,
    urls: JSON.parse(r.urls as string) as string[],
    dedupe_key: r.dedupe_key as string,
    source: r.source as JobRow["source"],
    created_at: r.created_at as string,
    claimed_at: (r.claimed_at as string | null) ?? null,
    lease_until: (r.lease_until as string | null) ?? null,
    attempts: Number(r.attempts),
    finished_at: (r.finished_at as string | null) ?? null,
    message: r.message as string,
    result: r.result ? (JSON.parse(r.result as string) as JobResult) : null,
    ops: r.ops ? (JSON.parse(r.ops as string) as LibraryOp[]) : null,
    summary: (r.summary as string | null) ?? null,
    playlist_id: (r.playlist_id as string | null) ?? null,
  };
}

type PlaylistTuple = [id: string, name: string, folder: string, trackIds: string[]];
type TrackTuple = [string, string, string | null, string | null, string | null, number | null, string | null, number | null];

export class SqlStore implements Store {
  /** Decompressed snapshot, kept while this DO instance lives. */
  private cache: { hash: string; playlists?: LibPlaylist[]; tracks?: LibTrack[] } | null = null;

  constructor(
    private db: SqlDb,
    /** The Mac's socket is attached right now (it counts as just seen). */
    private live: () => boolean = () => false,
    private now: () => Date = () => new Date(),
  ) {}

  /** Bring a tenant created by an older Worker up to the current schema. */
  static migrate(db: SqlDb): void {
    const cols = db.exec("PRAGMA table_info(jobs)").toArray().map((r) => r.name as string);
    if (cols.length > 0 && !cols.includes("playlist_id")) db.exec("ALTER TABLE jobs ADD COLUMN playlist_id TEXT");
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_chats'").toArray();
    if (cols.length > 0 && tables.length === 0) {
      for (const stmt of TELEGRAM_TABLES.split(";").map((t) => t.trim()).filter(Boolean)) db.exec(stmt);
    }
  }

  /** Has `init` run? Read-only, so probing an unknown tenant writes nothing. */
  static initialized(db: SqlDb): boolean {
    return db.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  init(fields: Record<string, string>): void {
    this.db.transaction(() => {
      for (const stmt of TENANT_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.db.exec(stmt);
      for (const [k, v] of Object.entries(fields)) this.setMeta(k, v);
    });
  }

  // ---------- meta ----------

  meta(key: string): string | null {
    const r = this.db.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return (r?.value as string | null | undefined) ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.exec("DELETE FROM meta WHERE key = ?", key);
    else this.db.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  // ---------- Store: jobs (same semantics as D1Store) ----------

  async findActiveByDedupe(key: string) {
    return toJob(
      this.db.exec(`SELECT ${COLUMNS} FROM jobs WHERE dedupe_key = ? AND state IN ('queued', 'running') LIMIT 1`, key).toArray()[0],
    );
  }

  async insertJob(j: JobRow) {
    this.db.exec(
      `INSERT INTO jobs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      j.playlist_id ?? null,
    );
  }

  async getJob(id: string) {
    return toJob(this.db.exec(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`, id).toArray()[0]);
  }

  async recentJobs(limit: number) {
    return this.db
      .exec(`SELECT ${COLUMNS} FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?`, limit)
      .toArray()
      .map((r) => toJob(r)!);
  }

  async countActiveBefore(createdAt: string, id: string) {
    return this.count(
      "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running') AND created_at < ? AND id != ?",
      createdAt,
      id,
    );
  }

  async countQueued() {
    return this.count("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'");
  }

  /** Jobs stored since `since` (ISO) — the per-day limit. */
  countCreatedSince(since: string): number {
    return this.count("SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ?", since);
  }

  async extendLeases(ids: string[], leaseUntil: string) {
    for (const id of ids) {
      this.db.exec("UPDATE jobs SET lease_until = ? WHERE id = ? AND state = 'running'", leaseUntil, id);
    }
  }

  async claimNext(now: string, leaseUntil: string, includeLibrary: boolean) {
    return toJob(
      this.db
        .exec(
          `UPDATE jobs
              SET state = 'running', claimed_at = ?, lease_until = ?, attempts = attempts + 1,
                  message = CASE kind WHEN 'library' THEN ? ELSE ? END
            WHERE id = (
              SELECT id FROM jobs
               WHERE (state = 'queued' OR (state = 'running' AND lease_until < ?))
                 AND (? = 1 OR kind = 'download')
               ORDER BY created_at, rowid
               LIMIT 1)
          RETURNING ${COLUMNS}`,
          now,
          leaseUntil,
          CLAIMED_MESSAGE.library,
          CLAIMED_MESSAGE.download,
          now,
          includeLibrary ? 1 : 0,
        )
        .toArray()[0],
    );
  }

  /** Running jobs whose lease ran out go back to the queue (spec §3.5). */
  expireLeases(now: string): string[] {
    return this.db
      .exec(
        "UPDATE jobs SET state = 'queued', lease_until = NULL, message = 'Queued.' WHERE state = 'running' AND lease_until < ? RETURNING id",
        now,
      )
      .toArray()
      .map((r) => r.id as string);
  }

  /** The soonest lease expiry, for the alarm; null when nothing is leased. */
  earliestLease(): string | null {
    const r = this.db.exec("SELECT MIN(lease_until) AS t FROM jobs WHERE state = 'running'").toArray()[0];
    return (r?.t as string | null | undefined) ?? null;
  }

  async finishJob(id: string, state: "done" | "failed", message: string, result: JobResult, finishedAt: string) {
    this.db.exec(
      "UPDATE jobs SET state = ?, message = ?, result = ?, finished_at = ?, lease_until = NULL WHERE id = ?",
      state,
      message,
      JSON.stringify(result),
      finishedAt,
      id,
    );
  }

  async purgeFinishedBefore(before: string) {
    return this.db
      .exec("DELETE FROM jobs WHERE state IN ('done', 'failed') AND finished_at < ? RETURNING id", before)
      .toArray().length;
  }

  // ---------- Store: agent ----------

  async getAgent(): Promise<AgentRow> {
    return {
      // While the socket is attached the Mac is online by definition.
      last_seen: this.live() ? this.now().toISOString() : this.meta("last_seen"),
      version: this.meta("agent_version"),
      protocol: this.meta("agent_protocol"),
      library_hash: this.meta("library_hash"),
      library_generated_at: this.meta("library_generated_at"),
      library_version: this.meta("library_version"),
    };
  }

  async touchAgent(seen: AgentSeen) {
    this.setMeta("last_seen", seen.last_seen);
    this.setMeta("agent_version", seen.version);
    this.setMeta("agent_protocol", seen.protocol);
  }

  async setLibraryMeta(m: LibraryMeta) {
    this.setMeta("library_hash", m.library_hash);
    this.setMeta("library_generated_at", m.library_generated_at);
    this.setMeta("library_version", m.library_version);
  }

  // ---------- Store: library snapshot (gzip'd tuples in ≤1 MB rows) ----------

  async putLibrary(playlists: LibPlaylist[], tracks: LibTrack[]) {
    const p: PlaylistTuple[] = playlists.map((x) => [x.id, x.name, x.folder, x.track_ids]);
    const t: TrackTuple[] = tracks.map((x) => [x.id, x.title, x.artist, x.album, x.genre, x.bpm, x.key, x.duration_secs]);
    const enc = new TextEncoder();
    const blobs = {
      playlists: await gzip(enc.encode(JSON.stringify(p))),
      tracks: await gzip(enc.encode(JSON.stringify(t))),
    };
    this.db.transaction(() => {
      this.db.exec("DELETE FROM library_chunks");
      for (const [name, blob] of Object.entries(blobs)) {
        for (let seq = 0, at = 0; at < blob.byteLength; seq++, at += LIBRARY_CHUNK_BYTES) {
          const part = blob.slice(at, at + LIBRARY_CHUNK_BYTES);
          this.db.exec("INSERT INTO library_chunks (name, seq, data) VALUES (?, ?, ?)", name, seq, part.buffer);
        }
      }
    });
    this.cache = null;
  }

  async getLibraryPlaylists() {
    const cached = await this.cached("playlists");
    if (cached === undefined) return null;
    return [...(cached as LibPlaylist[])];
  }

  async getLibraryTracks() {
    const cached = await this.cached("tracks");
    if (cached === undefined) return null;
    return [...(cached as LibTrack[])];
  }

  /** Bytes the snapshot takes (both blobs), for tests and stats. */
  libraryBytes(): number {
    return this.count("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM library_chunks");
  }

  private async cached(name: "playlists" | "tracks"): Promise<LibPlaylist[] | LibTrack[] | undefined> {
    const hash = this.meta("library_hash");
    if (hash === null) return undefined;
    if (this.cache?.hash !== hash) this.cache = { hash };
    const have = this.cache[name];
    if (have) return have;

    const rows = this.db.exec("SELECT data FROM library_chunks WHERE name = ? ORDER BY seq", name).toArray();
    if (rows.length === 0) return undefined;
    const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.byteLength;
    }
    const raw = await gunzip(all, MAX_LIBRARY_JSON_BYTES);
    if (raw === null) return undefined;
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown[];
    if (name === "playlists") {
      const list = (parsed as PlaylistTuple[]).map(([id, n, folder, track_ids]) => ({ id, name: n, folder, track_ids }));
      this.cache.playlists = list;
      return list;
    }
    const list = (parsed as TrackTuple[]).map(([id, title, artist, album, genre, bpm, key, duration_secs]) => ({
      id,
      title,
      artist,
      album,
      genre,
      bpm,
      key,
      duration_secs,
    }));
    this.cache.tracks = list;
    return list;
  }

  // ---------- links ----------

  links(): LinkRow[] {
    return this.db
      .exec("SELECT id, kind, label, secret_hash, created_at, last_used_at FROM links ORDER BY created_at, rowid")
      .toArray()
      .map((r) => ({
        id: r.id as string,
        kind: r.kind as LinkKind,
        label: r.label as string,
        secret_hash: r.secret_hash as string,
        created_at: r.created_at as string,
        last_used_at: (r.last_used_at as string | null) ?? null,
      }));
  }

  insertLink(l: LinkRow): void {
    this.db.exec(
      "INSERT INTO links (id, kind, label, secret_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
      l.id,
      l.kind,
      l.label,
      l.secret_hash,
      l.created_at,
      l.last_used_at,
    );
  }

  setLinkSecret(id: string, secretHash: string): boolean {
    return this.db.exec("UPDATE links SET secret_hash = ?, last_used_at = NULL WHERE id = ? RETURNING id", secretHash, id).toArray().length > 0;
  }

  touchLink(id: string, at: string): void {
    this.db.exec("UPDATE links SET last_used_at = ? WHERE id = ?", at, id);
  }

  deleteLink(id: string): boolean {
    return this.db.exec("DELETE FROM links WHERE id = ? RETURNING id", id).toArray().length > 0;
  }

  // ---------- Telegram ----------

  telegramChats(): TelegramChat[] {
    return this.db
      .exec("SELECT link_id, chat_id, username, first_name, paired_at FROM telegram_chats")
      .toArray()
      .map(toChat);
  }

  telegramChatByChat(chatId: string): TelegramChat | null {
    const r = this.db
      .exec("SELECT link_id, chat_id, username, first_name, paired_at FROM telegram_chats WHERE chat_id = ?", chatId)
      .toArray()[0];
    return r ? toChat(r) : null;
  }

  /** Pair `chat_id` with `link_id`; returns the chat the link had before (if another). */
  bindTelegram(c: TelegramChat): string | null {
    return this.db.transaction(() => {
      const before = this.db.exec("SELECT chat_id FROM telegram_chats WHERE link_id = ?", c.link_id).toArray()[0]?.chat_id as
        | string
        | undefined;
      this.db.exec("DELETE FROM telegram_chats WHERE chat_id = ? OR link_id = ?", c.chat_id, c.link_id);
      this.db.exec(
        "INSERT INTO telegram_chats (link_id, chat_id, username, first_name, paired_at) VALUES (?, ?, ?, ?, ?)",
        c.link_id,
        c.chat_id,
        c.username,
        c.first_name,
        c.paired_at,
      );
      return before !== undefined && before !== c.chat_id ? before : null;
    });
  }

  /** Unpair a link; returns the chat it had. */
  unbindTelegramLink(linkId: string): string | null {
    const r = this.db.exec("DELETE FROM telegram_chats WHERE link_id = ? RETURNING chat_id", linkId).toArray()[0];
    return (r?.chat_id as string | undefined) ?? null;
  }

  /** Forget a chat (it now belongs to another DJ). */
  unbindTelegramChat(chatId: string): void {
    this.db.exec("DELETE FROM telegram_chats WHERE chat_id = ?", chatId);
    this.db.exec("DELETE FROM tg_pending WHERE chat_id = ?", chatId);
    this.db.exec("DELETE FROM tg_jobs WHERE chat_id = ?", chatId);
  }

  addTgPending(p: TgPending): void {
    this.db.exec(
      "INSERT INTO tg_pending (id, chat_id, urls, hint, created_at) VALUES (?, ?, ?, ?, ?)",
      p.id,
      p.chat_id,
      JSON.stringify(p.urls),
      p.hint,
      p.created_at,
    );
  }

  getTgPending(id: string): TgPending | null {
    const r = this.db.exec("SELECT id, chat_id, urls, hint, created_at FROM tg_pending WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    return {
      id: r.id as string,
      chat_id: r.chat_id as string,
      urls: JSON.parse(r.urls as string) as string[],
      hint: (r.hint as string | null) ?? null,
      created_at: r.created_at as string,
    };
  }

  deleteTgPending(id: string): void {
    this.db.exec("DELETE FROM tg_pending WHERE id = ?", id);
  }

  purgeTgPendingBefore(before: string): void {
    this.db.exec("DELETE FROM tg_pending WHERE created_at < ?", before);
  }

  addTgJob(jobId: string, chatId: string): void {
    this.db.exec("INSERT INTO tg_jobs (job_id, chat_id) VALUES (?, ?) ON CONFLICT (job_id) DO UPDATE SET chat_id = excluded.chat_id", jobId, chatId);
  }

  /** The chat waiting to hear about `jobId` (forgotten once read). */
  takeTgJob(jobId: string): string | null {
    const r = this.db.exec("DELETE FROM tg_jobs WHERE job_id = ? RETURNING chat_id", jobId).toArray()[0];
    return (r?.chat_id as string | undefined) ?? null;
  }

  private count(query: string, ...bindings: SqlValue[]): number {
    const r = this.db.exec(query, ...bindings).toArray()[0];
    return Number(r?.n ?? 0);
  }
}

function toChat(r: Record<string, SqlValue>): TelegramChat {
  return {
    link_id: r.link_id as string,
    chat_id: r.chat_id as string,
    username: (r.username as string | null) ?? null,
    first_name: (r.first_name as string | null) ?? null,
    paired_at: r.paired_at as string,
  };
}
