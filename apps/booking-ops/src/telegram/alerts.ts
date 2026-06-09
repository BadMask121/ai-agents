import { loadConfig } from "../config.js";
import { sendMessage, type InlineKeyboard } from "./client.js";
import type { PendingAction } from "../crm/actions.js";

/** callback_data verbs (kept short — Telegram caps callback_data at 64 bytes). */
export const CB = {
  approve: (id: string) => `apr:${id}`,
  edit: (id: string) => `edt:${id}`,
  reject: (id: string) => `rej:${id}`,
  notLead: (id: string) => `nl:${id}`,
  deposit: (clientId: string) => `dep:${clientId}`,
  paidInFull: (clientId: string) => `paid:${clientId}`,
} as const;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Send the draft alert with action buttons. Returns the Telegram message_id so
 * the caller can store it on the action and edit the message after a send.
 */
export async function sendDraftAlert(input: {
  action: PendingAction;
  clientName: string | null;
  clientEmail: string;
  accountEmail: string;
  classification: string;
  confidence: number;
  subject: string;
  incomingSnippet: string;
  draft: string;
}): Promise<number> {
  const chatId = loadConfig().TELEGRAM_CHAT_ID;
  const who = input.clientName
    ? `${input.clientName} <${input.clientEmail}>`
    : input.clientEmail;

  const text = [
    `📧 New ${input.classification.replace("_", " ")} (${Math.round(input.confidence * 100)}% lead)`,
    `From: ${who}`,
    `Via: ${input.accountEmail}`,
    `Subject: ${input.subject}`,
    "",
    `Their message:`,
    truncate(input.incomingSnippet, 600),
    "",
    `── Suggested reply ──`,
    truncate(input.draft, 2500),
  ].join("\n");

  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Approve", callback_data: CB.approve(input.action.id) },
      { text: "✏️ Edit", callback_data: CB.edit(input.action.id) },
      { text: "🚫 Reject", callback_data: CB.reject(input.action.id) },
    ],
    [{ text: "🙅 Not a lead", callback_data: CB.notLead(input.action.id) }],
    [
      { text: "💵 Deposit received", callback_data: CB.deposit(input.action.clientId) },
      { text: "💰 Paid in full", callback_data: CB.paidInFull(input.action.clientId) },
    ],
  ];

  const msg = await sendMessage(chatId, text, { inlineKeyboard: keyboard });
  return msg.message_id;
}

/** Send a plain notification to the authorized chat. */
export async function notify(text: string): Promise<void> {
  await sendMessage(loadConfig().TELEGRAM_CHAT_ID, text);
}
