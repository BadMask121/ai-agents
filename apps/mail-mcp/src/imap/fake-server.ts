/**
 * Test helper: a scripted IMAP server behind a fake socket. Each step checks
 * the command the client sent and replies with recorded response text
 * (`$TAG` is replaced by the command's tag). Replies are delivered in small
 * chunks so tests exercise response reassembly too.
 */
import type { Connect, Socket } from "./session.js";

export interface Step {
  expect: RegExp;
  reply: string | ((tag: string) => Uint8Array);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const GREETING = "* OK [CAPABILITY IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN] Dovecot ready.\r\n";
export const LOGIN_OK = "$TAG OK [CAPABILITY IMAP4rev1 LITERAL+ MOVE UIDPLUS CHILDREN] Logged in\r\n";

/** The standard opening: greeting, then a LOGIN that succeeds. */
export const login: Step = { expect: /^A\d+ LOGIN "me@example.com" "secret"\r\n$/, reply: LOGIN_OK };
export const logout: Step = { expect: /^A\d+ LOGOUT\r\n$/, reply: "* BYE Logging out\r\n$TAG OK Logout completed.\r\n" };

export function scripted(steps: Step[], chunkSize = 7): { connect: Connect; sent: string[]; remaining: () => number } {
  const queue = [...steps];
  const sent: string[] = [];
  const connect: Connect = async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const push = (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    };
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        push(enc.encode(GREETING));
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const line = dec.decode(chunk);
        sent.push(line);
        const step = queue.shift();
        if (!step) throw new Error(`unexpected command: ${line}`);
        if (!step.expect.test(line)) throw new Error(`expected ${step.expect} but got ${JSON.stringify(line)}`);
        const tag = line.split(" ")[0]!;
        const reply = typeof step.reply === "string" ? enc.encode(step.reply.replaceAll("$TAG", tag)) : step.reply(tag);
        push(reply);
      },
    });
    const socket: Socket = { readable, writable, close: async () => {} };
    return socket;
  };
  return { connect, sent, remaining: () => queue.length };
}

/** A FETCH response carrying a literal: `* 1 FETCH (UID 7 BODY[1] {n}\r\n<bytes>)`. */
export function literalFetch(uid: number, section: string, body: string | Uint8Array): (tag: string) => Uint8Array {
  const bytes = typeof body === "string" ? enc.encode(body) : body;
  return (tag) => {
    const head = enc.encode(`* 1 FETCH (UID ${uid} BODY[${section}] {${bytes.length}}\r\n`);
    const tail = enc.encode(`)\r\n${tag} OK Fetch completed.\r\n`);
    const out = new Uint8Array(head.length + bytes.length + tail.length);
    out.set(head, 0);
    out.set(bytes, head.length);
    out.set(tail, head.length + bytes.length);
    return out;
  };
}

/** Recorded Dovecot shapes shared by the tests. multipart/mixed: (alternative: text 1.1, html 1.2), pdf 2. */
export const MIXED =
  '((("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 30 2 NIL NIL NIL NIL)' +
  '("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 60 3 NIL NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "alt") NIL NIL NIL)' +
  '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 20 NIL ("ATTACHMENT" ("FILENAME" "report.pdf")) NIL NIL)' +
  ' "MIXED" ("BOUNDARY" "mix") NIL NIL NIL)';

export const ENVELOPE =
  '("Mon, 1 Jan 2024 10:00:00 +0000" "=?UTF-8?B?SMOpbGxv?= there" (("Alice" NIL "alice" "example.com"))' +
  ' (("Alice" NIL "alice" "example.com")) (("Alice" NIL "alice" "example.com")) ((NIL NIL "bob" "example.com"))' +
  ' (("=?UTF-8?Q?Caf=C3=A9?=" NIL "cafe" "example.org")) NIL NIL "<orig@example.com>")';
