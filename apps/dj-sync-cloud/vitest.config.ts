import { defineConfig } from "vitest/config";

// Logic is tested against MemoryStore in plain Node; the D1 SQL is exercised
// by the `wrangler dev --local` smoke test (see README).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
