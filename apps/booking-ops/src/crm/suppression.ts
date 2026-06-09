import { p } from "../paths.js";
import { writeJson, readJson } from "../lib/atomicWrite.js";

/**
 * Sender addresses the user marked "Not a lead" in Telegram. The inbound flow
 * skips these silently, so the classifier self-corrects over time.
 */
type SuppressionFile = { emails: string[] };

let cache: Set<string> | null = null;

async function load(): Promise<Set<string>> {
  if (cache) return cache;
  const data = await readJson<SuppressionFile>(p.suppressed, { emails: [] });
  cache = new Set(data.emails.map((e) => e.toLowerCase()));
  return cache;
}

export async function isSuppressed(email: string): Promise<boolean> {
  return (await load()).has(email.trim().toLowerCase());
}

export async function suppress(email: string): Promise<void> {
  const set = await load();
  const normalized = email.trim().toLowerCase();
  if (set.has(normalized)) return;
  set.add(normalized);
  await writeJson(p.suppressed, { emails: [...set] });
}

export async function unsuppress(email: string): Promise<void> {
  const set = await load();
  if (set.delete(email.trim().toLowerCase())) {
    await writeJson(p.suppressed, { emails: [...set] });
  }
}

/** Test helper. */
export function resetSuppressionCache(): void {
  cache = null;
}
