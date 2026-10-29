import { describe, expect, it } from "vitest";
import {
  AGENT_CONFIRM_SECONDS,
  AGENT_MAX_ROUNDS,
  AGENT_MEMORY_SECONDS,
  AGENT_MEMORY_TURNS,
  AGENT_MESSAGES_PER_DAY,
  AGENT_MODEL,
  AGENT_TOOL_RESULT_CHARS,
} from "../src/constants";
import { SqlStore } from "../src/sqlstore";
import { TELEGRAM_MAX_TEXT } from "../src/telegram";
import { AGENT_UNAVAILABLE, agentLimited, systemPrompt, tidy } from "../src/telegram-agent";
import { HELP } from "../src/telegram-bot";
import { FakeAi, YT, type Any } from "./cloud";
import { FakeStorage } from "./do-harness";
import { CHAT, hook, msg, paired, storeOf, tap, tgCloud, upload, type Cloud } from "./telegram-helpers";

async function setup(ai = new FakeAi()) {
  const { c, tg } = tgCloud(ai);
  const { t } = await paired(c);
  expect((await upload(c, t)).status).toBe(200);
  return { c, tg, t, ai };
}

const say = (c: Cloud, text: string) => hook(c, msg(CHAT, text));
const jobs = async (c: Cloud, t: Any): Promise<Any[]> => storeOf(c, t).recentJobs(10);
const opsOf = (job: Any) => job.ops.map((o: Any) => `${o.op}:${o.content_id ?? o.name}`);

describe("Telegram assistant (connect-anywhere spec §1c)", () => {
  it("answers “list the playlists in DJ sync folder” with list_playlists, not the help text", async () => {
    const { c, tg, ai } = await setup();
    ai.script({ calls: [{ name: "list_playlists", args: { query: "DJ Sync" } }] }, (inputs) => {
      const result = inputs.messages.at(-1).content as string;
      return { text: `**In your DJ Sync folder:**\n- ${result.includes("DJ Sync/Friday (1 track)") ? "Friday (1 track)" : "?"}` };
    });
    await say(c, "list the playlists in DJ sync folder");

    expect(tg.of("sendChatAction").at(-1)).toEqual({ chat_id: String(CHAT), action: "typing" });
    expect(tg.last(CHAT).text).toBe("In your DJ Sync folder:\n• Friday (1 track)");
    expect(tg.texts(CHAT).slice(1).join("\n")).not.toContain("Send me a Spotify"); // [0] is the welcome

    // The request: the model, a system prompt with today's date, the 11 MCP tools as functions, the DJ's words.
    const first = ai.inputs[0];
    expect(ai.models).toEqual([AGENT_MODEL, AGENT_MODEL]);
    expect(first.messages[0]).toEqual({ role: "system", content: systemPrompt("2026-10-28") });
    expect(first.messages[0].content).toContain("Today is 2026-10-28.");
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "list the playlists in DJ sync folder" });
    expect(first.tools).toHaveLength(12);
    expect(first.tools[0]).toMatchObject({ type: "function", function: { name: "download_to_rekordbox", parameters: { type: "object" } } });
    expect(first.tools.map((t: Any) => t.function.name)).toEqual(expect.arrayContaining(["list_playlists", "move_tracks", "delete_playlist"]));
    expect(first.chat_template_kwargs).toEqual({ enable_thinking: false });

    // The tool ran through MCP (only the DJ Sync folder) and its result went back under the call's id.
    const [call] = ai.messages("assistant", 1);
    expect(call.tool_calls).toEqual([
      { id: "call_1_0", type: "function", function: { name: "list_playlists", arguments: '{"query":"DJ Sync"}' } },
    ]);
    const [result] = ai.messages("tool", 1);
    expect(result.tool_call_id).toBe("call_1_0");
    expect(result.content).toContain("1 playlist:\n- DJ Sync/Friday (1 track)");
    expect(result.content).not.toContain("Gqom");
  });

  it("without Workers AI, plain words get the help once (its first line isn't repeated)", async () => {
    const { c, tg } = tgCloud();
    await paired(c);
    await say(c, "list the playlists in DJ sync folder");
    expect(tg.last(CHAT).text).toBe(HELP);
    expect(tg.last(CHAT).text.split("Send me a Spotify or YouTube link")).toHaveLength(2);
    await say(c, "/help");
    expect(tg.last(CHAT).text).toBe(HELP);
  });

  it("chains tools: search, then move with the track_id it found", async () => {
    const { c, tg, t, ai } = await setup();
    ai.script(
      { calls: [{ name: "search_tracks", args: { query: "Ongcwele" } }] },
      (inputs) => {
        const id = /\[track_id ([^\]]+)\]/u.exec(inputs.messages.at(-1).content)![1];
        return { calls: [{ name: "move_tracks", args: { from_playlist: "GQOM/Gqom", to_playlist: "Friday", track_ids: [id] } }] };
      },
      { text: "Moved Ongcwele from Gqom to Friday — queued for your Mac." },
    );
    await say(c, "move Ongcwele out of my GQOM gqom playlist into friday");

    expect(tg.last(CHAT).text).toBe("Moved Ongcwele from Gqom to Friday — queued for your Mac.");
    expect(ai.inputs).toHaveLength(3);
    expect(ai.messages("tool", 2).map((m: Any) => m.tool_call_id)).toEqual(["call_1_0", "call_2_0"]);
    const [job] = await jobs(c, t);
    expect(opsOf(job)).toEqual(["add_to_playlist:t2", "remove_from_playlist:t2"]);
    expect(job.ops[0]).toMatchObject({ playlist: "Friday", playlist_id: "p3" });
    expect(job.ops[1]).toMatchObject({ playlist: "Gqom", playlist_id: "p1" });
    // Jobs the assistant queues get the "done" message like any other.
    expect(storeOf(c, t).takeTgJob(job.id)).toBe(String(CHAT));
  });

  it("remembers the conversation, with the track ids it saw, for follow-ups", async () => {
    const { c, tg, t, ai } = await setup();
    ai.script(
      { calls: [{ name: "get_playlist", args: { name: "GQOM/Gqom" } }] },
      { text: "GQOM/Gqom has 2 tracks:\n1. Burna Boy — Ye\n2. Sizwe Mdlalose — Ongcwele" },
    );
    await say(c, "what's in my GQOM gqom playlist?");

    ai.script(
      (inputs) => {
        const earlier = inputs.messages.slice(1, -1);
        const ids = [...earlier.at(-1).content.matchAll(/\[track_id ([^\]]+)\]/gu)].map((m: Any) => m[1]).slice(0, 2);
        return { calls: [{ name: "move_tracks", args: { from_playlist: "GQOM/Gqom", to_playlist: "Amapiano Chill", track_ids: ids } }] };
      },
      { text: "Moving both into Amapiano Chill." },
    );
    await say(c, "now move the first two into amapiano chill");

    const followUp = ai.inputs[2];
    expect(followUp.messages.map((m: Any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(followUp.messages[1].content).toBe("what's in my GQOM gqom playlist?");
    expect(followUp.messages[2].content).toContain("GQOM/Gqom has 2 tracks:");
    expect(followUp.messages[2].content).toContain(
      "Tracks, in order: 1. Burna Boy — Ye [track_id t1]; 2. Sizwe Mdlalose — Ongcwele [track_id t2]",
    );
    // Memory is text, not tool dumps.
    expect(JSON.stringify(followUp.messages)).not.toContain("tool_calls");
    expect(tg.last(CHAT).text).toBe("Moving both into Amapiano Chill.");
    const [job] = await jobs(c, t);
    expect(opsOf(job)).toEqual(["add_to_playlist:t1", "add_to_playlist:t2", "remove_from_playlist:t1", "remove_from_playlist:t2"]);
  });

  it(`keeps the last ${AGENT_MEMORY_TURNS} turns, for a day`, async () => {
    const { c, ai } = await setup();
    for (let i = 0; i < 7; i++) {
      ai.script({ text: `answer ${i}` });
      await say(c, `question ${i}`);
    }
    ai.script({ text: "ok" });
    await say(c, "question 7");
    const recalled = ai.inputs.at(-1).messages;
    expect(recalled).toHaveLength(1 + AGENT_MEMORY_TURNS + 1);
    expect(recalled[1]).toEqual({ role: "user", content: "question 2" });
    expect(recalled.at(-2)).toEqual({ role: "assistant", content: "answer 6" });

    c.advance(AGENT_MEMORY_SECONDS + 60);
    ai.script({ text: "hello" });
    await say(c, "hi again");
    expect(ai.inputs.at(-1).messages.map((m: Any) => m.role)).toEqual(["system", "user"]);
  });

  it("asks before deleting a playlist, and only the button deletes it", async () => {
    const { c, tg, t, ai } = await setup();
    ai.script({ calls: [{ name: "delete_playlist", args: { name: "friday" } }] });
    await say(c, "delete my friday playlist");

    const ask = tg.last(CHAT);
    expect(ask.text).toBe("Delete the playlist “DJ Sync/Friday” (1 track)? Its tracks stay in your library.");
    const [yes, no] = ask.reply_markup.inline_keyboard[0];
    expect([yes.text, no.text]).toEqual(["Delete", "Cancel"]);
    expect(yes.callback_data).toMatch(/^c:[A-Za-z0-9_-]{8}:y$/u);
    expect(ai.inputs).toHaveLength(1);
    expect(await jobs(c, t)).toHaveLength(0);

    await hook(c, tap(CHAT, no.callback_data, 77));
    expect(tg.of("editMessageText").at(-1)).toEqual({ chat_id: String(CHAT), message_id: 77, text: "Cancelled — nothing was changed." });
    await hook(c, tap(CHAT, yes.callback_data));
    expect(tg.of("answerCallbackQuery").at(-1).text).toContain("expired");
    expect(await jobs(c, t)).toHaveLength(0);

    ai.script({ calls: [{ name: "delete_playlist", args: { name: "friday" } }] });
    await say(c, "ok, delete friday");
    const confirm = tg.last(CHAT).reply_markup.inline_keyboard[0][0];
    await hook(c, tap(CHAT, confirm.callback_data, 78));
    expect(tg.of("editMessageText").at(-1)).toMatchObject({ message_id: 78 });
    expect(tg.of("editMessageText").at(-1).text).toContain("Friday");
    const [job] = await jobs(c, t);
    expect(job.ops).toEqual([{ op: "delete_playlist", name: "Friday", playlist_id: "p3" }]);
    expect(storeOf(c, t).takeTgJob(job.id)).toBe(String(CHAT));

    // A question left too long expires.
    ai.script({ calls: [{ name: "delete_playlist", args: { name: "Amapiano Tech" } }] });
    await say(c, "delete amapiano tech");
    const stale = tg.last(CHAT).reply_markup.inline_keyboard[0][0];
    c.advance(AGENT_CONFIRM_SECONDS + 60);
    await hook(c, tap(CHAT, stale.callback_data));
    expect(tg.of("answerCallbackQuery").at(-1).text).toContain("expired");
    expect(await jobs(c, t)).toHaveLength(1);
  });

  it("asks before moving a whole playlist; an unclear playlist goes back to the model instead", async () => {
    const { c, tg, t, ai } = await setup();
    ai.script({ calls: [{ name: "move_tracks", args: { from_playlist: "GQOM/Gqom", to_playlist: "amapiano chill", all: true } }] });
    await say(c, "move everything from GQOM gqom into amapiano chill");
    expect(tg.last(CHAT).text).toBe("Move all 2 tracks from “GQOM/Gqom” to “AMAPIANO/Amapiano Chill”?");
    const [move] = tg.last(CHAT).reply_markup.inline_keyboard[0];
    expect(move.text).toBe("Move");
    expect(await jobs(c, t)).toHaveLength(0);
    await hook(c, tap(CHAT, move.callback_data));
    const [job] = await jobs(c, t);
    expect(opsOf(job)).toEqual(["add_to_playlist:t1", "add_to_playlist:t2", "remove_from_playlist:t1", "remove_from_playlist:t2"]);

    // "gqom" is two playlists: no question, the tool's own "which one?" goes to the model, nothing is queued.
    ai.script({ calls: [{ name: "delete_playlist", args: { name: "gqom" } }] }, { text: "Which Gqom — GQOM/Gqom or 3 STEP/Gqom?" });
    await say(c, "delete gqom");
    expect(ai.messages("tool")[0].content).toContain("playlist_id p1");
    expect(tg.last(CHAT).text).toBe("Which Gqom — GQOM/Gqom or 3 STEP/Gqom?");
    expect(tg.last(CHAT).reply_markup).toBeUndefined();
    expect(await jobs(c, t)).toHaveLength(1);
  });

  it("reads a link with more than a playlist name; a link with a clean name stays rule-based", async () => {
    const { c, tg, t, ai } = await setup();
    const text = `download this into a new playlist called Lagos Nights ${YT(1)}`;
    ai.script(
      (inputs) => ({
        calls: [
          {
            name: "download_to_rekordbox",
            args: { urls: [/https:\/\/\S+/u.exec(inputs.messages.at(-1).content)![0]], playlist_name: "Lagos Nights", create_playlist: true },
          },
        ],
      }),
      { text: "Queued 1 link into a new playlist, Lagos Nights." },
    );
    await say(c, text);
    expect(ai.inputs[0].messages.at(-1)).toEqual({ role: "user", content: text });
    expect(tg.last(CHAT).text).toBe("Queued 1 link into a new playlist, Lagos Nights.");
    const [download] = await jobs(c, t);
    expect(download).toMatchObject({ kind: "download", playlist: "Lagos Nights", urls: ["https://www.youtube.com/watch?v=aaaaaaaaaa1"] });
    expect(storeOf(c, t).takeTgJob(download.id)).toBe(String(CHAT));

    await say(c, `${YT(2)} add to friday playlist`);
    expect(tg.last(CHAT).text).toContain("→ Friday");
    await say(c, YT(3));
    expect(tg.last(CHAT).text).toBe("Which playlist should 1 link go into?");
    await say(c, `${YT(4)} amapino`);
    expect(tg.last(CHAT).text).toContain("couldn't find a playlist called “amapino”");
    expect(ai.inputs).toHaveLength(2);
    expect((await jobs(c, t)).map((j) => [j.playlist, j.playlist_id])).toEqual([
      ["Friday", "p3"],
      ["Lagos Nights", null],
    ]);
  });

  it(`stops at ${AGENT_MESSAGES_PER_DAY} questions a day per chat; commands still work`, async () => {
    const { c, tg, ai } = await setup();
    for (let i = 0; i < AGENT_MESSAGES_PER_DAY; i++) {
      if (i > 0 && i % 30 === 0) c.advance(3601); // stay under the hourly message limit
      ai.script({ text: `answer ${i}` });
      await say(c, `question ${i}`);
    }
    expect(tg.last(CHAT).text).toBe(`answer ${AGENT_MESSAGES_PER_DAY - 1}`);
    await say(c, "one more?");
    expect(tg.last(CHAT).text).toBe(agentLimited());
    expect(ai.inputs).toHaveLength(AGENT_MESSAGES_PER_DAY);
    await say(c, "/playlists");
    expect(tg.last(CHAT).text).toContain("Friday");

    c.advance(24 * 3600); // the next UTC day
    ai.script({ text: "morning" });
    await say(c, "hi");
    expect(tg.last(CHAT).text).toBe("morning");
  });

  it("falls back gracefully when Workers AI fails, without showing the error", async () => {
    const { c, tg, t, ai } = await setup();
    ai.script(new Error("3036: You have used up your daily free allocation of 10,000 neurons."));
    await say(c, "list my playlists");
    expect(tg.last(CHAT).text).toBe(AGENT_UNAVAILABLE);
    expect(AGENT_UNAVAILABLE).toMatch(/^I can't think right now — commands and links still work: \/playlists/u);

    // A failure after a tool already ran; and nonsense back.
    ai.script({ calls: [{ name: "list_playlists", args: {} }] }, new Error("upstream 502"));
    await say(c, "and the folders?");
    expect(tg.last(CHAT).text).toBe(AGENT_UNAVAILABLE);
    ai.script(() => ({ text: "" }));
    await say(c, "hello?");
    expect(tg.last(CHAT).text).toBe(AGENT_UNAVAILABLE);
    expect(tg.texts(CHAT).join("\n")).not.toMatch(/3036|502|neurons|empty model output/u);

    // Failed turns aren't remembered; links still work.
    ai.script({ text: "here" });
    await say(c, "playlists please");
    expect(ai.inputs.at(-1).messages.map((m: Any) => m.role)).toEqual(["system", "user"]);
    await say(c, `${YT(5)} friday`);
    expect(tg.last(CHAT).text).toContain("→ Friday");
    expect(await jobs(c, t)).toHaveLength(1);
  });

  it(`gives up after ${AGENT_MAX_ROUNDS} rounds, cuts long tool output, and survives bad arguments`, async () => {
    const { c, tg, ai } = await setup();
    const loop = { calls: [{ name: "list_playlists", args: {} }] };
    ai.script(...Array.from({ length: AGENT_MAX_ROUNDS }, () => loop));
    await say(c, "go round in circles");
    expect(ai.inputs).toHaveLength(AGENT_MAX_ROUNDS);
    expect(tg.last(CHAT).text).toBe("That took too many steps — could you ask it more simply?");

    // Arguments that aren't a JSON object get an error back to the model, not a crash.
    ai.script(
      () => ({ calls: [{ name: "list_playlists", args: "not json" as never }] }),
      (inputs) => ({ text: inputs.messages.at(-1).content }),
    );
    await say(c, "bad args");
    expect(tg.last(CHAT).text).toBe("Error: arguments must be a JSON object.");
  });

  it("tidies the model's text for Telegram", () => {
    expect(tidy("<think>hmm</think>\n## Playlists\n**Friday** and __Gqom__\n* one\n- two\n\n\n\nend")).toBe(
      "Playlists\nFriday and Gqom\n• one\n• two\n\nend",
    );
    expect(tidy(`${"line\n".repeat(2000)}`).length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(AGENT_TOOL_RESULT_CHARS).toBeLessThan(TELEGRAM_MAX_TEXT * 2);
  });

  it("adds the assistant's tables to a tenant from an older Worker", () => {
    const storage = new FakeStorage();
    const db = { exec: storage.sql.exec.bind(storage.sql), transaction: <T>(fn: () => T) => storage.transactionSync(fn) } as Any;
    new SqlStore(db).init({});
    db.exec("DROP TABLE tg_memory");
    db.exec("DROP TABLE tg_confirm");
    SqlStore.migrate(db);
    const store = new SqlStore(db);
    store.addAgentTurn("1", "user", "hi", "2026-10-28T12:00:00.000Z");
    expect(store.agentTurns("1", "2026-10-28T00:00:00.000Z", 10)).toEqual([{ role: "user", content: "hi" }]);
    store.addAgentConfirm({ id: "abcdefgh", chat_id: "1", tool: "delete_playlist", args: { name: "x" }, prompt: "?", created_at: "2026-10-28T12:00:00.000Z" });
    expect(store.takeAgentConfirm("abcdefgh")).toMatchObject({ tool: "delete_playlist", args: { name: "x" } });
    expect(store.takeAgentConfirm("abcdefgh")).toBeNull();
  });
});

describe("Telegram assistant: songs found only as close matches", () => {
  it("asks before adding a close match to a playlist, and adds it on Yes", async () => {
    const { c, tg, t, ai } = await setup();
    // A typo in the artist: search forgives it, but only as a close match.
    ai.script(
      { calls: [{ name: "search_tracks", args: { query: "burnaa boy ye" } }] },
      (inputs) => {
        const result = inputs.messages.at(-1).content as string;
        expect(result).toContain("No exact match for “burnaa boy ye”");
        return { calls: [{ name: "add_tracks_to_playlist", args: { playlist: "Friday", track_ids: ["t1"] } }] };
      },
    );
    await say(c, "add ye by burnaa boy to friday");
    const ask = tg.last(CHAT);
    expect(ask.text).toBe("Add “Ye” by Burna Boy to “Friday”? I found it as a close match, not an exact one.");
    expect(await jobs(c, t)).toHaveLength(0);

    await hook(c, tap(CHAT, ask.reply_markup.inline_keyboard[0][0].callback_data, 80));
    const [job] = await jobs(c, t);
    expect(job.ops).toEqual([{ op: "add_to_playlist", playlist: "Friday", content_id: "t1", playlist_id: "p3" }]);

    // The next message still remembers it was a close match.
    ai.script({ calls: [{ name: "remove_tracks_from_playlist", args: { playlist: "Friday", track_ids: ["t1"] } }] });
    await say(c, "actually take it out again");
    expect(tg.last(CHAT).text).toContain("I found it as a close match");
  });

  it("doesn't ask when the search was exact", async () => {
    const { c, tg, t, ai } = await setup();
    ai.script(
      { calls: [{ name: "search_tracks", args: { query: "burna boy ye" } }] },
      { calls: [{ name: "add_tracks_to_playlist", args: { playlist: "Friday", track_ids: ["t1"] } }] },
      { text: "Added Ye to Friday." },
    );
    await say(c, "add ye by burna boy to friday");
    expect(tg.last(CHAT).text).toBe("Added Ye to Friday.");
    expect(await jobs(c, t)).toHaveLength(1);
  });
});
