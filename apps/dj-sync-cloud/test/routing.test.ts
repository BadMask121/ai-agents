import { describe, expect, it, vi } from "vitest";
import { JEV_ACT_CONFIDENCE, JEV_MAX_CHOICES } from "../src/constants";
import { chainRunner } from "../src/fireworks";
import { jevClient, playlistChoices, type JevClient, type JevRoute } from "../src/jev";
import { decideLink, decideText, exactPlaylist, namedIn, namesAfterPreposition } from "../src/routing";
import type { LibPlaylist } from "../src/store";
import { FakeAi, type Any } from "./cloud";
import { CHAT, LIBRARY, hook, msg, paired, pushedJob, tap, tgCloud, upload } from "./telegram-helpers";

const P = (id: string, name: string, folder = ""): LibPlaylist => ({ id, name, folder, track_ids: [] });
const LIB = [
  P("a1", "Afrobeat - Wa"),
  P("a2", "Afrobeat"),
  P("g1", "Gqom", "GQOM"),
  P("g2", "Gqom", "3 STEP"),
  P("c1", "Amapiano Chill", "AMAPIANO"),
  P("w1", "Wedding - Entrance"),
  P("w2", "Wedding - Dinner"),
  P("f1", "Friday", "DJ Sync"),
];
const byId = (id: string) => LIB.find((p) => p.id === id)!;

function route(over: Partial<JevRoute> = {}): JevRoute {
  return {
    action: "download",
    actionConfidence: 1,
    playlist: null,
    playlistConfidence: 1,
    ranked: [],
    folder: null,
    folderConfidence: 1,
    model: "jev-test",
    ms: 150,
    ...over,
  };
}

describe("router layer 1: code", () => {
  it("reads the playlist after to / into / in", () => {
    expect(namesAfterPreposition("Add this song to Afrobeat - Wa")).toEqual(["Afrobeat - Wa"]);
    expect(namesAfterPreposition("put this in my amapiano chill playlist")).toEqual(["amapiano chill"]);
    expect(namesAfterPreposition("gqom")).toEqual([]);
    // Only after download words: a question about a playlist isn't a download into it.
    expect(namesAfterPreposition("which of these do I already have in friday")).toEqual([]);
    expect(namesAfterPreposition("should go in road trip")).toEqual(["road trip"]);
  });

  it("matches exactly, and gives up when the readings disagree or a name is shared", () => {
    expect(exactPlaylist(LIB, "Add this song to Afrobeat - Wa", "song to Afrobeat - Wa")?.id).toBe("a1");
    expect(exactPlaylist(LIB, "put this in my amapiano chill playlist", "amapiano chill")?.id).toBe("c1");
    expect(exactPlaylist(LIB, "afrobeat", "afrobeat")?.id).toBe("a2");
    expect(exactPlaylist(LIB, "gqom", "gqom")).toBeNull(); // two Gqom playlists
    expect(exactPlaylist(LIB, "3 STEP/Gqom", "3 STEP/Gqom")?.id).toBe("g2");
    expect(exactPlaylist(LIB, "add to my wedding playlist", "wedding")).toBeNull();
  });
});

describe("router layer 2: Jev's answer is trusted only when it's sure and the name is in the message", () => {
  it("checks every word of the name, and the folder when the name is shared", () => {
    expect(namedIn(byId("a1"), "afrobeat wa", LIB)).toBe(true);
    expect(namedIn(byId("a1"), "afrobeatwa", LIB)).toBe(true);
    expect(namedIn(byId("a1"), "afrobeat", LIB)).toBe(false);
    expect(namedIn(byId("c1"), "the chilled amapiano one", LIB)).toBe(true);
    expect(namedIn(byId("g1"), "gqom", LIB)).toBe(false);
    expect(namedIn(byId("g2"), "3 step gqom", LIB)).toBe(true);
  });

  it("queues only above the threshold with the name present; otherwise buttons with Jev's guesses first", () => {
    const sureRoute = route({ playlist: byId("c1"), playlistConfidence: 0.95 });
    expect(decideLink(sureRoute, "chuck it on the chill amapiano one", LIB)).toEqual({ kind: "queue", playlist: byId("c1") });

    const unsure = route({
      playlist: byId("g1"),
      playlistConfidence: 0.87,
      ranked: [{ playlist: byId("g1"), p: 0.87 }, { playlist: byId("g2"), p: 0.11 }, { playlist: byId("a1"), p: 0.01 }],
    });
    expect(decideLink(unsure, "gqom", LIB)).toEqual({ kind: "buttons", suggest: [byId("g1"), byId("g2")] });

    // Sure, but the name isn't in the message: still a question.
    const wrong = route({ playlist: byId("w1"), playlistConfidence: JEV_ACT_CONFIDENCE });
    expect(decideLink(wrong, "wedding", LIB).kind).toBe("buttons");
  });

  it("sends a whole instruction around a link to the assistant, whatever Jev says", () => {
    const msg = "Check the songs we have in this playlist And make sure we find the songs in shayo 29 and copy it to the another playlist named oct 29";
    expect(decideLink(route({ playlist: byId("a1"), playlistConfidence: 0.99, ranked: [{ playlist: byId("a1"), p: 0.99 }] }), msg, LIB)).toEqual({ kind: "assistant" });
    expect(decideLink(route({ action: "link_task", actionConfidence: 0.6 }), "check these against friday", LIB)).toEqual({ kind: "assistant" });
    // Little words don't count: still a playlist phrase.
    expect(decideLink(route({ playlist: byId("c1"), playlistConfidence: 0.95 }), "chuck it on the chill amapiano one", LIB).kind).toBe("queue");
  });

  it("sends 'other' and new-playlist wording to the assistant", () => {
    expect(decideLink(route({ action: "other" }), "make a new playlist", LIB)).toEqual({ kind: "assistant" });
    expect(decideLink(route(), "into a new playlist called Lagos Nights", LIB)).toEqual({ kind: "assistant" });
    // Long wording with a strong guess still gets buttons, the guess first.
    const guess = route({ playlist: byId("c1"), playlistConfidence: 0.7, ranked: [{ playlist: byId("c1"), p: 0.7 }] });
    expect(decideLink(guess, "chuck it on the chill one", LIB)).toEqual({ kind: "buttons", suggest: [byId("c1")] });
    expect(decideLink(route(), "lagos", LIB).kind).toBe("buttons");
  });

  it("answers list and search itself only when nothing else was asked", () => {
    const list = route({ action: "list_playlists", folder: "DJ Sync" });
    expect(decideText(list, "what playlists do I have in the DJ Sync folder")).toEqual({ kind: "list", filter: "DJ Sync" });
    expect(decideText(route({ action: "list_playlists" }), "show my playlists")).toEqual({ kind: "list", filter: "" });
    expect(decideText(route({ action: "list_playlists" }), "playlists with more than 50 songs")).toEqual({ kind: "assistant" });

    expect(decideText(route({ action: "search_tracks" }), "find burna boy tracks")).toEqual({ kind: "search", query: "burna boy" });
    expect(decideText(route({ action: "search_tracks" }), "find songs at 120 bpm")).toEqual({ kind: "assistant" });
    expect(decideText(route({ action: "search_tracks", actionConfidence: 0.6 }), "burna")).toEqual({ kind: "assistant" });
    expect(decideText(route({ action: "other" }), "move friday into gqom")).toEqual({ kind: "assistant" });
  });
});

describe("Jev client", () => {
  it("sends the message and choices, and maps labels back to playlists", async () => {
    let sent: Any = null;
    const fetcher = vi.fn(async (_url: string, init: Any) => {
      sent = JSON.parse(init.body);
      return Response.json({
        model: "jev-1.14.0",
        answers: {
          action: { choice: "download", confidence: 0.99, probabilities: {} },
          playlist: { choice: "AMAPIANO/Amapiano Chill", confidence: 0.92, probabilities: { "AMAPIANO/Amapiano Chill": 0.92, "(none)": 0.08 } },
          folder: { choice: "(all)", confidence: 1, probabilities: {} },
        },
      });
    });
    const r = await jevClient("k", fetcher as unknown as typeof fetch).route("put this in my amapiano chill playlist <x>", ["<x>"], LIB);
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe("Bearer k");
    expect(sent.model).toBe("jev-latest");
    expect(sent.state).toEqual({ message: "put this in my amapiano chill playlist <x>", links: ["<x>"] });
    expect(Object.keys(sent.questions.playlist.criteria)).toContain("3 STEP/Gqom");
    expect(r).toMatchObject({ action: "download", playlist: byId("c1"), playlistConfidence: 0.92, folder: null, model: "jev-1.14.0" });
    expect(r.ranked.map((x) => x.playlist.id)).toEqual(["c1"]);
  });

  it("throws on HTTP errors and nonsense, so the bot moves on", async () => {
    const down = jevClient("k", (async () => new Response("no", { status: 503 })) as unknown as typeof fetch);
    await expect(down.route("x", [], LIB)).rejects.toThrow("jev 503");
    const odd = jevClient("k", (async () => Response.json({ answers: {} })) as unknown as typeof fetch);
    await expect(odd.route("x", [], LIB)).rejects.toThrow("no action");
  });

  it("offers at most 254 playlists plus (none), the closest to the message first", () => {
    const many = Array.from({ length: 400 }, (_, i) => P(`x${i}`, `Set ${i}`));
    many.push(P("z", "Zouk Lagos"));
    const choices = playlistChoices(many, "<link> zouk lagos");
    expect(choices.size).toBe(JEV_MAX_CHOICES - 1);
    expect([...choices.values()][0]!.id).toBe("z");
  });
});

describe("assistant fallback chain", () => {
  it("tries the next model when one fails, and throws only if all do", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = new FakeAi().script(new Error("fireworks 503"));
    const b = new FakeAi().script({ text: "ok" });
    const out = (await chainRunner([{ ai: a, model: "deepseek" }, { ai: b, model: "glm" }]).run("ignored", { messages: [] })) as Any;
    expect(out.choices[0].message.content).toBe("ok");
    expect([a.models, b.models]).toEqual([["deepseek"], ["glm"]]);
    const dead = chainRunner([{ ai: new FakeAi().script(new Error("x")), model: "m" }]);
    await expect(dead.run("m", {})).rejects.toThrow("x");
    warn.mockRestore();
  });
});

describe("the bot with Jev", () => {
  class FakeJev implements JevClient {
    calls: string[] = [];
    constructor(private answer: (text: string, playlists: LibPlaylist[]) => JevRoute | Error) {}
    async route(text: string, _links: string[], playlists: LibPlaylist[]): Promise<JevRoute> {
      this.calls.push(text);
      const a = this.answer(text, playlists);
      if (a instanceof Error) throw a;
      return a;
    }
  }
  const lib = (id: string) => LIBRARY.playlists.find((p) => p.id === id)!;
  async function setup(jev: FakeJev, ai = new FakeAi()) {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { c, tg } = tgCloud(ai, jev);
    const { t } = await paired(c);
    expect((await upload(c, t)).status).toBe(200);
    return { c, tg, t, ai, log };
  }
  const YT1 = "https://youtu.be/dQw4w9WgXcQ";
  const events = (log: Any) => log.mock.calls.map((x: Any) => JSON.parse(x[0])).filter((e: Any) => e.event === "router");

  it("an exact name never calls Jev", async () => {
    const jev = new FakeJev(() => new Error("should not be called"));
    const { c, t, tg, log } = await setup(jev);
    await hook(c, msg(CHAT, `Add this song to Amapiano Chill ${YT1}`));
    expect(jev.calls).toEqual([]);
    expect(tg.last(CHAT).text).toContain("→ Amapiano Chill");
    expect((await pushedJob(c, t)).playlist_id).toBe("p4");
    expect(events(log).at(-1)).toMatchObject({ layer: "code", decision: "queue", playlist: "p4" });
    log.mockRestore();
  });

  it("queues Jev's pick when it's sure and the name is there", async () => {
    const jev = new FakeJev((_t, pls) => route({ playlist: pls.find((p) => p.id === "p4")!, playlistConfidence: 0.95 }));
    const { c, t, tg, ai, log } = await setup(jev);
    await hook(c, msg(CHAT, `chuck this tune on the chill amapiano one ${YT1}`));
    expect(jev.calls).toHaveLength(1);
    expect(ai.inputs).toHaveLength(0);
    expect(tg.last(CHAT).text).toContain("→ Amapiano Chill");
    expect((await pushedJob(c, t)).playlist_id).toBe("p4");
    expect(events(log).at(-1)).toMatchObject({ layer: "jev", decision: "queue", playlist: "p4", pconf: 0.95 });
    log.mockRestore();
  });

  it("shows buttons with Jev's guesses first when it isn't sure, and logs the pick", async () => {
    const jev = new FakeJev((_t, pls) => {
      const [g1, g2] = [pls.find((p) => p.id === "p1")!, pls.find((p) => p.id === "p2")!];
      return route({ playlist: g1, playlistConfidence: 0.87, ranked: [{ playlist: g2, p: 0.5 }, { playlist: g1, p: 0.45 }] });
    });
    const { c, t, tg, log } = await setup(jev);
    await hook(c, msg(CHAT, `${YT1} gqom`));
    const rows = tg.last(CHAT).reply_markup.inline_keyboard.map((r: Any) => r[0].text);
    expect(rows.slice(0, 2)).toEqual([`3 STEP/Gqom (${lib("p2").track_ids.length})`, `GQOM/Gqom (${lib("p1").track_ids.length})`]);
    const pending = events(log).find((e: Any) => e.layer === "buttons").pending;
    await hook(c, tap(CHAT, `d:${pending}:p1`));
    expect((await pushedJob(c, t)).playlist_id).toBe("p1");
    expect(events(log).at(-1)).toMatchObject({ layer: "pick", pending, picked: "p1" });
    log.mockRestore();
  });

  it("answers list and search without the assistant", async () => {
    const jev = new FakeJev((text) =>
      text.startsWith("find") ? route({ action: "search_tracks" }) : route({ action: "list_playlists", folder: "DJ Sync" }),
    );
    const { c, tg, ai, log } = await setup(jev);
    await hook(c, msg(CHAT, "what playlists do I have in the DJ Sync folder"));
    expect(tg.last(CHAT).text).toContain("DJ Sync/Friday");
    expect(tg.last(CHAT).text).not.toContain("Gqom");
    await hook(c, msg(CHAT, "find burna boy tracks"));
    expect(tg.last(CHAT).text).toContain("Burna Boy — Ye");
    expect(ai.inputs).toHaveLength(0);
    log.mockRestore();
  });

  it("when Jev fails or times out, carries on as before (assistant, then buttons)", async () => {
    const jev = new FakeJev(() => new Error("The operation was aborted due to timeout"));
    const ai = new FakeAi().script({ text: "Your playlists: Friday, Gqom." });
    const { c, tg, log } = await setup(jev, ai);
    await hook(c, msg(CHAT, "what's in my library"));
    expect(tg.last(CHAT).text).toBe("Your playlists: Friday, Gqom.");
    expect(events(log)).toContainEqual(expect.objectContaining({ layer: "jev", decision: "failed" }));

    // A link whose wording needs the assistant, with the assistant down too: buttons, not an apology.
    ai.script(new Error("fireworks 500"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await hook(c, msg(CHAT, `${YT1} into the new lagos nights set`));
    expect(tg.last(CHAT).reply_markup.inline_keyboard.length).toBeGreaterThan(0);
    err.mockRestore();
    log.mockRestore();
  });

  it("stores nothing about the message in the router logs", async () => {
    const jev = new FakeJev(() => route({ action: "other" }));
    const ai = new FakeAi().script({ text: "Sure." });
    const { c, log } = await setup(jev, ai);
    await hook(c, msg(CHAT, "secret words about friday"));
    const lines = log.mock.calls.map((x: Any) => x[0] as string).filter((l: string) => l.includes('"router"'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("secret");
    expect(lines.join("\n")).not.toContain(String(CHAT));
    log.mockRestore();
  });
});
