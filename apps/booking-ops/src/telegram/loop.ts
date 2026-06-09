import { loadConfig } from "../config.js";
import { logger } from "../lib/log.js";
import { p } from "../paths.js";
import { readText, atomicWrite } from "../lib/atomicWrite.js";
import {
  getUpdates,
  deleteWebhook,
  answerCallbackQuery,
  sendMessage,
  type TgUpdate,
} from "./client.js";
import { handleCommand } from "./commands.js";
import { getState, clearState, setState } from "./conversation.js";

const log = logger("tg-loop");

/**
 * Flow-layer callbacks the loop routes button/reply events to. Implemented in
 * src/flows (phase 6) and injected at startup so the Telegram layer has no
 * dependency on the flows (avoids a cycle).
 */
export type ActionHandlers = {
  approve(actionId: string): Promise<void>;
  reject(actionId: string): Promise<void>;
  notLead(actionId: string): Promise<void>;
  /** User's revised draft text (from the awaiting-edit force-reply). */
  submitEditedDraft(actionId: string, newText: string): Promise<void>;
  deposit(clientId: string): Promise<void>;
  paidInFull(clientId: string): Promise<void>;
  /** User's reply supplying missing booking facts (awaiting-booking-facts). */
  submitBookingFacts(clientId: string, text: string): Promise<void>;
};

async function loadOffset(): Promise<number> {
  const raw = await readText(p.telegramOffset, "0");
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

async function saveOffset(offset: number): Promise<void> {
  await atomicWrite(p.telegramOffset, String(offset));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resident long-poll loop. Authorizes only the configured chat, dispatches
 * commands, button callbacks, and force-reply messages. Runs until `signal`
 * aborts. Resilient: network errors are logged and retried with backoff.
 */
export async function runTelegramLoop(
  handlers: ActionHandlers,
  signal: AbortSignal,
): Promise<void> {
  const cfg = loadConfig();
  const authorizedChat = String(cfg.TELEGRAM_CHAT_ID);

  // Only one poller may run per bot token — clear any stale webhook first.
  await deleteWebhook();
  let offset = await loadOffset();
  log.info("telegram loop started", { offset });

  while (!signal.aborted) {
    let updates: TgUpdate[] = [];
    try {
      updates = await getUpdates(offset);
    } catch (err) {
      if (signal.aborted) break;
      log.warn("getUpdates error, backing off", err);
      await sleep(3000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        await dispatch(update, authorizedChat, handlers);
      } catch (err) {
        log.error("dispatch error", err);
      }
    }
    if (updates.length > 0) await saveOffset(offset);
  }
  log.info("telegram loop stopped");
}

async function dispatch(
  update: TgUpdate,
  authorizedChat: string,
  handlers: ActionHandlers,
): Promise<void> {
  // ─── button callbacks ───────────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    if (String(chatId) !== authorizedChat) {
      await answerCallbackQuery(cq.id, "Unauthorized");
      return;
    }
    await answerCallbackQuery(cq.id);
    const [verb, arg] = (cq.data ?? "").split(":");
    if (!verb || !arg) return;

    switch (verb) {
      case "apr":
        return handlers.approve(arg);
      case "rej":
        return handlers.reject(arg);
      case "nl":
        return handlers.notLead(arg);
      case "edt":
        // Two-step: arm awaiting-edit and prompt for the revised text.
        await setState(chatId!, { mode: "awaiting-edit", actionId: arg });
        await sendMessage(chatId!, "✏️ Reply to this message with the revised text.", {
          forceReply: true,
        });
        return;
      case "dep":
        return handlers.deposit(arg);
      case "paid":
        return handlers.paidInFull(arg);
      default:
        return;
    }
  }

  // ─── messages (commands + force-reply answers) ──────────────────
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    if (String(chatId) !== authorizedChat) return; // ignore strangers
    const text = msg.text ?? "";

    if (text.startsWith("/")) {
      await clearState(chatId); // a command cancels any pending reply flow
      await handleCommand(chatId, text);
      return;
    }

    const state = await getState(chatId);
    if (state.mode === "awaiting-edit" && state.actionId) {
      await clearState(chatId);
      await handlers.submitEditedDraft(state.actionId, text);
      return;
    }
    if (state.mode === "awaiting-booking-facts" && state.clientId) {
      // The facts handler decides whether to clear state or re-prompt.
      await handlers.submitBookingFacts(state.clientId, text);
      return;
    }
    // Otherwise: idle chatter — ignore quietly.
  }
}
