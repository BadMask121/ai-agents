import { p } from "../paths.js";
import { writeJson, readJson } from "../lib/atomicWrite.js";

/**
 * Per-chat conversation state for multi-step flows that need a follow-up reply:
 * editing a draft, or supplying missing booking facts. Single-user, but keyed by
 * chat id for safety. Persisted so a worker restart doesn't drop a pending edit.
 */
export type ConversationMode = "idle" | "awaiting-edit" | "awaiting-booking-facts";

export type ConversationState = {
  mode: ConversationMode;
  /** For awaiting-edit: the action being revised. */
  actionId?: string;
  /** For awaiting-booking-facts: the client we're booking. */
  clientId?: string;
  /** For awaiting-booking-facts: which payment confirmation triggered it. */
  pendingPayment?: "deposit" | "paid";
};

type StateFile = Record<string, ConversationState>;

async function load(): Promise<StateFile> {
  return readJson<StateFile>(p.conversationState, {});
}

export async function getState(chatId: number | string): Promise<ConversationState> {
  const all = await load();
  return all[String(chatId)] ?? { mode: "idle" };
}

export async function setState(
  chatId: number | string,
  state: ConversationState,
): Promise<void> {
  const all = await load();
  all[String(chatId)] = state;
  await writeJson(p.conversationState, all);
}

export async function clearState(chatId: number | string): Promise<void> {
  await setState(chatId, { mode: "idle" });
}
