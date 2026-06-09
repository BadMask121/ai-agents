import { google, type gmail_v1 } from "googleapis";
import { makeOAuthClient } from "./oauthClient.js";
import type { GoogleAccount } from "./accounts.js";

/** A new inbound email, parsed into the fields the rest of the app needs. */
export type ParsedEmail = {
  id: string;
  threadId: string;
  /** Raw From header, e.g. `Jane Doe <jane@x.com>`. */
  from: string;
  fromName: string | null;
  fromEmail: string;
  subject: string;
  /** RFC `Message-ID` header — needed for In-Reply-To threading. */
  messageIdHeader: string | null;
  references: string | null;
  date: string | null;
  body: string;
  snippet: string;
  /** Which connected account received this message. */
  accountEmail: string;
};

/** Label the bot applies to every message it has handled (dedup back-stop). */
export const SEEN_LABEL = "booking-ops/seen";

function gmailClient(account: GoogleAccount): gmail_v1.Gmail {
  const auth = makeOAuthClient(account.refreshToken);
  return google.gmail({ version: "v1", auth });
}

/**
 * List unread inbox messages worth considering. `-from:me` avoids re-triggering
 * on our own sent replies; `newer_than:7d` bounds the scan. Returns message ids.
 */
export async function listUnread(account: GoogleAccount): Promise<string[]> {
  const gmail = gmailClient(account);
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread newer_than:7d label:INBOX -from:me",
    maxResults: 25,
  });
  return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
}

/** Fetch + parse a single message into a ParsedEmail. */
export async function getMessage(
  account: GoogleAccount,
  id: string,
): Promise<ParsedEmail> {
  const gmail = gmailClient(account);
  const res = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  const msg = res.data;
  const headers = msg.payload?.headers ?? [];
  const h = (name: string) =>
    headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ??
    null;

  const from = h("From") ?? "";
  const { name, email } = parseAddress(from);

  return {
    id: msg.id!,
    threadId: msg.threadId!,
    from,
    fromName: name,
    fromEmail: email,
    subject: h("Subject") ?? "(no subject)",
    messageIdHeader: h("Message-ID") ?? h("Message-Id"),
    references: h("References"),
    date: h("Date"),
    body: extractBody(msg.payload),
    snippet: msg.snippet ?? "",
    accountEmail: account.email,
  };
}

/**
 * Send a reply that threads correctly in BOTH Gmail (via threadId) and the
 * client's mail app (via In-Reply-To / References headers).
 */
export async function sendReply(
  account: GoogleAccount,
  reply: {
    to: string;
    subject: string;
    bodyText: string;
    threadId: string;
    inReplyTo: string | null;
    references: string | null;
  },
): Promise<{ id: string; threadId: string }> {
  const gmail = gmailClient(account);
  const subject = reply.subject.toLowerCase().startsWith("re:")
    ? reply.subject
    : `Re: ${reply.subject}`;

  const refs = [reply.references, reply.inReplyTo]
    .filter(Boolean)
    .join(" ")
    .trim();

  const headerLines = [
    `From: ${account.email}`,
    `To: ${reply.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ];
  if (reply.inReplyTo) headerLines.push(`In-Reply-To: ${reply.inReplyTo}`);
  if (refs) headerLines.push(`References: ${refs}`);

  const raw = `${headerLines.join("\r\n")}\r\n\r\n${reply.bodyText}`;
  const encoded = Buffer.from(raw, "utf-8").toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, threadId: reply.threadId },
  });
  return { id: res.data.id!, threadId: res.data.threadId! };
}

/** Ensure the seen-label exists; return its id (cached per account in memory). */
const labelCache = new Map<string, string>();
export async function ensureSeenLabel(account: GoogleAccount): Promise<string> {
  const cacheKey = account.email;
  const cached = labelCache.get(cacheKey);
  if (cached) return cached;

  const gmail = gmailClient(account);
  const existing = await gmail.users.labels.list({ userId: "me" });
  const found = existing.data.labels?.find((l) => l.name === SEEN_LABEL);
  if (found?.id) {
    labelCache.set(cacheKey, found.id);
    return found.id;
  }
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: SEEN_LABEL,
      labelListVisibility: "labelHide",
      messageListVisibility: "hide",
    },
  });
  const id = created.data.id!;
  labelCache.set(cacheKey, id);
  return id;
}

/** Mark a message handled: apply the seen label (and optionally mark read). */
export async function markHandled(
  account: GoogleAccount,
  messageId: string,
  opts: { markRead?: boolean } = {},
): Promise<void> {
  const gmail = gmailClient(account);
  const labelId = await ensureSeenLabel(account);
  const removeLabelIds = opts.markRead ? ["UNREAD"] : [];
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId], removeLabelIds },
  });
}

/** True if the message already carries our seen-label (dedup back-stop). */
export async function hasSeenLabel(
  account: GoogleAccount,
  messageId: string,
): Promise<boolean> {
  const gmail = gmailClient(account);
  const labelId = await ensureSeenLabel(account);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "minimal",
  });
  return (res.data.labelIds ?? []).includes(labelId);
}

// ─── parsing helpers ────────────────────────────────────────────────

/** Parse a `Name <email>` (or bare email) address header. */
export function parseAddress(value: string): {
  name: string | null;
  email: string;
} {
  const match = value.match(/^\s*(?:"?([^"<]*)"?\s)?<?([^<>\s]+@[^<>\s]+)>?/);
  if (!match) return { name: null, email: value.trim().toLowerCase() };
  const name = match[1]?.trim() || null;
  const email = (match[2] ?? "").trim().toLowerCase();
  return { name, email };
}

/** Walk the MIME tree for a text/plain body, falling back to stripped HTML. */
function extractBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain) return decodePart(plain);
  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodePart(html));
  // Single-part message with the body on the root.
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function findPart(
  part: gmail_v1.Schema$MessagePart,
  mimeType: string,
): gmail_v1.Schema$MessagePart | null {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function decodePart(part: gmail_v1.Schema$MessagePart): string {
  return part.body?.data ? decodeBase64Url(part.body.data) : "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
