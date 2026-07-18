/**
 * MCP tool registration. Each tool validates its input (zod), calls the Mailbox
 * service, and returns a JSON text result. Handlers stay thin — all mail logic
 * lives in Mailbox.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Mailbox, decodeId, type MessageSummary } from "../mailbox.js";
import { MailboxError } from "../imap.js";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const message =
    err instanceof MailboxError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wrap a handler so thrown errors become clean MCP error results, never stacks. */
function guard<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

function parseDate(s: string | undefined, field: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new MailboxError(`Invalid ${field} date: ${s}`, "BAD_DATE");
  return d;
}

export function registerTools(server: McpServer, mailbox: Mailbox): void {
  // ---- list_folders ---------------------------------------------------------
  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description: "List all mailbox folders with their unread and total message counts.",
      inputSchema: {},
    },
    guard(async () => ok(await mailbox.listFolders())),
  );

  // ---- search_email ---------------------------------------------------------
  server.registerTool(
    "search_email",
    {
      title: "Search email",
      description:
        "Search a folder by any combination of sender, recipient, subject, free text, " +
        "date range, and unread status. Returns newest matches first as summaries.",
      inputSchema: {
        folder: z.string().default("INBOX").describe("Folder to search, e.g. INBOX"),
        from: z.string().optional().describe("Match sender contains"),
        to: z.string().optional().describe("Match recipient contains"),
        subject: z.string().optional().describe("Match subject contains"),
        text: z.string().optional().describe("Match anywhere in headers/body"),
        since: z.string().optional().describe("On/after this date (ISO or YYYY-MM-DD)"),
        before: z.string().optional().describe("Before this date (ISO or YYYY-MM-DD)"),
        unseen: z.boolean().optional().describe("Only unread messages"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    guard(async (a: {
      folder: string;
      from?: string;
      to?: string;
      subject?: string;
      text?: string;
      since?: string;
      before?: string;
      unseen?: boolean;
      limit: number;
    }) => {
      const results = await mailbox.search(
        a.folder,
        {
          from: a.from,
          to: a.to,
          subject: a.subject,
          text: a.text,
          since: parseDate(a.since, "since"),
          before: parseDate(a.before, "before"),
          unseen: a.unseen,
        },
        a.limit,
      );
      return ok({ count: results.length, messages: results });
    }),
  );

  // ---- list_messages --------------------------------------------------------
  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      description: "List recent messages in a folder, newest first. Page with `offset`.",
      inputSchema: {
        folder: z.string().default("INBOX"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0).describe("Skip this many from newest"),
      },
    },
    guard(async (a: { folder: string; limit: number; offset: number }) => {
      const results = await mailbox.listMessages(a.folder, a.limit, a.offset);
      return ok({ count: results.length, messages: results });
    }),
  );

  // ---- read_email -----------------------------------------------------------
  server.registerTool(
    "read_email",
    {
      title: "Read email",
      description:
        "Fetch a full message by folder + UID: headers, plain-text body (HTML converted), " +
        "and an attachment manifest. Use get_attachment to retrieve attachment bytes.",
      inputSchema: {
        folder: z.string().default("INBOX"),
        uid: z.number().int().positive(),
      },
    },
    guard(async (a: { folder: string; uid: number }) => ok(await mailbox.read(a.folder, a.uid))),
  );

  // ---- get_attachment -------------------------------------------------------
  server.registerTool(
    "get_attachment",
    {
      title: "Get attachment",
      description:
        "Return one attachment's bytes (base64) by folder + UID + attachment index " +
        "(index comes from read_email's manifest). Size-capped.",
      inputSchema: {
        folder: z.string().default("INBOX"),
        uid: z.number().int().positive(),
        index: z.number().int().min(0),
      },
    },
    guard(async (a: { folder: string; uid: number; index: number }) =>
      ok(await mailbox.getAttachment(a.folder, a.uid, a.index)),
    ),
  );

  // ---- send_email -----------------------------------------------------------
  server.registerTool(
    "send_email",
    {
      title: "Send email",
      description:
        "Send a plain-text email. To reply within a thread, pass reply_to_id (an id from " +
        "search/read); subject and threading headers are filled in automatically.",
      inputSchema: {
        to: z.array(z.string()).min(1).describe("Recipient addresses"),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string().default(""),
        body: z.string(),
        reply_to_id: z.string().optional().describe("id of the message being replied to"),
      },
    },
    guard(async (a: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
      reply_to_id?: string;
    }) => {
      const res = await mailbox.send(
        { to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, body: a.body },
        a.reply_to_id,
      );
      return ok({ sent: true, messageId: res.messageId });
    }),
  );

  // ---- move_email -----------------------------------------------------------
  server.registerTool(
    "move_email",
    {
      title: "Move email",
      description: "Move a message to another folder.",
      inputSchema: {
        folder: z.string(),
        uid: z.number().int().positive(),
        target_folder: z.string(),
      },
    },
    guard(async (a: { folder: string; uid: number; target_folder: string }) => {
      await mailbox.move(a.folder, a.uid, a.target_folder);
      return ok({ moved: true });
    }),
  );

  // ---- delete_email ---------------------------------------------------------
  server.registerTool(
    "delete_email",
    {
      title: "Delete email",
      description:
        "Delete a message. By default moves it to Trash; set permanent=true to expunge it.",
      inputSchema: {
        folder: z.string(),
        uid: z.number().int().positive(),
        permanent: z.boolean().default(false),
      },
    },
    guard(async (a: { folder: string; uid: number; permanent: boolean }) => {
      await mailbox.remove(a.folder, a.uid, a.permanent);
      return ok({ deleted: true, permanent: a.permanent });
    }),
  );

  // ---- mark_email -----------------------------------------------------------
  server.registerTool(
    "mark_email",
    {
      title: "Mark email",
      description: "Set read/unread (seen) and/or flagged state on a message.",
      inputSchema: {
        folder: z.string(),
        uid: z.number().int().positive(),
        seen: z.boolean().optional(),
        flagged: z.boolean().optional(),
      },
    },
    guard(async (a: { folder: string; uid: number; seen?: boolean; flagged?: boolean }) => {
      await mailbox.mark(a.folder, a.uid, { seen: a.seen, flagged: a.flagged });
      return ok({ updated: true });
    }),
  );

  // ---- ChatGPT standard aliases: search + fetch (read-only) ------------------
  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Full-text search across the inbox. Returns {results:[{id,title,url}]} for use " +
        "with fetch. (Standard ChatGPT connector / Deep Research compatibility.)",
      inputSchema: { query: z.string() },
    },
    guard(async (a: { query: string }) => {
      const msgs: MessageSummary[] = await mailbox.search("INBOX", { text: a.query }, 20);
      const results = msgs.map((m) => ({
        id: m.id,
        title: `${m.subject} — ${m.from}`,
        url: "https://privateemail.com/appsuite/#!!&app=io.ox/mail",
      }));
      return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
    }),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch",
      description:
        "Fetch a single message's full content by id (from search). Returns " +
        "{id,title,text,url,metadata}. (Standard ChatGPT connector / Deep Research.)",
      inputSchema: { id: z.string() },
    },
    guard(async (a: { id: string }) => {
      const { folder, uid } = decodeId(a.id);
      const msg = await mailbox.read(folder, uid);
      const doc = {
        id: a.id,
        title: msg.subject,
        text:
          `From: ${msg.from}\nTo: ${msg.to}\nDate: ${msg.date ?? ""}\n` +
          `Subject: ${msg.subject}\n\n${msg.body}`,
        url: "https://privateemail.com/appsuite/#!!&app=io.ox/mail",
        metadata: {
          folder: msg.folder,
          uid: String(msg.uid),
          hasAttachments: String(msg.attachments.length > 0),
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(doc) }] };
    }),
  );
}
