/**
 * Entrypoint: load config, construct the shared Mailbox, start the HTTP server,
 * and shut down cleanly on signals.
 */
import { loadConfig } from "./config.js";
import { Mailbox } from "./mailbox.js";
import { startServer } from "./server.js";

function main(): void {
  const cfg = loadConfig();
  const mailbox = new Mailbox(cfg);
  const httpServer = startServer(cfg, mailbox);

  const shutdown = (signal: string): void => {
    console.log(`[mail-mcp] ${signal} received, shutting down`);
    httpServer.close(() => {
      void mailbox.close().finally(() => process.exit(0));
    });
    // Force-exit if graceful close hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
