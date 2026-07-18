/**
 * Live smoke test against the real mailbox. Skipped unless RUN_LIVE_TESTS=1 and
 * credentials are present in the environment. Read-only — lists folders, then
 * lists + reads one INBOX message if present.
 */
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";
import { Mailbox } from "./mailbox.js";

const enabled = process.env.RUN_LIVE_TESTS === "1";

describe.runIf(enabled)("live mailbox smoke", () => {
  it("lists folders and reads a message", { timeout: 30_000 }, async () => {
    const cfg = loadConfig();
    const mailbox = new Mailbox(cfg);
    try {
      const folders = await mailbox.listFolders();
      expect(folders.length).toBeGreaterThan(0);
      expect(folders.some((f) => /inbox/i.test(f.path))).toBe(true);

      const recent = await mailbox.listMessages("INBOX", 1, 0);
      if (recent.length > 0) {
        const first = recent[0]!;
        const full = await mailbox.read(first.folder, first.uid);
        expect(full.uid).toBe(first.uid);
        expect(typeof full.body).toBe("string");
      }
    } finally {
      await mailbox.close();
    }
  });
});
