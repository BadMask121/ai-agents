import path from "node:path";

/**
 * Root of the booking-ops workspace. In the container this is a mounted volume
 * (`/workspace/booking-ops`); locally point it at a scratch dir via env.
 * Mirrors the centralized-paths convention in career-ops-ui/src/lib/paths.ts.
 */
export const WORKSPACE =
  process.env.BOOKING_OPS_WORKSPACE ?? "/workspace/booking-ops";

export const p = {
  root: WORKSPACE,

  // Agent context (read on every draft).
  context: path.join(WORKSPACE, "context.md"),
  packages: path.join(WORKSPACE, "config", "packages.yml"),

  // Per-account Google refresh tokens, captured via the Telegram /connect flow.
  googleAccounts: path.join(WORKSPACE, "google-accounts"),
  settings: path.join(WORKSPACE, "settings.json"),

  // CRM + runtime state.
  clients: path.join(WORKSPACE, "clients"),
  actions: path.join(WORKSPACE, "actions"),
  suppressed: path.join(WORKSPACE, "suppressed.json"),
  conversationState: path.join(WORKSPACE, "conversation-state.json"),
  processedMessages: path.join(WORKSPACE, "processed-messages.tsv"),
  telegramOffset: path.join(WORKSPACE, "telegram-offset.txt"),

  logs: path.join(WORKSPACE, "logs"),
};

/** Path to a single connected Google account's token file. */
export function googleAccountPath(email: string): string {
  // Normalize so the filename is filesystem-safe and stable per address.
  const safe = email.trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, "_");
  return path.join(p.googleAccounts, `${safe}.json`);
}

/** Path to a single client's CRM record. */
export function clientPath(clientId: string): string {
  return path.join(p.clients, `${clientId}.json`);
}

/** Path to a single pending Telegram action record. */
export function actionPath(actionId: string): string {
  return path.join(p.actions, `${actionId}.json`);
}
