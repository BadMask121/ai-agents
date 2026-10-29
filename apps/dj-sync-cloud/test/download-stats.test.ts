import { describe, expect, it } from "vitest";
import { downloadStatsText, summarize } from "../src/download-stats";

describe("owner download stats", () => {
  const stats = {
    days: {
      "2026-10-20": { "install:1.3.3": 2 },
      "2026-10-28": { "install:1.3.4": 3, "update:1.3.4": 5 },
      "2026-10-29": { "install:1.3.4": 1 },
    },
  };

  it("sums today, the last 7 days and everything, with installs by version", () => {
    const text = summarize(stats, "2026-10-29");
    expect(text).toContain("Today: 1 installs, 0 updates");
    expect(text).toContain("Last 7 days: 4 installs, 5 updates");
    expect(text).toContain("Since 2026-10-20: 6 installs, 5 updates");
    expect(text).toContain("• 1.3.4: 4");
  });

  it("says so when nothing is counted, unbound or unreadable", async () => {
    expect(summarize({ days: {} }, "2026-10-29")).toBe("No downloads counted yet.");
    expect(await downloadStatsText(undefined, "2026-10-29")).toBe("Download counts aren't connected.");
    expect(await downloadStatsText({ get: async () => null }, "2026-10-29")).toBe("No downloads counted yet.");
    expect(await downloadStatsText({ get: async () => { throw new Error("x"); } }, "2026-10-29")).toBe("Couldn't read the download counts.");
  });
});
