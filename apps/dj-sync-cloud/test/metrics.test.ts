import { describe, expect, it, vi } from "vitest";
import { agentEvent, recordAgentEvent } from "../src/metrics";

describe("assistant metrics", () => {
  it("hashes the chat, logs one JSON line and writes a data point only when bound", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const e = await agentEvent("unavailable", 123, "m", "4242");
    expect(e.chat).toMatch(/^[0-9a-f]{8}$/);
    expect(e.chat).not.toContain("4242");

    recordAgentEvent(e);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ event: "assistant", outcome: "unavailable", ms: 123 });

    const points: unknown[] = [];
    recordAgentEvent(e, { writeDataPoint: (p) => points.push(p) });
    expect(points).toEqual([{ indexes: [e.chat], blobs: ["unavailable", "m"], doubles: [123] }]);

    // A failing sink never throws.
    expect(() => recordAgentEvent(e, { writeDataPoint: () => { throw new Error("x"); } })).not.toThrow();
    log.mockRestore();
  });
});
