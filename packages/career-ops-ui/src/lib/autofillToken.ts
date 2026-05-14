import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { p } from "./paths";

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function getOrCreateAutofillToken(): Promise<string> {
  try {
    const existing = await fs.readFile(p.autofillToken, "utf-8");
    const trimmed = existing.trim();
    if (trimmed.length >= 32) return trimmed;
  } catch {
    // fall through to create
  }
  const token = crypto.randomBytes(32).toString("hex");
  await ensureDir(p.autofillToken);
  await fs.writeFile(p.autofillToken, token, { mode: 0o600 });
  return token;
}

export async function regenerateAutofillToken(): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await ensureDir(p.autofillToken);
  await fs.writeFile(p.autofillToken, token, { mode: 0o600 });
  return token;
}

export async function verifyAutofillToken(
  presented: string | undefined,
): Promise<boolean> {
  if (!presented) return false;
  let stored: string;
  try {
    stored = (await fs.readFile(p.autofillToken, "utf-8")).trim();
  } catch {
    return false;
  }
  if (stored.length < 32 || presented.length !== stored.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(stored));
}
