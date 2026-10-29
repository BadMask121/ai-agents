import { describe, expect, it, vi } from "vitest";
import type { JevClient, JevRoute } from "../src/jev";
import { bar, meteredRunner, modelLabel, usageReport, type UsageEvent, type UsageRow } from "../src/usage";
import { FakeAi, FakeTelegram, makeCloud, type Any } from "./cloud";
import { CHAT, TG, hook, msg, paired, upload } from "./telegram-helpers";

const row = (day: string, kind: string, name: string, calls: number, extra: Partial<UsageRow> = {}): UsageRow => ({
  day,
  kind,
  name,
  ok: 1,
  calls,
  ms: calls * 150,
  tokens_in: calls * 900,
  tokens_out: 0,
  ...extra,
});
const DEEPSEEK = "accounts/fireworks/models/deepseek-v4p1-flash-1017";

describe("usage counting", () => {
  it("meters a model call: time, tokens, and failures", async () => {
    const seen: UsageEvent[] = [];
    const ok = new FakeAi().script({ text: "hi" });
    const raw = (await meteredRunner(ok, DEEPSEEK, (e) => seen.push(e)).run("x", { messages: [] })) as Any;
    expect(raw.choices[0].message.content).toBe("hi");
    const bad = meteredRunner(new FakeAi().script(new Error("503")), DEEPSEEK, (e) => seen.push(e));
    await expect(bad.run("x", {})).rejects.toThrow("503");
    expect(seen.map((e) => [e.kind, e.name, e.ok])).toEqual([
      ["model", DEEPSEEK, true],
      ["model", DEEPSEEK, false],
    ]);
  });

  it("draws bars in eighths", () => {
    expect(bar(0, 10)).toBe("");
    expect(bar(10, 10, 4)).toBe("████");
    expect(bar(5, 10, 4)).toBe("██");
    expect(bar(1, 100, 4)).toBe("▏");
  });

  it("labels models and reports a week as charts, with estimated costs", () => {
    expect([modelLabel("jev-1.14.0"), modelLabel(DEEPSEEK), modelLabel("@cf/zai-org/glm-4.7-flash")]).toEqual(["Jev", "DeepSeek", "glm 4.7 (CF)"]);
    const rows = [
      row("2026-10-29", "model", "jev-1.14.0", 40),
      row("2026-10-28", "model", "jev-1.14.0", 20),
      row("2026-10-29", "model", DEEPSEEK, 8, { ms: 8 * 1500, tokens_in: 8 * 3200, tokens_out: 8 * 150 }),
      row("2026-10-29", "model", DEEPSEEK, 1, { ok: 0, ms: 15000, tokens_in: 0 }),
      row("2026-10-29", "route", "code", 30),
      row("2026-10-29", "route", "jev", 25),
      row("2026-10-29", "route", "assistant", 8),
      row("2026-10-29", "route", "buttons", 4),
      row("2026-10-29", "search", "exact", 12),
      row("2026-10-29", "search", "close", 3),
      row("2026-10-29", "search", "none", 1, { ok: 0 }),
      row("2026-10-01", "model", "jev-1.14.0", 999), // outside the week
    ];
    const text = usageReport(rows, "2026-10-29");
    expect(text).toContain("<b>DJ Sync metrics</b> (last 7 days, UTC)");
    expect(text).toContain("69 model calls, 49 today");
    expect(text).toMatch(/Jev +█+ +60\n/u);
    expect(text).toMatch(/DeepSeek +█+[▉-▏]? +9 \(1 failed\)/u);
    expect(text).toMatch(/Thu 29 +█+ +49/u);
    expect(text).toMatch(/Wed 28 +█+[▉-▏]? +20/u);
    expect(text).toMatch(/Code +█+ +30/u);
    expect(text).toContain("Jev: avg 150 ms, 54k tokens in, ~$0.0023");
    expect(text).toContain("DeepSeek: avg 3.0 s, 26k tokens in / 1,200 out, ~$0.0091");
    expect(text).not.toContain("999");
    expect(text).toContain("<b>Track searches</b>");
    expect(text).toMatch(/Exact +█+ +12\nClose only +█+[▉-▏]? +3\nNothing +█?[▉-▏]? +1/u);
    expect(usageReport([], "2026-10-29")).toContain("No model calls");
  });
});

describe("/metrics in Telegram", () => {
  /** Jev that always reads a search. */
  class SearchJev implements JevClient {
    async route(): Promise<JevRoute> {
      return {
        action: "search_tracks",
        actionConfidence: 1,
        playlist: null,
        playlistConfidence: 1,
        ranked: [],
        folder: null,
        folderConfidence: 1,
        model: "jev-1.14.0",
        ms: 140,
      };
    }
  }

  it("is only for the owner, and counts the assistant's model calls and how messages were handled", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const tg = new FakeTelegram();
    const ai = new FakeAi().script({ text: "Hello!" });
    const env = { ...TG, ALERT_CHAT_ID: String(CHAT) };
    const c = makeCloud(undefined, { ...TG }, { env, telegram: tg, ai, router: new SearchJev() });
    const { t } = await paired(c);
    expect((await upload(c, t)).status).toBe(200);

    await hook(c, msg(CHAT, "find burna boy tracks")); // Jev answers it (search)
    await hook(c, msg(CHAT, "find songs at 120 bpm")); // a search only the assistant can run
    await hook(c, msg(CHAT, "/metrics"));
    const reply = tg.last(CHAT);
    expect(reply.parse_mode).toBe("HTML");
    expect(reply.text).toContain("<b>Calls by model</b>");
    expect(reply.text).toMatch(/glm 4\.7 \(CF\) +█+ +1<\/pre>/u); // the fake assistant, metered as the default model
    expect(reply.text).toMatch(/Jev +█+ +1\n/u);
    expect(reply.text).toMatch(/Assistant +█+ +1\n/u);
    expect(reply.text).toMatch(/Exact +█+ +1\n/u); // "find burna boy tracks" found Ye

    // Another DJ's chat: no such command.
    const other = 777;
    await paired(c, other);
    await hook(c, msg(other, "/metrics"));
    expect(tg.last(other).text).toContain("I don't know /metrics");
    expect(tg.last(other).parse_mode).toBeUndefined();
    log.mockRestore();
  });
});
