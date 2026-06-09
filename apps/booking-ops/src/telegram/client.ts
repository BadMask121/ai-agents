import { loadConfig } from "../config.js";
import { logger } from "../lib/log.js";

const log = logger("telegram");

// ─── minimal Bot API types (only the fields we use) ────────────────
export type TgUser = { id: number; first_name?: string; username?: string };
export type TgChat = { id: number };
export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  reply_to_message?: TgMessage;
};
export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};
export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineButton[][];

function apiBase(): string {
  return `https://api.telegram.org/bot${loadConfig().TELEGRAM_BOT_TOKEN}`;
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${apiBase()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    // getUpdates long-polls up to `timeout`s; give the HTTP call extra headroom.
    signal: AbortSignal.timeout(70_000),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) {
    throw new Error(`telegram ${method} failed: ${data.description ?? res.status}`);
  }
  return data.result as T;
}

/** Long-poll for updates since `offset`. Returns [] on timeout. */
export async function getUpdates(offset: number): Promise<TgUpdate[]> {
  return call<TgUpdate[]>("getUpdates", {
    offset,
    timeout: 50,
    allowed_updates: ["message", "callback_query"],
  });
}

/** Clear any stale webhook so getUpdates long-polling can run (avoids 409). */
export async function deleteWebhook(): Promise<void> {
  try {
    await call("deleteWebhook", { drop_pending_updates: false });
  } catch (err) {
    log.warn("deleteWebhook failed (continuing)", err);
  }
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  opts: { inlineKeyboard?: InlineKeyboard; forceReply?: boolean } = {},
): Promise<TgMessage> {
  const reply_markup = opts.inlineKeyboard
    ? { inline_keyboard: opts.inlineKeyboard }
    : opts.forceReply
      ? { force_reply: true }
      : undefined;
  return call<TgMessage>("sendMessage", {
    chat_id: chatId,
    text,
    ...(reply_markup ? { reply_markup } : {}),
  });
}

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  inlineKeyboard?: InlineKeyboard,
): Promise<void> {
  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
  });
}

/** Acknowledge a button press (stops the client-side spinner). */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}
