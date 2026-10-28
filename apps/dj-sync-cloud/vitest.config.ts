import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Logic is tested in plain Node: v1 against MemoryStore, the protocol 2
// Durable Objects against node:sqlite and fake sockets (test/do-harness.ts).
// The real D1 SQL, hibernation and the WebSocket upgrade are exercised by
// the `wrangler dev --local` smoke test (see README).
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^cloudflare:workers$/,
        replacement: fileURLToPath(new URL("./test/shims/cloudflare-workers.ts", import.meta.url)),
      },
    ],
  },
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"] },
});
