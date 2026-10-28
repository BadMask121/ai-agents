/**
 * IMAP wire format (RFC 3501): reading whole responses off a byte stream and
 * parsing them into plain values. No I/O of its own — the reader takes any
 * `{ read() }` source, so tests drive it with recorded server bytes.
 */

/** Atoms and quoted strings are strings, literals keep their bytes, NIL is null. */
export type ImapValue = string | Uint8Array | null | ImapValue[];

export interface ImapResponse {
  /** "*" (untagged), "+" (continuation) or the command tag. */
  tag: string;
  /** Set for status responses (OK/NO/BAD/BYE/PREAUTH). */
  status?: "OK" | "NO" | "BAD" | "BYE" | "PREAUTH";
  /** Human-readable rest of a status/continuation line, e.g. "[UIDVALIDITY 7] Ok". */
  text: string;
  /** Parsed values of a data response, e.g. ["12", "FETCH", [...]] or ["SEARCH", "1", "2"]. */
  values: ImapValue[];
}

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const DQUOTE = 0x22;
const LPAREN = 0x28;
const RPAREN = 0x29;
const BACKSLASH = 0x5c;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const LBRACE = 0x7b;
const RBRACE = 0x7d;

const utf8 = new TextDecoder();
const STATUSES = new Set(["OK", "NO", "BAD", "BYE", "PREAUTH"]);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfCRLF(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
}

/** Size announced by a `{n}` / `{n+}` literal marker ending at `end` (exclusive), or -1. */
function literalSizeBefore(buf: Uint8Array, start: number, end: number): number {
  if (end - 1 < start || buf[end - 1] !== RBRACE) return -1;
  let i = end - 2;
  if (i >= start && buf[i] === 0x2b /* + */) i--;
  const digitsEnd = i + 1;
  while (i >= start && buf[i]! >= 0x30 && buf[i]! <= 0x39) i--;
  if (i < start || buf[i] !== LBRACE || i + 1 === digitsEnd) return -1;
  return Number.parseInt(utf8.decode(buf.subarray(i + 1, digitsEnd)), 10);
}

export interface ByteSource {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
}

/** Splits a byte stream into complete responses: one line plus any literals it announces. */
export class ResponseReader {
  private buf = new Uint8Array(0);

  constructor(private readonly source: ByteSource) {}

  private async fill(): Promise<void> {
    const { value, done } = await this.source.read();
    if (done || !value) throw new Error("IMAP connection closed");
    this.buf = this.buf.length ? concat(this.buf, value) : value;
  }

  async next(): Promise<Uint8Array> {
    let segment = 0; // where the current line segment starts (after any literal)
    for (;;) {
      const eol = indexOfCRLF(this.buf, segment);
      if (eol < 0) {
        await this.fill();
        continue;
      }
      const size = literalSizeBefore(this.buf, segment, eol);
      if (size < 0) {
        const out = this.buf.slice(0, eol + 2);
        this.buf = this.buf.slice(eol + 2);
        return out;
      }
      const literalEnd = eol + 2 + size;
      while (this.buf.length < literalEnd) await this.fill();
      segment = literalEnd;
    }
  }
}

/** Parses values from `buf` starting at `pos` until `)` (when nested) or the end of the line. */
class Parser {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  private peek(): number | undefined {
    return this.buf[this.pos];
  }

  private atEnd(): boolean {
    const c = this.peek();
    return c === undefined || c === CR || c === LF;
  }

  values(nested: boolean): ImapValue[] {
    const out: ImapValue[] = [];
    for (;;) {
      while (this.peek() === SP) this.pos++;
      if (this.atEnd()) {
        if (nested) throw new Error("IMAP parse error: unterminated list");
        return out;
      }
      if (this.peek() === RPAREN) {
        if (!nested) throw new Error("IMAP parse error: unexpected )");
        this.pos++;
        return out;
      }
      out.push(this.value());
    }
  }

  private value(): ImapValue {
    const c = this.peek();
    if (c === LPAREN) {
      this.pos++;
      return this.values(true);
    }
    if (c === DQUOTE) return this.quoted();
    if (c === LBRACE) return this.literal();
    const atom = this.atom();
    return atom.toUpperCase() === "NIL" ? null : atom;
  }

  private quoted(): string {
    this.pos++; // opening quote
    const bytes: number[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === CR) throw new Error("IMAP parse error: unterminated string");
      this.pos++;
      if (c === DQUOTE) break;
      if (c === BACKSLASH) {
        bytes.push(this.buf[this.pos]!);
        this.pos++;
        continue;
      }
      bytes.push(c);
    }
    return utf8.decode(new Uint8Array(bytes));
  }

  private literal(): Uint8Array {
    const close = this.buf.indexOf(RBRACE, this.pos);
    const spec = utf8.decode(this.buf.subarray(this.pos + 1, close)).replace("+", "");
    const size = Number.parseInt(spec, 10);
    const start = close + 3; // skip "}\r\n"
    this.pos = start + size;
    return this.buf.slice(start, start + size);
  }

  /** An atom; brackets are part of it (`BODY[1.2]`, `[UIDNEXT 9]`), spaces inside them too. */
  private atom(): string {
    const start = this.pos;
    let depth = 0;
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === CR || c === LF) break;
      if (c === LBRACKET) depth++;
      else if (c === RBRACKET) depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === SP || c === LPAREN || c === RPAREN)) break;
      this.pos++;
    }
    if (this.pos === start) throw new Error(`IMAP parse error at byte ${start}`);
    return utf8.decode(this.buf.subarray(start, this.pos));
  }

  /** Raw text from the current position to the end of the line. */
  rest(): string {
    while (this.peek() === SP) this.pos++;
    const eol = indexOfCRLF(this.buf, this.pos);
    return utf8.decode(this.buf.subarray(this.pos, eol < 0 ? this.buf.length : eol));
  }

  word(): string {
    while (this.peek() === SP) this.pos++;
    return this.atom();
  }
}

export function parseResponse(raw: Uint8Array): ImapResponse {
  const p = new Parser(raw);
  const tag = p.word();
  if (tag === "+") return { tag, text: p.rest(), values: [] };

  const save = p.pos;
  const second = p.word();
  if (STATUSES.has(second.toUpperCase())) {
    return { tag, status: second.toUpperCase() as ImapResponse["status"], text: p.rest(), values: [] };
  }
  p.pos = save;
  return { tag, text: "", values: p.values(false) };
}

/** Decode a value to text (atoms, quoted strings and literals alike). */
export function asText(v: ImapValue | undefined): string | undefined {
  if (v === null || v === undefined || Array.isArray(v)) return undefined;
  return typeof v === "string" ? v : utf8.decode(v);
}
