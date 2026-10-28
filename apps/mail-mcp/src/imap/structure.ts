/**
 * ENVELOPE and BODYSTRUCTURE (RFC 3501 7.4.2) as plain objects, plus the two
 * questions mail-mcp asks of a structure: which part is the readable body,
 * and which parts are attachments. Lets read_email / get_attachment fetch one
 * section instead of the whole message.
 */
import { asText, type ImapValue } from "./protocol.js";
import { decodeEncodedWords, decodeRfc2231 } from "./codec.js";

export interface Address {
  name?: string;
  address?: string;
}

export interface Envelope {
  date: string | null;
  subject?: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  messageId?: string;
}

export interface BodyPart {
  /** IMAP section number, e.g. "1", "2.1". */
  section: string;
  /** Lower-case MIME type, e.g. "text/plain", "multipart/mixed". */
  type: string;
  params: Record<string, string>;
  encoding: string;
  size: number;
  disposition?: string;
  filename?: string;
  parts?: BodyPart[];
}

const list = (v: ImapValue | undefined): ImapValue[] => (Array.isArray(v) ? v : []);
const lower = (v: ImapValue | undefined) => (asText(v) ?? "").toLowerCase();

function headerText(v: ImapValue | undefined): string | undefined {
  const t = asText(v);
  return t === undefined ? undefined : decodeEncodedWords(t);
}

function addresses(v: ImapValue | undefined): Address[] {
  return list(v)
    .filter(Array.isArray)
    .map((a) => {
      const [name, , mailbox, host] = a as ImapValue[];
      const local = asText(mailbox);
      const domain = asText(host);
      return {
        name: headerText(name),
        address: local && domain ? `${local}@${domain}` : local,
      };
    })
    .filter((a) => a.address || a.name);
}

export function parseEnvelope(v: ImapValue | undefined): Envelope {
  const e = list(v);
  const date = asText(e[0]);
  const parsed = date ? new Date(date) : null;
  return {
    date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    subject: headerText(e[1]),
    from: addresses(e[2]),
    to: addresses(e[5]),
    cc: addresses(e[6]),
    messageId: asText(e[9]),
  };
}

/** ("name" "value" "name2" "value2") → { name: value, ... }, names lower-cased. */
function paramMap(v: ImapValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const items = list(v);
  for (let i = 0; i + 1 < items.length; i += 2) {
    const k = asText(items[i]);
    const val = asText(items[i + 1]);
    if (k && val !== undefined) out[k.toLowerCase()] = val;
  }
  return out;
}

function filenameFrom(...maps: Record<string, string>[]): string | undefined {
  for (const m of maps) {
    if (m["filename*"]) return decodeRfc2231(m["filename*"]);
    if (m["name*"]) return decodeRfc2231(m["name*"]);
    if (m.filename) return decodeEncodedWords(m.filename);
    if (m.name) return decodeEncodedWords(m.name);
  }
  return undefined;
}

/** Disposition is a list: ("attachment" ("filename" "a.pdf")). */
function disposition(v: ImapValue | undefined): { kind?: string; params: Record<string, string> } {
  const d = list(v);
  return { kind: asText(d[0])?.toLowerCase(), params: paramMap(d[1]) };
}

export function parseBodyStructure(v: ImapValue | undefined, section = ""): BodyPart {
  const b = list(v);

  if (Array.isArray(b[0])) {
    // multipart: child bodies, then subtype, then [params disposition language location]
    let i = 0;
    const parts: BodyPart[] = [];
    while (Array.isArray(b[i])) {
      const child = section ? `${section}.${i + 1}` : `${i + 1}`;
      parts.push(parseBodyStructure(b[i], child));
      i++;
    }
    const subtype = lower(b[i]);
    const params = paramMap(b[i + 1]);
    const disp = disposition(b[i + 2]);
    return {
      section: section || "TEXT",
      type: `multipart/${subtype}`,
      params,
      encoding: "7bit",
      size: 0,
      disposition: disp.kind,
      parts,
    };
  }

  // single part: type subtype params id description encoding size [type-specific] [md5 disposition ...]
  const type = `${lower(b[0])}/${lower(b[1])}`;
  const params = paramMap(b[2]);
  let ext = 7; // index after size
  if (type.startsWith("text/")) ext = 8; // + lines
  else if (type === "message/rfc822") ext = 10; // + envelope, body, lines
  const disp = disposition(b[ext + 1]);
  return {
    section: section || "1",
    type,
    params,
    encoding: lower(b[5]) || "7bit",
    size: Number.parseInt(asText(b[6]) ?? "0", 10) || 0,
    disposition: disp.kind,
    filename: filenameFrom(disp.params, params),
  };
}

/** Leaf (non-multipart) parts in depth-first order. */
export function leaves(root: BodyPart): BodyPart[] {
  return root.parts ? root.parts.flatMap(leaves) : [root];
}

function isBodyCandidate(p: BodyPart): boolean {
  return p.disposition !== "attachment" && !p.filename && (p.type === "text/plain" || p.type === "text/html");
}

/** The part to show as the message body: plain text first, else HTML. */
export function textPart(root: BodyPart): BodyPart | undefined {
  const candidates = leaves(root).filter(isBodyCandidate);
  return candidates.find((p) => p.type === "text/plain") ?? candidates.find((p) => p.type === "text/html");
}

/** Everything that isn't readable body text, in a stable order (indexes are
 * what read_email lists and get_attachment takes). */
export function attachments(root: BodyPart): BodyPart[] {
  return leaves(root).filter((p) => !isBodyCandidate(p));
}
