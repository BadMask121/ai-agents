// Durable Objects in plain Node: SQLite storage on node:sqlite (real SQL,
// including RETURNING), alarms, hibernatable WebSockets and namespaces.
// Hibernation itself, auto-responses and the 101 upgrade are covered by the
// `wrangler dev --local` smoke test (see README).

import { createRequire } from "node:module";

// Vite strips `node:` and can't resolve the bare "sqlite", so load it via require.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type SqlValue = ArrayBuffer | string | number | null;

class FakeSql {
  db = new DatabaseSync(":memory:");
  exec(query: string, ...bindings: SqlValue[]) {
    const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
    const statements = query.split(";").map((s) => s.trim()).filter(Boolean);
    if (statements.length > 1 && args.length === 0) {
      this.db.exec(query);
      return cursor([]);
    }
    const rows = (this.db.prepare(query).all(...(args as never[])) as Record<string, unknown>[]).map((r) => {
      const out: Record<string, SqlValue> = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] = v instanceof Uint8Array ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : (v as SqlValue);
      }
      return out;
    });
    return cursor(rows);
  }
}

function cursor(rows: Record<string, SqlValue>[]) {
  return { toArray: () => rows, one: () => rows[0]!, rowsRead: rows.length, rowsWritten: 0 };
}

export class FakeStorage {
  sql = new FakeSql();
  alarm: number | null = null;
  alarmsSet = 0;
  transactionSync<T>(fn: () => T): T {
    this.sql.db.exec("BEGIN");
    try {
      const r = fn();
      this.sql.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.sql.db.exec("ROLLBACK");
      throw e;
    }
  }
  async setAlarm(t: number | Date) {
    this.alarm = typeof t === "number" ? t : t.getTime();
    this.alarmsSet++;
  }
  async getAlarm() {
    return this.alarm;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  async deleteAll() {
    this.sql = new FakeSql();
    this.alarm = null;
  }
}

export class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  accepted = false;
  private attachment: unknown = null;
  accept() {
    this.accepted = true;
  }
  send(m: string) {
    if (this.readyState !== 1) throw new Error("socket closed");
    this.sent.push(m);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  serializeAttachment(v: unknown) {
    if (JSON.stringify(v).length > 16_384) throw new Error("attachment over 16 KB");
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  /** Parsed JSON frames, oldest first. */
  frames(): Record<string, unknown>[] {
    return this.sent.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s));
  }
  last(): Record<string, unknown> {
    return this.frames().at(-1)!;
  }
}

export class FakeCtx {
  storage = new FakeStorage();
  sockets: { ws: FakeWebSocket; tags: string[] }[] = [];
  autoResponse: unknown = null;
  constructor(public id: { name: string }) {}
  acceptWebSocket(ws: FakeWebSocket, tags: string[] = []) {
    ws.accept();
    this.sockets.push({ ws, tags });
  }
  getWebSockets(tag?: string) {
    return this.sockets.filter((s) => s.ws.readyState !== 3 && (!tag || s.tags.includes(tag))).map((s) => s.ws);
  }
  setWebSocketAutoResponse(pair: unknown) {
    this.autoResponse = pair;
  }
  waitUntil() {}
  async blockConcurrencyWhile<T>(fn: () => Promise<T>) {
    return fn();
  }
}

type DOClass<T> = new (ctx: DurableObjectState, env: never) => T;

/** idFromName/get like a DurableObjectNamespace; instances live per name. */
export class FakeNamespace<T extends { fetch(req: Request): Promise<Response> }> {
  instances = new Map<string, T>();
  ctxs = new Map<string, FakeCtx>();
  constructor(
    private cls: DOClass<T>,
    private env: () => unknown,
    private setup: (o: T) => void = () => {},
  ) {}
  idFromName(name: string) {
    return { name, toString: () => name };
  }
  instance(name: string): T {
    let o = this.instances.get(name);
    if (!o) {
      const ctx = new FakeCtx({ name });
      o = new this.cls(ctx as unknown as DurableObjectState, this.env() as never);
      this.setup(o);
      this.instances.set(name, o);
      this.ctxs.set(name, ctx);
    }
    return o;
  }
  get(id: { name: string }) {
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => this.instance(id.name).fetch(new Request(input, init)),
    };
  }
  /** Simulate eviction: a fresh instance over the same storage. */
  evict(name: string) {
    const ctx = this.ctxs.get(name)!;
    const o = new this.cls(ctx as unknown as DurableObjectState, this.env() as never);
    this.setup(o);
    this.instances.set(name, o);
    return o;
  }
}
