import { loadConfig } from "../config.js";
import { logger } from "../lib/log.js";
import { getAction, updateAction } from "../crm/actions.js";
import { getClient, appendMessage, advanceStatus } from "../crm/store.js";
import { suppress } from "../crm/suppression.js";
import { loadAccount } from "../google/accounts.js";
import { sendReply } from "../google/gmail.js";
import { sendEvent } from "../loops/client.js";
import { editMessageText, sendMessage } from "../telegram/client.js";
import { CB } from "../telegram/alerts.js";

const log = logger("approve");

function chat(): string {
  return loadConfig().TELEGRAM_CHAT_ID;
}

/** Approve + send the drafted reply, threaded into the original conversation. */
export async function approve(actionId: string): Promise<void> {
  const action = await getAction(actionId);
  if (!action) return;
  if (action.mode === "sent") return; // idempotent — already sent

  const account = await loadAccount(action.accountEmail);
  if (!account) {
    await sendMessage(chat(), `⚠️ Can't send: ${action.accountEmail} is no longer connected.`);
    return;
  }

  await sendReply(account, {
    to: action.to,
    subject: action.subject,
    bodyText: action.draft,
    threadId: action.threadId,
    inReplyTo: action.inReplyTo,
    references: action.references,
  });

  await appendMessage(action.clientId, { role: "user", text: action.draft });
  const client = await getClient(action.clientId);
  if (client?.status === "new") {
    await advanceStatus(action.clientId, "quoted").catch((e) => log.warn("status advance", e));
  }
  if (client) await sendEvent(client.email, "quote_sent");

  await updateAction(actionId, (a) => {
    a.mode = "sent";
  });
  if (action.telegramMessageId) {
    await editMessageText(chat(), action.telegramMessageId, `✅ Sent to ${action.to}`);
  }
}

/** Dismiss the draft without sending. */
export async function reject(actionId: string): Promise<void> {
  const action = await getAction(actionId);
  if (!action) return;
  await updateAction(actionId, (a) => {
    a.mode = "rejected";
  });
  if (action.telegramMessageId) {
    await editMessageText(chat(), action.telegramMessageId, "🚫 Dismissed.");
  }
}

/** Mark the sender as not-a-lead: suppress future emails, dismiss the draft. */
export async function notLead(actionId: string): Promise<void> {
  const action = await getAction(actionId);
  if (!action) return;
  const client = await getClient(action.clientId);
  if (client) await suppress(client.email);
  await updateAction(actionId, (a) => {
    a.mode = "rejected";
  });
  if (action.telegramMessageId) {
    await editMessageText(
      chat(),
      action.telegramMessageId,
      `🙅 Marked not a lead${client ? ` — ${client.email} suppressed` : ""}.`,
    );
  }
}

/**
 * User supplied a revised draft via the awaiting-edit force-reply. Update the
 * draft and re-render Approve/Reject so they confirm before it sends.
 */
export async function submitEditedDraft(actionId: string, newText: string): Promise<void> {
  const action = await getAction(actionId);
  if (!action) return;
  await updateAction(actionId, (a) => {
    a.draft = newText;
  });
  const msg = await sendMessage(chat(), `✏️ Revised reply:\n\n${newText}`, {
    inlineKeyboard: [
      [
        { text: "✅ Approve", callback_data: CB.approve(actionId) },
        { text: "🚫 Reject", callback_data: CB.reject(actionId) },
      ],
    ],
  });
  // Point the action at the new message so the post-send edit lands here.
  await updateAction(actionId, (a) => {
    a.telegramMessageId = msg.message_id;
  });
}
