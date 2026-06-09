import { promises as fs } from "node:fs";
import path from "node:path";
import { p } from "../paths.js";

/**
 * Append-only log of Gmail message ids we've already handled. The primary
 * dedup guard (the Gmail `booking-ops/seen` label is the back-stop). Kept as a
 * TSV mirroring career-ops-ui's scan-history.tsv.
 */
let cache: Set<string> | null = null;

async function load(): Promise<Set<string>> {
  if (cache) return cache;
  const set = new Set<string>();
  try {
    const raw = await fs.readFile(p.processedMessages, "utf-8");
    for (const line of raw.split("\n")) {
      const id = line.split("\t")[0]?.trim();
      if (id) set.add(id);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  cache = set;
  return set;
}

export async function isProcessed(messageId: string): Promise<boolean> {
  return (await load()).has(messageId);
}

export async function markProcessed(messageId: string): Promise<void> {
  const set = await load();
  if (set.has(messageId)) return;
  set.add(messageId);
  await fs.mkdir(path.dirname(p.processedMessages), { recursive: true });
  await fs.appendFile(
    p.processedMessages,
    `${messageId}\t${new Date().toISOString()}\n`,
    "utf-8",
  );
}

/** Test helper. */
export function resetDedupCache(): void {
  cache = null;
}
