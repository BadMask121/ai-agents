/**
 * A logged-in IMAP connection and the operations mail-mcp needs. Built on any
 * socket with `readable`/`writable` streams — in the Worker that's a
 * cloudflare:sockets TLS socket, in tests a scripted fake.
 *
 * One session per tool call: connect, LOGIN, do the work, LOGOUT. Workers
 * don't keep sockets between requests, and a fresh login is ~1 s of waiting,
 * not CPU.
 */
import { argument, decodeMailboxName, encodeMailboxName } from "./codec.js";
import { ResponseReader, asText, parseResponse, type ImapResponse, type ImapValue } from "./protocol.js";
import { parseBodyStructure, parseEnvelope, type BodyPart, type Envelope } from "./structure.js";

export class MailboxError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MailboxError";
  }
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  unseen?: boolean;
}

export interface Folder {
  /** Decoded (UTF-8) path; encoded again when sent to the server. */
  path: string;
  name: string;
  specialUse?: string;
  selectable: boolean;
}

export interface FetchedMessage {
  uid: number;
  flags: Set<string>;
  envelope: Envelope;
  structure?: BodyPart;
}

export interface Socket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

const SPECIAL_USE = ["\\All", "\\Archive", "\\Drafts", "\\Flagged", "\\Junk", "\\Sent", "\\Trash"];
const encoder = new TextEncoder();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** IMAP search date, e.g. 1-Jan-2024. */
function imapDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** FETCH data list (KEY value KEY value …) → map with upper-case keys. */
function fetchItems(v: ImapValue | undefined): Map<string, ImapValue> {
  const out = new Map<string, ImapValue>();
  const items = Array.isArray(v) ? v : [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    const k = asText(items[i]);
    if (k) out.set(k.toUpperCase(), items[i + 1]!);
  }
  return out;
}

function toFetched(items: Map<string, ImapValue>): FetchedMessage | undefined {
  const uid = Number.parseInt(asText(items.get("UID")) ?? "", 10);
  if (!uid) return undefined;
  const flags = items.get("FLAGS");
  return {
    uid,
    flags: new Set(Array.isArray(flags) ? flags.map((f) => asText(f) ?? "") : []),
    envelope: parseEnvelope(items.get("ENVELOPE")),
    structure: items.has("BODYSTRUCTURE") ? parseBodyStructure(items.get("BODYSTRUCTURE")) : undefined,
  };
}

export class ImapSession {
  private tagCounter = 0;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ResponseReader;
  capabilities = new Set<string>();
  /** EXISTS of the selected mailbox. */
  exists = 0;

  constructor(
    private readonly socket: Socket,
    private readonly timeoutMs = 30_000,
  ) {
    this.writer = socket.writable.getWriter();
    this.reader = new ResponseReader(socket.readable.getReader());
  }

  private noteCapabilities(text: string): void {
    const m = /\[CAPABILITY ([^\]]+)\]/i.exec(text);
    if (m) this.capabilities = new Set(m[1]!.toUpperCase().split(/\s+/));
  }

  /** Read the server greeting. */
  async greet(): Promise<void> {
    const greeting = parseResponse(await this.withTimeout(this.reader.next(), "greeting"));
    if (greeting.status !== "OK" && greeting.status !== "PREAUTH") {
      throw new MailboxError(`IMAP server refused the connection: ${greeting.text}`, "IMAP_CONNECT");
    }
    this.noteCapabilities(greeting.text);
  }

  private async withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MailboxError(`IMAP ${what} timed out`, "IMAP_TIMEOUT")), this.timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send a command; return its untagged responses. Throws on NO/BAD. */
  async run(...parts: (string | Uint8Array)[]): Promise<ImapResponse[]> {
    const tag = `A${++this.tagCounter}`;
    const chunks = [encoder.encode(`${tag} `), ...parts.map((p) => (typeof p === "string" ? encoder.encode(p) : p)), encoder.encode("\r\n")];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const line = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      line.set(c, at);
      at += c.length;
    }
    await this.writer.write(line);

    const untagged: ImapResponse[] = [];
    const verb = typeof parts[0] === "string" ? parts[0].split(" ")[0] : "command";
    for (;;) {
      const res = parseResponse(await this.withTimeout(this.reader.next(), verb!));
      if (res.tag === tag) {
        if (res.status === "OK") {
          this.noteCapabilities(res.text);
          return untagged;
        }
        throw new MailboxError(`IMAP ${verb} failed: ${res.text}`, res.status === "NO" ? "IMAP_NO" : "IMAP_BAD");
      }
      if (res.tag === "*" && res.status === "BYE") {
        throw new MailboxError(`IMAP server closed the connection: ${res.text}`, "IMAP_BYE");
      }
      untagged.push(res);
    }
  }

  async login(user: string, pass: string): Promise<void> {
    try {
      await this.run("LOGIN ", argument(user), " ", argument(pass));
    } catch (err) {
      throw new MailboxError(`IMAP connect/auth failed: ${(err as Error).message}`, "IMAP_CONNECT");
    }
    if (this.capabilities.size === 0) {
      for (const r of await this.run("CAPABILITY")) {
        if (asText(r.values[0])?.toUpperCase() === "CAPABILITY") {
          this.capabilities = new Set(r.values.slice(1).map((v) => (asText(v) ?? "").toUpperCase()));
        }
      }
    }
  }

  async logout(): Promise<void> {
    try {
      await this.run("LOGOUT");
    } catch {
      /* server may close first */
    }
  }

  async list(): Promise<Folder[]> {
    const out: Folder[] = [];
    for (const r of await this.run('LIST "" "*"')) {
      if (asText(r.values[0])?.toUpperCase() !== "LIST") continue;
      const flags = (Array.isArray(r.values[1]) ? r.values[1] : []).map((f) => asText(f) ?? "");
      const delimiter = asText(r.values[2]) ?? "/";
      const path = decodeMailboxName(asText(r.values[3]) ?? "");
      const specialUse =
        flags.find((f) => SPECIAL_USE.includes(f)) ?? (path.toUpperCase() === "INBOX" ? "\\Inbox" : undefined);
      out.push({
        path,
        name: path.split(delimiter).pop() ?? path,
        specialUse,
        selectable: !flags.some((f) => f.toLowerCase() === "\\noselect" || f.toLowerCase() === "\\nonexistent"),
      });
    }
    return out;
  }

  async status(path: string): Promise<{ messages: number; unseen: number }> {
    const res = await this.run("STATUS ", argument(encodeMailboxName(path)), " (MESSAGES UNSEEN)");
    const data = res.find((r) => asText(r.values[0])?.toUpperCase() === "STATUS");
    const items = fetchItems(data?.values[2]);
    return {
      messages: Number.parseInt(asText(items.get("MESSAGES")) ?? "0", 10) || 0,
      unseen: Number.parseInt(asText(items.get("UNSEEN")) ?? "0", 10) || 0,
    };
  }

  /** SELECT (read-write) or EXAMINE (read-only) a folder. */
  async open(path: string, write: boolean): Promise<void> {
    try {
      const res = await this.run(write ? "SELECT " : "EXAMINE ", argument(encodeMailboxName(path)));
      const exists = res.find((r) => asText(r.values[1])?.toUpperCase() === "EXISTS");
      this.exists = Number.parseInt(asText(exists?.values[0]) ?? "0", 10) || 0;
    } catch (err) {
      const msg = (err as Error).message;
      if (/no such|not exist|nonexistent|unknown mailbox/i.test(msg)) {
        throw new MailboxError(`Folder not found: ${path}`, "FOLDER_NOT_FOUND");
      }
      throw new MailboxError(`Cannot open folder ${path}: ${msg}`, "FOLDER_OPEN");
    }
  }

  async search(criteria: SearchCriteria): Promise<number[]> {
    const parts: (string | Uint8Array)[] = ["UID SEARCH"];
    let utf8 = false;
    const add = (key: string, value: string) => {
      const arg = argument(value);
      if (typeof arg !== "string") utf8 = true;
      parts.push(` ${key} `, arg);
    };
    if (criteria.from) add("FROM", criteria.from);
    if (criteria.to) add("TO", criteria.to);
    if (criteria.subject) add("SUBJECT", criteria.subject);
    if (criteria.text) add("TEXT", criteria.text);
    if (criteria.since) parts.push(` SINCE ${imapDate(criteria.since)}`);
    if (criteria.before) parts.push(` BEFORE ${imapDate(criteria.before)}`);
    if (criteria.unseen) parts.push(" UNSEEN");
    if (parts.length === 1) parts.push(" ALL");
    if (utf8) parts.splice(1, 0, " CHARSET UTF-8");

    const uids: number[] = [];
    for (const r of await this.run(...parts)) {
      if (asText(r.values[0])?.toUpperCase() !== "SEARCH") continue;
      for (const v of r.values.slice(1)) {
        const n = Number.parseInt(asText(v) ?? "", 10);
        if (n) uids.push(n);
      }
    }
    return uids.sort((a, b) => a - b);
  }

  /** Summaries for a UID set ("1,5,9") or, with `byUid` false, a sequence range ("10:20"). */
  async fetchSummaries(set: string, byUid: boolean): Promise<FetchedMessage[]> {
    const res = await this.run(`${byUid ? "UID " : ""}FETCH ${set} (UID FLAGS ENVELOPE BODYSTRUCTURE)`);
    return res
      .filter((r) => asText(r.values[1])?.toUpperCase() === "FETCH")
      .map((r) => toFetched(fetchItems(r.values[2])))
      .filter((m): m is FetchedMessage => m !== undefined);
  }

  async fetchOne(uid: number): Promise<FetchedMessage> {
    const [msg] = await this.fetchSummaries(String(uid), true);
    if (!msg) throw new MailboxError(`Message not found: UID ${uid}`, "UID_NOT_FOUND");
    return msg;
  }

  /** Raw bytes of one body section (still transfer-encoded). */
  async fetchSection(uid: number, section: string): Promise<Uint8Array> {
    const res = await this.run(`UID FETCH ${uid} (UID BODY.PEEK[${section}])`);
    for (const r of res) {
      if (asText(r.values[1])?.toUpperCase() !== "FETCH") continue;
      for (const [key, value] of fetchItems(r.values[2])) {
        if (key.startsWith("BODY[")) {
          if (value instanceof Uint8Array) return value;
          if (typeof value === "string") return encoder.encode(value);
        }
      }
    }
    throw new MailboxError(`Message not found: UID ${uid}`, "UID_NOT_FOUND");
  }

  async move(uid: number, target: string): Promise<void> {
    const dest = argument(encodeMailboxName(target));
    if (this.capabilities.has("MOVE")) {
      await this.run(`UID MOVE ${uid} `, dest);
      return;
    }
    await this.run(`UID COPY ${uid} `, dest);
    await this.expunge(uid);
  }

  async store(uid: number, op: "+" | "-", flags: string[]): Promise<void> {
    if (flags.length) await this.run(`UID STORE ${uid} ${op}FLAGS.SILENT (${flags.join(" ")})`);
  }

  /** Permanently remove one message (only that UID when UIDPLUS is available). */
  async expunge(uid: number): Promise<void> {
    await this.store(uid, "+", ["\\Deleted"]);
    await this.run(this.capabilities.has("UIDPLUS") ? `UID EXPUNGE ${uid}` : "EXPUNGE");
  }

  async close(): Promise<void> {
    try {
      this.writer.releaseLock();
    } catch {
      /* already released */
    }
    await this.socket.close().catch(() => {});
  }
}

export type Connect = (host: string, port: number) => Promise<Socket>;

export interface ImapConfig {
  imapHost: string;
  imapPort: number;
  user: string;
  pass: string;
}

/** Opens a session per call: connect, login, run, logout, close. */
export class ImapClient {
  constructor(
    private readonly cfg: ImapConfig,
    private readonly connect: Connect,
  ) {}

  async session<T>(fn: (s: ImapSession) => Promise<T>): Promise<T> {
    let socket: Socket;
    try {
      socket = await this.connect(this.cfg.imapHost, this.cfg.imapPort);
    } catch (err) {
      throw new MailboxError(`IMAP connect failed: ${(err as Error).message}`, "IMAP_CONNECT");
    }
    const s = new ImapSession(socket);
    try {
      await s.greet();
      await s.login(this.cfg.user, this.cfg.pass);
      const result = await fn(s);
      await s.logout();
      return result;
    } finally {
      await s.close();
    }
  }
}
