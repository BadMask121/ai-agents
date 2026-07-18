/**
 * Thin, MCP-agnostic wrapper around imapflow.
 *
 * Owns a single long-lived IMAP connection and re-establishes it on demand.
 * Every operation grabs a per-mailbox lock (imapflow serializes these), so
 * concurrent tool calls are safe. Returns raw imapflow structures — shaping for
 * the model happens one layer up in mailbox.ts.
 */
import { ImapFlow, type FetchMessageObject, type ListResponse } from "imapflow";
import type { Config } from "./config.js";

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  unseen?: boolean;
}

export class MailboxError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MailboxError";
  }
}

export class ImapClient {
  private client: ImapFlow | null = null;

  constructor(private readonly cfg: Config) {}

  /** Lazily connect; recreate the client if the previous one is no longer usable. */
  private async connection(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client;

    // Drop a dead client before replacing it.
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* already gone */
      }
      this.client = null;
    }

    const client = new ImapFlow({
      host: this.cfg.imapHost,
      port: this.cfg.imapPort,
      secure: true,
      auth: { user: this.cfg.user, pass: this.cfg.pass },
      logger: false,
      // Fail fast instead of hanging a tool call forever.
      socketTimeout: 60_000,
      greetingTimeout: 15_000,
    });
    client.on("error", () => {
      // Swallow: next call re-checks `usable` and reconnects.
    });
    try {
      await client.connect();
    } catch (err) {
      throw new MailboxError(
        `IMAP connect/auth failed: ${(err as Error).message}`,
        "IMAP_CONNECT",
      );
    }
    this.client = client;
    return client;
  }

  /** Run `fn` while holding the lock on `folder`. Reconnects once on a dropped socket. */
  private async withFolder<T>(
    folder: string,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await this.connection();
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (/no such|not exist|nonexistent/i.test(msg)) {
          throw new MailboxError(`Folder not found: ${folder}`, "FOLDER_NOT_FOUND");
        }
        // Connection likely dead — force a reconnect and retry once.
        if (attempt === 0) {
          this.client = null;
          continue;
        }
        throw new MailboxError(`Cannot open folder ${folder}: ${msg}`, "FOLDER_OPEN");
      }
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    }
    // Unreachable — the loop either returns or throws.
    throw new MailboxError("IMAP operation failed after retry", "IMAP_RETRY");
  }

  async listFolders(): Promise<ListResponse[]> {
    const client = await this.connection();
    return client.list();
  }

  /** Return the path of a special-use mailbox (e.g. "\\Trash"), or a fallback. */
  async specialFolder(use: string, fallback: string): Promise<string> {
    const folders = await this.listFolders();
    const match = folders.find((f) => f.specialUse === use);
    return match?.path ?? fallback;
  }

  async status(folder: string): Promise<{ messages: number; unseen: number }> {
    const client = await this.connection();
    const s = await client.status(folder, { messages: true, unseen: true });
    return { messages: s.messages ?? 0, unseen: s.unseen ?? 0 };
  }

  /** UID-based search; returns the newest `limit` matches as full fetch objects. */
  async search(
    folder: string,
    criteria: SearchCriteria,
    limit: number,
  ): Promise<FetchMessageObject[]> {
    return this.withFolder(folder, async (client) => {
      const query: Record<string, unknown> = {};
      if (criteria.from) query.from = criteria.from;
      if (criteria.to) query.to = criteria.to;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.text) query.text = criteria.text;
      if (criteria.since) query.since = criteria.since;
      if (criteria.before) query.before = criteria.before;
      if (criteria.unseen) query.seen = false;
      if (Object.keys(query).length === 0) query.all = true;

      const uids = (await client.search(query, { uid: true })) || [];
      if (uids.length === 0) return [];
      const newest = uids.slice(-limit);
      return this.fetchSummaries(client, newest);
    });
  }

  /** Newest-first page of a folder using sequence numbers (cheap, bounded). */
  async listMessages(
    folder: string,
    limit: number,
    offset: number,
  ): Promise<FetchMessageObject[]> {
    return this.withFolder(folder, async (client) => {
      const total = client.mailbox && typeof client.mailbox === "object"
        ? client.mailbox.exists
        : 0;
      if (!total) return [];
      const end = Math.max(1, total - offset);
      const start = Math.max(1, end - limit + 1);
      if (end < 1 || start > end) return [];
      const out: FetchMessageObject[] = [];
      for await (const msg of client.fetch(
        `${start}:${end}`,
        { uid: true, envelope: true, flags: true, bodyStructure: true },
      )) {
        out.push(msg);
      }
      return out.reverse(); // newest first
    });
  }

  private async fetchSummaries(
    client: ImapFlow,
    uids: number[],
  ): Promise<FetchMessageObject[]> {
    const out: FetchMessageObject[] = [];
    for await (const msg of client.fetch(
      uids.join(","),
      { uid: true, envelope: true, flags: true, bodyStructure: true },
      { uid: true },
    )) {
      out.push(msg);
    }
    return out.reverse();
  }

  /** Raw RFC822 source for a single message, for parsing bodies/attachments. */
  async fetchSource(folder: string, uid: number): Promise<Buffer> {
    return this.withFolder(folder, async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) {
        throw new MailboxError(`Message not found: ${folder}/${uid}`, "UID_NOT_FOUND");
      }
      return msg.source;
    });
  }

  async move(folder: string, uid: number, target: string): Promise<void> {
    await this.withFolder(folder, async (client) => {
      await client.messageMove(String(uid), target, { uid: true });
    });
  }

  async remove(folder: string, uid: number, permanent: boolean): Promise<void> {
    if (permanent) {
      await this.withFolder(folder, async (client) => {
        await client.messageDelete(String(uid), { uid: true });
      });
      return;
    }
    const trash = await this.specialFolder("\\Trash", "Trash");
    if (trash === folder) {
      // Already in Trash — a non-permanent delete there is a permanent expunge.
      await this.withFolder(folder, async (client) => {
        await client.messageDelete(String(uid), { uid: true });
      });
      return;
    }
    await this.move(folder, uid, trash);
  }

  async setFlags(
    folder: string,
    uid: number,
    changes: { seen?: boolean; flagged?: boolean },
  ): Promise<void> {
    await this.withFolder(folder, async (client) => {
      const add: string[] = [];
      const remove: string[] = [];
      if (changes.seen === true) add.push("\\Seen");
      if (changes.seen === false) remove.push("\\Seen");
      if (changes.flagged === true) add.push("\\Flagged");
      if (changes.flagged === false) remove.push("\\Flagged");
      if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
    });
  }

  /** Look up Message-ID + subject for reply threading. */
  async envelopeFor(
    folder: string,
    uid: number,
  ): Promise<{ messageId?: string; subject?: string }> {
    return this.withFolder(folder, async (client) => {
      const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
      if (!msg) throw new MailboxError(`Message not found: ${folder}/${uid}`, "UID_NOT_FOUND");
      return { messageId: msg.envelope?.messageId, subject: msg.envelope?.subject };
    });
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }
}
