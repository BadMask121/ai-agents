import { loadConfig } from "../config.js";
import { logger } from "../lib/log.js";
import { p } from "../paths.js";
import { readText } from "../lib/atomicWrite.js";
import { listAccounts } from "../google/accounts.js";
import { listUnread, getMessage, markHandled } from "../google/gmail.js";
import { isProcessed, markProcessed } from "../crm/dedup.js";
import { isSuppressed } from "../crm/suppression.js";
import {
  loadOrCreateClient,
  appendMessage,
  mergeBookingFacts,
  mutateClient,
} from "../crm/store.js";
import { createAction, updateAction } from "../crm/actions.js";
import { draftReply } from "../agent/draft.js";
import { toModelFacts } from "../agent/schema.js";
import { upsertContact, sendEvent } from "../loops/client.js";
import { sendDraftAlert, notify } from "../telegram/alerts.js";
import { computeAvailability } from "./availability.js";

const log = logger("inbound");

/** Confidence floor for treating a classified booking email as a real lead. */
const LEAD_CONFIDENCE = 0.6;

/**
 * One Gmail poll cycle across all connected accounts. Safe to call on an
 * interval — dedup + the Gmail seen-label make handling idempotent.
 */
export async function pollInbound(): Promise<void> {
  const accounts = await listAccounts();
  if (accounts.length === 0) return;

  const cfg = loadConfig();
  const [context, packages] = await Promise.all([
    readText(p.context, ""),
    readText(p.packages, ""),
  ]);

  for (const account of accounts) {
    let ids: string[];
    try {
      ids = await listUnread(account);
    } catch (err) {
      await handleAccountError(account.email, err);
      continue;
    }

    for (const id of ids) {
      try {
        if (await isProcessed(id)) continue;
        await handleMessage(account.email, id, { context, packages, timezone: cfg.BOOKING_TIMEZONE });
      } catch (err) {
        log.error(`failed handling message ${id}`, err);
        // Mark handled so a poison message can't loop forever.
        await markProcessed(id);
      }
    }
  }
}

async function handleMessage(
  accountEmail: string,
  id: string,
  ctx: { context: string; packages: string; timezone: string },
): Promise<void> {
  // Re-resolve the account each message (token may have been refreshed).
  const accounts = await listAccounts();
  const account = accounts.find((a) => a.email === accountEmail);
  if (!account) return;

  const email = await getMessage(account, id);

  // Suppressed sender → drop silently.
  if (await isSuppressed(email.fromEmail)) {
    await markHandled(account, id);
    await markProcessed(id);
    return;
  }

  const client = await loadOrCreateClient({
    email: email.fromEmail,
    name: email.fromName,
    accountEmail: account.email,
    gmailThreadId: email.threadId,
  });

  const availability = await computeAvailability(
    client.bookingFacts.timezone ?? ctx.timezone,
  );

  const result = await draftReply({
    context: ctx.context,
    packages: ctx.packages,
    clientName: client.name,
    clientEmail: client.email,
    threadHistory: client.thread,
    newEmailSubject: email.subject,
    newEmailBody: email.body,
    availability,
    timezone: client.bookingFacts.timezone ?? ctx.timezone,
  });

  // Record the inbound message + any extracted facts as memory.
  await appendMessage(client.id, {
    role: "client",
    text: `${email.subject}\n${email.body}`.slice(0, 4000),
    gmailMessageId: email.id,
  });
  await mergeBookingFacts(client.id, toModelFacts(result.extractedFacts));

  // Always mark handled (dedup + Gmail label), lead or not.
  await markHandled(account, id);
  await markProcessed(id);

  const isLead = result.isBookingLead && result.confidence >= LEAD_CONFIDENCE;
  if (!isLead) {
    log.info("not a lead — skipping alert", {
      from: email.fromEmail,
      classification: result.classification,
      confidence: result.confidence,
    });
    return;
  }

  // Loops lead sync — non-fatal.
  const loops = await upsertContact({
    email: client.email,
    firstName: client.name,
    source: "email-inbound",
    userGroup: "leads",
  });
  await sendEvent(client.email, "booking_inquiry", {
    classification: result.classification,
  });
  await mutateClient(client.id, (c) => {
    c.loopsSynced = loops.ok;
    c.lastDraft = result.draftReply;
  });

  // Create the pending action and alert the user.
  const action = await createAction({
    clientId: client.id,
    gmailMessageId: email.id,
    threadId: email.threadId,
    accountEmail: account.email,
    to: email.fromEmail,
    subject: email.subject,
    inReplyTo: email.messageIdHeader,
    references: email.references,
    draft: result.draftReply,
  });

  const tgMessageId = await sendDraftAlert({
    action,
    clientName: client.name,
    clientEmail: client.email,
    accountEmail: account.email,
    classification: result.classification,
    confidence: result.confidence,
    subject: email.subject,
    incomingSnippet: email.body,
    draft: result.draftReply,
  });
  await updateAction(action.id, (a) => {
    a.telegramMessageId = tgMessageId;
  });
}

/** Gmail auth/list failure — warn, and alert the user if a token went bad. */
async function handleAccountError(email: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log.warn(`gmail poll failed for ${email}`, message);
  if (/invalid_grant|unauthorized|invalid credentials|token/i.test(message)) {
    await notify(
      `⚠️ ${email} disconnected (auth expired). Re-link with /connect.`,
    ).catch(() => undefined);
  }
}
