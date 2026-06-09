import path from "node:path";
import { nanoid } from "nanoid";
import { p } from "../paths.js";
import { writeJson, readJson } from "../lib/atomicWrite.js";

/**
 * Short-lived `state` tokens for the OAuth web flow. Each ties a consent URL back
 * to the Telegram chat that requested it (CSRF guard + routing the "Connected"
 * reply). Single-use, 15-minute TTL.
 */
const TTL_MS = 15 * 60 * 1000;
const FILE = path.join(p.root, "oauth-states.json");

type StateRec = { chatId: string; createdAt: number };
type StateFile = Record<string, StateRec>;

async function load(): Promise<StateFile> {
  return readJson<StateFile>(FILE, {});
}

function prune(states: StateFile, now: number): StateFile {
  const out: StateFile = {};
  for (const [token, rec] of Object.entries(states)) {
    if (now - rec.createdAt < TTL_MS) out[token] = rec;
  }
  return out;
}

/** Create + persist a state token for a chat. `now` passed in (testable). */
export async function createState(chatId: string, now: number): Promise<string> {
  const states = prune(await load(), now);
  const token = nanoid(24);
  states[token] = { chatId, createdAt: now };
  await writeJson(FILE, states);
  return token;
}

/** Validate + consume a state token (single use). Returns the chatId or null. */
export async function consumeState(token: string, now: number): Promise<string | null> {
  const states = await load();
  const rec = states[token];
  delete states[token];
  await writeJson(FILE, prune(states, now));
  if (!rec) return null;
  if (now - rec.createdAt >= TTL_MS) return null;
  return rec.chatId;
}
