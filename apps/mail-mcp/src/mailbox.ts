/**
 * Mail-domain service. Composes the IMAP + SMTP clients and converts raw
 * protocol structures into the trimmed, model-friendly shapes the MCP tools
 * return. This is the single interface the tools depend on — they never touch
 * imapflow/nodemailer directly.
 */
import { simpleParser } from "mailparser";
import { convert as htmlToText } from "html-to-text";
import type { Config } from "./config.js";
import { ImapClient, MailboxError, type SearchCriteria } from "./imap.js";
import { SmtpClient, type OutgoingMessage } from "./smtp.js";
import type { FetchMessageObject } from "imapflow";

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  unseen: number;
  total: number;
}

export interface MessageSummary {
  id: string; // encodeUnique(folder, uid)
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

interface AddressLike {
  name?: string;
  address?: string;
}

function formatAddresses(addrs: AddressLike[] | undefined): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs
    .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? ""))
    .filter(Boolean)
    .join(", ");
}

/** Walk an imapflow bodyStructure node looking for an attachment disposition. */
function structureHasAttachment(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as { disposition?: string; childNodes?: unknown[] };
  if (typeof n.disposition === "string" && n.disposition.toLowerCase() === "attachment") {
    return true;
  }
  if (Array.isArray(n.childNodes)) {
    return n.childNodes.some(structureHasAttachment);
  }
  return false;
}

function toSummary(folder: string, msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope;
  const flags = msg.flags ?? new Set<string>();
  return {
    id: encodeId(folder, msg.uid),
    folder,
    uid: msg.uid,
    from: formatAddresses(env?.from),
    to: formatAddresses(env?.to),
    subject: env?.subject ?? "(no subject)",
    date: env?.date ? new Date(env.date).toISOString() : null,
    unseen: !flags.has("\\Seen"),
    hasAttachments: structureHasAttachment(msg.bodyStructure),
  };
}

export class Mailbox {
  private readonly imap: ImapClient;
  private readonly smtp: SmtpClient;

  constructor(
    private readonly cfg: Config,
    deps?: { imap?: ImapClient; smtp?: SmtpClient },
  ) {
    this.imap = deps?.imap ?? new ImapClient(cfg);
    this.smtp = deps?.smtp ?? new SmtpClient(cfg);
  }

  async listFolders(): Promise<FolderInfo[]> {
    const folders = await this.imap.listFolders();
    const out: FolderInfo[] = [];
    for (const f of folders) {
      let unseen = 0;
      let total = 0;
      try {
        const s = await this.imap.status(f.path);
        unseen = s.unseen;
        total = s.messages;
      } catch {
        /* \Noselect folders etc. — leave counts at 0 */
      }
      out.push({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse,
        unseen,
        total,
      });
    }
    return out;
  }

  async search(
    folder: string,
    criteria: SearchCriteria,
    limit: number,
  ): Promise<MessageSummary[]> {
    const msgs = await this.imap.search(folder, criteria, limit);
    return msgs.map((m) => toSummary(folder, m));
  }

  async listMessages(
    folder: string,
    limit: number,
    offset: number,
  ): Promise<MessageSummary[]> {
    const msgs = await this.imap.listMessages(folder, limit, offset);
    return msgs.map((m) => toSummary(folder, m));
  }

  async read(folder: string, uid: number): Promise<MessageDetail> {
    const source = await this.imap.fetchSource(folder, uid);
    const parsed = await simpleParser(source);

    let body = parsed.text ?? (parsed.html ? htmlToText(parsed.html, { wordwrap: false }) : "");
    let bodyTruncated = false;
    if (Buffer.byteLength(body, "utf8") > this.cfg.maxBodyBytes) {
      body = body.slice(0, this.cfg.maxBodyBytes);
      bodyTruncated = true;
    }

    const attachments: AttachmentEntry[] = parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? `attachment-${index}`,
      mimeType: a.contentType ?? "application/octet-stream",
      size: a.size ?? a.content?.length ?? 0,
    }));

    const toAddr = parsed.to;
    const ccAddr = parsed.cc;
    return {
      id: encodeId(folder, uid),
      folder,
      uid,
      from: parsed.from?.text ?? "",
      to: Array.isArray(toAddr) ? toAddr.map((t) => t.text).join(", ") : toAddr?.text ?? "",
      cc: Array.isArray(ccAddr) ? ccAddr.map((c) => c.text).join(", ") : ccAddr?.text ?? "",
      subject: parsed.subject ?? "(no subject)",
      date: parsed.date ? parsed.date.toISOString() : null,
      messageId: parsed.messageId,
      body,
      bodyTruncated,
      attachments,
    };
  }

  async getAttachment(
    folder: string,
    uid: number,
    index: number,
  ): Promise<{ filename: string; mimeType: string; base64: string; size: number }> {
    const source = await this.imap.fetchSource(folder, uid);
    const parsed = await simpleParser(source);
    const att = parsed.attachments[index];
    if (!att) {
      throw new MailboxError(
        `No attachment at index ${index} for ${folder}/${uid}`,
        "ATTACHMENT_NOT_FOUND",
      );
    }
    const content = att.content ?? Buffer.alloc(0);
    if (content.length > this.cfg.maxAttachmentBytes) {
      throw new MailboxError(
        `Attachment is ${content.length} bytes, exceeds cap of ${this.cfg.maxAttachmentBytes}`,
        "ATTACHMENT_TOO_LARGE",
      );
    }
    return {
      filename: att.filename ?? `attachment-${index}`,
      mimeType: att.contentType ?? "application/octet-stream",
      base64: content.toString("base64"),
      size: content.length,
    };
  }

  async send(msg: OutgoingMessage, replyToId?: string): Promise<{ messageId: string }> {
    let outgoing = msg;
    if (replyToId) {
      const { folder, uid } = decodeId(replyToId);
      const env = await this.imap.envelopeFor(folder, uid);
      const subject =
        msg.subject ||
        (env.subject
          ? env.subject.toLowerCase().startsWith("re:")
            ? env.subject
            : `Re: ${env.subject}`
          : "");
      outgoing = { ...msg, subject, inReplyTo: env.messageId };
    }
    return this.smtp.send(outgoing);
  }

  async move(folder: string, uid: number, target: string): Promise<void> {
    await this.imap.move(folder, uid, target);
  }

  async remove(folder: string, uid: number, permanent: boolean): Promise<void> {
    await this.imap.remove(folder, uid, permanent);
  }

  async mark(
    folder: string,
    uid: number,
    changes: { seen?: boolean; flagged?: boolean },
  ): Promise<void> {
    await this.imap.setFlags(folder, uid, changes);
  }

  async close(): Promise<void> {
    await this.imap.close();
  }
}
