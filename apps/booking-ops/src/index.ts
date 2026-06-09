import { promises as fs } from "node:fs";
import { loadConfig } from "./config.js";
import { p } from "./paths.js";
import { logger } from "./lib/log.js";
import { runTelegramLoop } from "./telegram/loop.js";
import { actionHandlers } from "./flows/handlers.js";
import { pollInbound } from "./flows/inbound.js";
import { startOAuthServer } from "./oauthServer.js";

const log = logger("worker");

/**
 * booking-ops worker entrypoint. Runs:
 *   - Telegram getUpdates long-poll  (commands + inline-button callbacks)
 *   - Gmail poll every GMAIL_POLL_SECONDS  (inbound mail across all accounts)
 *   - A small OAuth callback web server (the Telegram /connect phone flow)
 * SIGTERM stops all three.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();

  await Promise.all(
    [p.root, p.googleAccounts, p.clients, p.actions, p.logs].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );

  log.info("booking-ops worker starting", {
    workspace: p.root,
    model: cfg.BOOKING_MODEL,
    gmailPollSeconds: cfg.GMAIL_POLL_SECONDS,
  });

  const controller = new AbortController();

  // ─── OAuth callback server (Telegram /connect web flow) ─────────
  startOAuthServer(cfg.OAUTH_PORT, controller.signal);

  // ─── Gmail poll loop (guarded against overlap) ──────────────────
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await pollInbound();
    } catch (err) {
      log.error("inbound poll error", err);
    } finally {
      polling = false;
    }
  };
  const interval = setInterval(() => void poll(), cfg.GMAIL_POLL_SECONDS * 1000);
  void poll(); // run once at startup

  // ─── graceful shutdown ──────────────────────────────────────────
  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    clearInterval(interval);
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Telegram loop runs until the signal aborts; that keeps the process alive.
  await runTelegramLoop(actionHandlers, controller.signal);
  log.info("worker stopped");
}

main().catch((err) => {
  log.error("fatal error in worker startup", err);
  process.exit(1);
});
