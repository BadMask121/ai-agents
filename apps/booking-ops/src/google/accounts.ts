import { promises as fs } from "node:fs";
import path from "node:path";
import { p, googleAccountPath } from "../paths.js";
import { writeJson, readJson, exists } from "../lib/atomicWrite.js";

/** A linked Google account and its long-lived refresh token. */
export type GoogleAccount = {
  email: string;
  refreshToken: string;
  scopes: string[];
  connectedAt: string;
};

type Settings = {
  /** Email of the account whose calendar new bookings are created on. */
  defaultCalendarAccount?: string;
};

/** Persist (or overwrite) a connected account's token. File perms 600. */
export async function saveAccount(account: GoogleAccount): Promise<void> {
  const file = googleAccountPath(account.email);
  await writeJson(file, account);
  await fs.chmod(file, 0o600).catch(() => {
    /* best-effort on filesystems without POSIX perms */
  });

  // First connected account becomes the default calendar.
  const settings = await readSettings();
  if (!settings.defaultCalendarAccount) {
    await writeSettings({ ...settings, defaultCalendarAccount: account.email });
  }
}

/** Load one account by email, or null if not connected. */
export async function loadAccount(email: string): Promise<GoogleAccount | null> {
  const file = googleAccountPath(email);
  if (!(await exists(file))) return null;
  return readJson<GoogleAccount | null>(file, null);
}

/** List all connected accounts. */
export async function listAccounts(): Promise<GoogleAccount[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(p.googleAccounts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const accounts: GoogleAccount[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const acc = await readJson<GoogleAccount | null>(
      path.join(p.googleAccounts, name),
      null,
    );
    if (acc) accounts.push(acc);
  }
  return accounts.sort((a, b) => a.email.localeCompare(b.email));
}

/** Remove a connected account. Clears the default if it pointed here. */
export async function deleteAccount(email: string): Promise<boolean> {
  const file = googleAccountPath(email);
  if (!(await exists(file))) return false;
  await fs.rm(file);

  const settings = await readSettings();
  if (settings.defaultCalendarAccount === email) {
    const remaining = await listAccounts();
    await writeSettings({
      ...settings,
      defaultCalendarAccount: remaining[0]?.email,
    });
  }
  return true;
}

// ─── settings (default calendar account) ───────────────────────────

export async function readSettings(): Promise<Settings> {
  return readJson<Settings>(p.settings, {});
}

async function writeSettings(settings: Settings): Promise<void> {
  await writeJson(p.settings, settings);
}

/** Email of the default calendar account, or the first connected one. */
export async function getDefaultCalendarAccount(): Promise<GoogleAccount | null> {
  const settings = await readSettings();
  if (settings.defaultCalendarAccount) {
    const acc = await loadAccount(settings.defaultCalendarAccount);
    if (acc) return acc;
  }
  const all = await listAccounts();
  return all[0] ?? null;
}

/** Set the default calendar account. Returns false if not connected. */
export async function setDefaultCalendarAccount(email: string): Promise<boolean> {
  const acc = await loadAccount(email);
  if (!acc) return false;
  const settings = await readSettings();
  await writeSettings({ ...settings, defaultCalendarAccount: email });
  return true;
}
