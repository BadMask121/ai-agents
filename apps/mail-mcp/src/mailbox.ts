/**
 * Mail-domain service. Composes the IMAP + SMTP clients and converts raw
 * protocol structures into the trimmed, model-friendly shapes the MCP tools
 * return. This is the single interface the tools depend on.
 *
 * Every method is one IMAP session. Reads fetch only what they need: the body
 * text part for read_email, the one attachment section for get_attachment —
 * never the whole message — so large mail stays cheap on CPU.
 */
import type { Config } from "./config.js";
import {
  ImapClient,
  MailboxError,
  type Address,
  type BodyPart,
  type FetchedMessage,
  type ImapSession,
  type SearchCriteria,
} from "./imap.js";
import { attachments as attachmentParts, textPart } from "./imap/structure.js";
import { bytesToBase64, decodeCharset, decodeTransfer } from "./imap/codec.js";
import { SmtpClient, type OutgoingMessage } from "./smtp.js";
import { htmlToText } from "./text.js";

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  unseen: number;
  total: number;
}

export interface MessageSummary {
  id: string; // encodeId(folder, uid)
  folder: string;
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  unseen: boolean;
  hasAttachments: boolean;
}

export interface AttachmentEntry {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageDetail {
  id: string;
  folder: string;
  uid: number;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string | null;
  messageId?: string;
  body: string;
  bodyTruncated: boolean;
  attachments: AttachmentEntry[];
}

/** Opaque, ChatGPT-safe id round-tripping folder + uid. */
export function encodeId(folder: string, uid: number): string {
  return `${encodeURIComponent(folder)}:${uid}`;
}
export function decodeId(id: string): { folder: string; uid: number } {
  const i = id.lastIndexOf(":");
  if (i < 0) throw new MailboxError(`Malformed id: ${id}`, "BAD_ID");
  const folder = decodeURIComponent(id.slice(0, i));
  const uid = Number.parseInt(id.slice(i + 1), 10);
  if (Number.isNaN(uid)) throw new MailboxError(`Malformed id: ${id}`, "BAD_ID");
  return { folder, uid };
}

function formatAddresses(addrs: Address[] | undefined): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs
    .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? ""))
    .filter(Boolean)
    .join(", ");
}

function attachmentEntries(structure: BodyPart | undefined): AttachmentEntry[] {
  if (!structure) return [];
  return attachmentParts(structure).map((p, index) => ({
    index,
    filename: p.filename ?? `attachment-${index}`,
    mimeType: p.type,
    size: p.size,
  }));
}

function toSummary(folder: string, msg: FetchedMessage): MessageSummary {
  return {
    id: encodeId(folder, msg.uid),
    folder,
    uid: msg.uid,
    from: formatAddresses(msg.envelope.from),
    to: formatAddresses(msg.envelope.to),
    subject: msg.envelope.subject ?? "(no subject)",
    date: msg.envelope.date,
    unseen: !msg.flags.has("\\Seen"),
    hasAttachments: attachmentEntries(msg.structure).length > 0,
  };
}

/** Truncate to a UTF-8 byte budget without splitting a character. */
function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�$/, ""), truncated: true };
}

export class Mailbox {
  private readonly imap: ImapClient;
  private readonly smtp: SmtpClient;

  constructor(
    private readonly cfg: Config,
    deps: { imap: ImapClient; smtp?: SmtpClient },
  ) {
    this.imap = deps.imap;
    this.smtp = deps.smtp ?? new SmtpClient(cfg);
  }

  async listFolders(): Promise<FolderInfo[]> {
    return this.imap.session(async (s) => {
      const out: FolderInfo[] = [];
      for (const f of await s.list()) {
        let counts = { messages: 0, unseen: 0 };
        if (f.selectable) {
          try {
            counts = await s.status(f.path);
          } catch {
            /* leave counts at 0 */
          }
        }
        out.push({ path: f.path, name: f.name, specialUse: f.specialUse, unseen: counts.unseen, total: counts.messages });
      }
      return out;
    });
  }

  async search(folder: string, criteria: SearchCriteria, limit: number): Promise<MessageSummary[]> {
    return this.imap.session(async (s) => {
      await s.open(folder, false);
      const uids = await s.search(criteria);
      if (uids.length === 0) return [];
      const newest = uids.slice(-limit);
      const msgs = await s.fetchSummaries(newest.join(","), true);
      return msgs.sort((a, b) => b.uid - a.uid).map((m) => toSummary(folder, m));
    });
  }

  /** Newest-first page of a folder using sequence numbers (cheap, bounded). */
  async listMessages(folder: string, limit: number, offset: number): Promise<MessageSummary[]> {
    return this.imap.session(async (s) => {
      await s.open(folder, false);
      const total = s.exists;
      if (!total) return [];
      const end = total - offset;
      if (end < 1) return [];
      const start = Math.max(1, end - limit + 1);
      const msgs = await s.fetchSummaries(`${start}:${end}`, false);
      return msgs.sort((a, b) => b.uid - a.uid).map((m) => toSummary(folder, m));
    });
  }

  async read(folder: string, uid: number): Promise<MessageDetail> {
    return this.imap.session(async (s) => {
      await s.open(folder, false);
      const msg = await s.fetchOne(uid);
      const env = msg.envelope;
      const body = msg.structure ? await this.bodyText(s, uid, msg.structure) : { text: "", truncated: false };
      return {
        id: encodeId(folder, uid),
        folder,
        uid,
        from: formatAddresses(env.from),
        to: formatAddresses(env.to),
        cc: formatAddresses(env.cc),
        subject: env.subject ?? "(no subject)",
        date: env.date,
        messageId: env.messageId,
        body: body.text,
        bodyTruncated: body.truncated,
        attachments: attachmentEntries(msg.structure),
      };
    });
  }

  /** Fetch and decode just the body part; cap before any HTML conversion. */
  private async bodyText(s: ImapSession, uid: number, structure: BodyPart): Promise<{ text: string; truncated: boolean }> {
    const part = textPart(structure);
    if (!part) return { text: "", truncated: false };
    const raw = decodeTransfer(await s.fetchSection(uid, part.section), part.encoding);
    // HTML carries more markup than text; give it room before converting.
    const budget = part.type === "text/html" ? this.cfg.maxBodyBytes * 4 : this.cfg.maxBodyBytes;
    const clipped = raw.length > budget ? raw.subarray(0, budget) : raw;
    let text = decodeCharset(clipped, part.params.charset);
    if (part.type === "text/html") text = htmlToText(text);
    const out = truncateBytes(text, this.cfg.maxBodyBytes);
    return { text: out.text, truncated: out.truncated || raw.length > budget };
  }

  async getAttachment(
    folder: string,
    uid: number,
    index: number,
  ): Promise<{ filename: string; mimeType: string; base64: string; size: number }> {
    return this.imap.session(async (s) => {
      await s.open(folder, false);
      const msg = await s.fetchOne(uid);
      const part = msg.structure ? attachmentParts(msg.structure)[index] : undefined;
      if (!part) {
        throw new MailboxError(`No attachment at index ${index} for ${folder}/${uid}`, "ATTACHMENT_NOT_FOUND");
      }
      // part.size is the encoded size; base64 is ~4/3 of the bytes.
      const estimate = part.encoding === "base64" ? Math.floor((part.size * 3) / 4) : part.size;
      if (estimate > this.cfg.maxAttachmentBytes) {
        throw new MailboxError(
          `Attachment is about ${estimate} bytes, exceeds cap of ${this.cfg.maxAttachmentBytes}`,
          "ATTACHMENT_TOO_LARGE",
        );
      }
      const raw = await s.fetchSection(uid, part.section);
      const meta = { filename: part.filename ?? `attachment-${index}`, mimeType: part.type };
      if (part.encoding === "base64") {
        // Already base64 on the wire: hand it over without decoding and re-encoding.
        const base64 = new TextDecoder().decode(raw).replace(/[^A-Za-z0-9+/=]/g, "");
        return { ...meta, base64, size: Math.floor((base64.replace(/=+$/, "").length * 3) / 4) };
      }
      const bytes = decodeTransfer(raw, part.encoding);
      return { ...meta, base64: bytesToBase64(bytes), size: bytes.length };
    });
  }

  async send(msg: OutgoingMessage, replyToId?: string): Promise<{ messageId: string }> {
    let outgoing = msg;
    if (replyToId) {
      const { folder, uid } = decodeId(replyToId);
      const env = await this.imap.session(async (s) => {
        await s.open(folder, false);
        return (await s.fetchOne(uid)).envelope;
      });
      const subject =
        msg.subject ||
        (env.subject ? (env.subject.toLowerCase().startsWith("re:") ? env.subject : `Re: ${env.subject}`) : "");
      outgoing = { ...msg, subject, inReplyTo: env.messageId };
    }
    return this.smtp.send(outgoing);
  }

  async move(folder: string, uid: number, target: string): Promise<void> {
    await this.imap.session(async (s) => {
      await s.open(folder, true);
      await s.move(uid, target);
    });
  }

  async remove(folder: string, uid: number, permanent: boolean): Promise<void> {
    await this.imap.session(async (s) => {
      const folders = await s.list();
      const trash = folders.find((f) => f.specialUse === "\\Trash")?.path ?? "Trash";
      await s.open(folder, true);
      // Already in Trash: a non-permanent delete there is a permanent expunge.
      if (permanent || trash === folder) await s.expunge(uid);
      else await s.move(uid, trash);
    });
  }

  async mark(folder: string, uid: number, changes: { seen?: boolean; flagged?: boolean }): Promise<void> {
    const add: string[] = [];
    const remove: string[] = [];
    if (changes.seen === true) add.push("\\Seen");
    if (changes.seen === false) remove.push("\\Seen");
    if (changes.flagged === true) add.push("\\Flagged");
    if (changes.flagged === false) remove.push("\\Flagged");
    await this.imap.session(async (s) => {
      await s.open(folder, true);
      await s.store(uid, "+", add);
      await s.store(uid, "-", remove);
    });
  }
}
