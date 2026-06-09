import { promises as fs } from "node:fs";
import { nanoid } from "nanoid";
import { actionPath } from "../paths.js";
import { writeJson, readJson, exists } from "../lib/atomicWrite.js";

/**
 * A pending Telegram action. Telegram's callback_data is capped at 64 bytes, so
 * buttons carry only `<verb>:<actionId>` and we recover the full context here.
 */
export type ActionMode = "pending" | "awaiting-edit" | "sent" | "rejected";

export type PendingAction = {
  id: string;
  clientId: string;
  gmailMessageId: string;
  threadId: string;
  accountEmail: string;
  /** Reply target + threading headers captured from the inbound message. */
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string | null;
  /** The current draft reply (updated if the user edits it). */
  draft: string;
  mode: ActionMode;
  /** Telegram message id of the alert, so we can edit it after send. */
  telegramMessageId?: number;
  createdAt: string;
};

export async function createAction(
  input: Omit<PendingAction, "id" | "mode" | "createdAt">,
): Promise<PendingAction> {
  const action: PendingAction = {
    ...input,
    id: nanoid(8),
    mode: "pending",
    createdAt: new Date().toISOString(),
  };
  await writeJson(actionPath(action.id), action);
  return action;
}

export async function getAction(id: string): Promise<PendingAction | null> {
  const file = actionPath(id);
  if (!(await exists(file))) return null;
  return readJson<PendingAction | null>(file, null);
}

export async function updateAction(
  id: string,
  fn: (action: PendingAction) => void,
): Promise<PendingAction> {
  const action = await getAction(id);
  if (!action) throw new Error(`action not found: ${id}`);
  fn(action);
  await writeJson(actionPath(id), action);
  return action;
}

export async function deleteAction(id: string): Promise<void> {
  await fs.rm(actionPath(id)).catch(() => {
    /* already gone */
  });
}
