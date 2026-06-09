import { clientPath } from "../paths.js";
import { writeJson, readJson, exists } from "../lib/atomicWrite.js";
import {
  assertTransition,
  clientIdForEmail,
  type ClientRecord,
  type ClientStatus,
  type ThreadMessage,
} from "./model.js";

/** Load a client record by id, or null. */
export async function getClient(id: string): Promise<ClientRecord | null> {
  const file = clientPath(id);
  if (!(await exists(file))) return null;
  return readJson<ClientRecord | null>(file, null);
}

/** Load the client for an email, creating a fresh record if none exists. */
export async function loadOrCreateClient(input: {
  email: string;
  name: string | null;
  accountEmail: string;
  gmailThreadId: string | null;
}): Promise<ClientRecord> {
  const id = clientIdForEmail(input.email);
  const existing = await getClient(id);
  if (existing) return existing;

  const now = new Date().toISOString();
  const record: ClientRecord = {
    id,
    email: input.email.trim().toLowerCase(),
    name: input.name,
    status: "new",
    accountEmail: input.accountEmail,
    gmailThreadId: input.gmailThreadId,
    thread: [],
    bookingFacts: {},
    lastDraft: null,
    calendarEventId: null,
    loopsSynced: false,
    createdAt: now,
    updatedAt: now,
  };
  await saveClient(record);
  return record;
}

/** Persist a record (atomic), stamping updatedAt. */
export async function saveClient(record: ClientRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await writeJson(clientPath(record.id), record);
}

/** Read-modify-write helper. */
export async function mutateClient(
  id: string,
  fn: (record: ClientRecord) => void,
): Promise<ClientRecord> {
  const record = await getClient(id);
  if (!record) throw new Error(`client not found: ${id}`);
  fn(record);
  await saveClient(record);
  return record;
}

/** Advance status with transition validation. */
export async function advanceStatus(
  id: string,
  to: ClientStatus,
): Promise<ClientRecord> {
  return mutateClient(id, (r) => {
    assertTransition(r.status, to);
    r.status = to;
  });
}

/** Append a message to the client's thread (the drafter's memory). */
export async function appendMessage(
  id: string,
  message: Omit<ThreadMessage, "ts"> & { ts?: string },
): Promise<ClientRecord> {
  return mutateClient(id, (r) => {
    r.thread.push({ ...message, ts: message.ts ?? new Date().toISOString() });
  });
}

/** Shallow-merge newly extracted booking facts (non-empty values win). */
export async function mergeBookingFacts(
  id: string,
  facts: Record<string, unknown>,
): Promise<ClientRecord> {
  return mutateClient(id, (r) => {
    for (const [key, value] of Object.entries(facts)) {
      if (value !== undefined && value !== null && value !== "") {
        (r.bookingFacts as Record<string, unknown>)[key] = value;
      }
    }
  });
}
