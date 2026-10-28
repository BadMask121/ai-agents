import { describe, expect, it } from "vitest";
import { TELEGRAM_MESSAGES_PER_HOUR, TELEGRAM_PAIRING_SECONDS, TELEGRAM_PENDING_SECONDS } from "../src/constants";
import { BAD_CODE, NOT_CONNECTED, clip } from "../src/telegram";
import { splitMessage } from "../src/telegram-bot";
import { ADMIN, FakeTelegram, YT, agentHeaders, makeCloud, req, type Any, type Registered } from "./cloud";

const TG = {
  TELEGRAM_BOT_TOKEN: "123456:fake-token-for-tests",
  TELEGRAM_WEBHOOK_SECRET: "hook-secret-0123456789abcdef",
  TELEGRAM_BOT_USERNAME: "DJSyncAppBot",
};

const LIBRARY = {
  hash: "h1",
  generated_at: "2026-10-28T11:00:00Z",
  library_version: "1.2.0",
  playlists: [
    { id: "p1", name: "Gqom", folder: "GQOM", track_ids: ["t1", "t2"] },
    { id: "p2", name: "Gqom", folder: "3 STEP", track_ids: [] },
    { id: "p3", name: "Friday", folder: "DJ Sync", track_ids: ["t1"] },
    { id: "p4", name: "Amapiano Chill", folder: "AMAPIANO", track_ids: [] },
    { id: "p5", name: "Amapiano Tech", folder: "AMAPIANO", track_ids: [] },
  ],
  tracks: [
    { id: "t1", title: "Ye", artist: "Burna Boy", album: null, genre: "Afrobeats", bpm: 102, key: "8A", duration_secs: 231 },
    { id: "t2", title: "Ongcwele", artist: "Sizwe Mdlalose", album: null, genre: "Gqom", bpm: 127, key: "5A", duration_secs: 300 },
  ],
};

function tgCloud() {
  const tg = new FakeTelegram();
  const c = makeCloud(undefined, { ...TG }, { env: TG, telegram: tg });
  return { c, tg };
}

type Cloud = ReturnType<typeof makeCloud>;
const CHAT = 555;

const hook = (c: Cloud, update: unknown, secret: string | null = TG.TELEGRAM_WEBHOOK_SECRET) =>
  c.call(req("POST", "/telegram/webhook", update, secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }));
const msg = (chat: number, text: string, from: Any = { username: "djbob", first_name: "Bob" }, type = "private") => ({
  update_id: 1,
  message: { message_id: 7, chat: { id: chat, type }, from, text },
});
const tap = (chat: number, data: string, messageId = 50) => ({
  update_id: 2,
  callback_query: { id: `cb-${data}`, from: { username: "djbob" }, data, message: { message_id: messageId, chat: { id: chat, type: "private" } } },
});
const codeOf = (link: Any) => new URL(link.url).searchParams.get("start")!;
const links = async (c: Cloud, t: Registered): Promise<Any[]> =>
  (await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(t)))).json() as Promise<Any[]>;
const upload = (c: Cloud, t: Registered, body: unknown = LIBRARY) => c.call(req("PUT", "/v2/agent/library", body, agentHeaders(t)));

async function paired(c: Cloud, chat = CHAT) {
  const t = await c.registered(`198.51.100.${chat % 250}`);
  const link = await c.link(t, "telegram");
  expect((await hook(c, msg(chat, `/start ${codeOf(link)}`))).status).toBe(200);
  return { t, link };
}

/** The pushed job frame once the Mac connects (to see playlist / playlist_id). */
async function pushedJob(c: Cloud, t: Registered): Promise<Any> {
  const ws = await c.connect(t);
  await c.hello(t, ws);
  return ws.frames().find((f) => f.type === "job");
}

describe("Telegram pairing (connect-anywhere spec §1)", () => {
  it("pairs a chat with a one-time code from the Mac, and the Mac sees it paired", async () => {
    const { c, tg } = tgCloud();
    const t = await c.registered();
    const link = await c.link(t, "telegram");
    expect(link).toMatchObject({ kind: "telegram", label: "Telegram", paired: false, telegram_username: null, last_used_at: null });
    expect(link.url).toMatch(/^https:\/\/t\.me\/DJSyncAppBot\?start=[A-Za-z0-9_-]{22}$/);
    expect(link.expires_at).toBe(new Date(c.now().getTime() + TELEGRAM_PAIRING_SECONDS * 1000).toISOString());

    expect((await hook(c, msg(CHAT, `/start ${codeOf(link)}`))).status).toBe(200);
    expect(tg.last(CHAT).text).toContain("Hi Bob — DJ Sync is connected to this chat");
    const [listed] = await links(c, t);
    expect(listed).toMatchObject({ id: link.id, kind: "telegram", paired: true, telegram_username: "djbob", label: "Telegram (@djbob)" });
    expect(listed.last_used_at).toBe(c.now().toISOString());
    expect(listed.url).toBeUndefined();

    // Single use: the same code from another chat is refused, and that chat stays unknown.
    await hook(c, msg(777, `/start ${codeOf(link)}`));
    expect(tg.last(777).text).toBe(BAD_CODE);
    await hook(c, msg(777, "/help"));
    expect(tg.last(777).text).toBe(NOT_CONNECTED);
  });

  it("refuses expired codes", async () => {
    const { c, tg } = tgCloud();
    const t = await c.registered();
    const link = await c.link(t, "telegram");
    c.advance(TELEGRAM_PAIRING_SECONDS + 1);
    await hook(c, msg(CHAT, `/start ${codeOf(link)}`));
    expect(tg.last(CHAT).text).toBe(BAD_CODE);
    expect((await links(c, t))[0].paired).toBe(false);
  });

  it("checks the webhook secret, ignores groups, and tells unknown chats how to connect", async () => {
    const { c, tg } = tgCloud();
    expect((await hook(c, msg(CHAT, "/help"), "wrong")).status).toBe(401);
    expect((await hook(c, msg(CHAT, "/help"), null)).status).toBe(401);
    expect(tg.calls).toEqual([]);
    expect((await hook(c, msg(-100, "/help", {}, "group"))).status).toBe(200);
    expect(tg.calls).toEqual([]);
    await hook(c, msg(CHAT, "hello"));
    expect(tg.last(CHAT).text).toBe(NOT_CONNECTED);
    await hook(c, tap(CHAT, "d:abcdefgh:def"));
    expect(tg.of("answerCallbackQuery")).toHaveLength(1);
    expect((await c.call(req("GET", "/telegram/webhook"))).status).toBe(405);

    // Without the bot configured the webhook doesn't exist.
    const plain = makeCloud();
    expect((await plain.call(req("POST", "/telegram/webhook", msg(CHAT, "/help")))).status).toBe(404);
  });

  it("rebinds: the latest pairing wins, across chats and DJs", async () => {
    const { c, tg } = tgCloud();
    const { t: a, link } = await paired(c, CHAT);

    // A new code from the Mac lets the old chat go and pairs a new one.
    const rotated = (await (await c.call(req("POST", `/v2/agent/links/${link.id}/rotate`, {}, agentHeaders(a)))).json()) as Any;
    expect(rotated).toMatchObject({ id: link.id, paired: false });
    expect(tg.last(CHAT).text).toContain("Disconnected");
    expect((await links(c, a))[0].paired).toBe(false);
    await hook(c, msg(CHAT, "/help"));
    expect(tg.last(CHAT).text).toBe(NOT_CONNECTED);
    await hook(c, msg(666, `/start ${codeOf(rotated)}`, { first_name: "Ada" }));
    expect((await links(c, a))[0]).toMatchObject({ paired: true, telegram_username: null, label: "Telegram (Ada)" });

    // Another DJ pairs the same chat: it now belongs to them, and A lets go.
    const { url: mcpA } = await c.link(a, "chatgpt");
    expect((await c.tool(mcpA, "download_to_rekordbox", { urls: [YT(1)] })).isError).toBe(false);
    const b = await c.registered("198.51.100.200");
    const linkB = await c.link(b, "telegram");
    await hook(c, msg(666, `/start ${codeOf(linkB)}`));
    expect((await links(c, a)).find((l) => l.kind === "telegram").paired).toBe(false);
    expect((await links(c, b))[0].paired).toBe(true);
    await hook(c, msg(666, "/status"));
    expect(tg.last(666).text).toBe("Nothing yet — send me a link."); // B's (empty) history, not A's

    // Pairing B's link from a second chat replaces the first one.
    const again = (await (await c.call(req("POST", `/v2/agent/links/${linkB.id}/rotate`, {}, agentHeaders(b)))).json()) as Any;
    await hook(c, msg(888, `/start ${codeOf(again)}`));
    await hook(c, msg(666, "/help"));
    expect(tg.last(666).text).toBe(NOT_CONNECTED);
  });

  it("/stop and deleting the link unpair the chat", async () => {
    const { c, tg } = tgCloud();
    const { t } = await paired(c, CHAT);
    await hook(c, msg(CHAT, "/stop"));
    expect(tg.last(CHAT).text).toContain("Disconnected");
    expect(await links(c, t)).toEqual([]);
    await hook(c, msg(CHAT, "/help"));
    expect(tg.last(CHAT).text).toBe(NOT_CONNECTED);

    const link = await c.link(t, "telegram");
    await hook(c, msg(CHAT, `/start ${codeOf(link)}`));
    expect((await c.call(req("DELETE", `/v2/agent/links/${link.id}`, undefined, agentHeaders(t)))).status).toBe(204);
    expect(tg.last(CHAT).text).toBe("Disconnected from DJ Sync on the Mac.");
    await hook(c, msg(CHAT, "/help"));
    expect(tg.last(CHAT).text).toBe(NOT_CONNECTED);
  });
});

describe("Telegram bot", () => {
  it("queues a link with a clear playlist hint into that playlist (pinned)", async () => {
    const { c, tg } = tgCloud();
    const { t } = await paired(c);
    expect((await upload(c, t)).status).toBe(200);
    await hook(c, msg(CHAT, `${YT(1)} add to friday playlist`));
    expect(tg.last(CHAT).text).toMatch(/^Queued: 1 link → Friday\. I'll tell you when it's in Rekordbox\. Your Mac is offline/);
    expect(await pushedJob(c, t)).toMatchObject({ kind: "download", playlist: "Friday", playlist_id: "p3" });

    // "Folder/Name" picks one of two same-named playlists.
    await hook(c, msg(CHAT, `${YT(2)} GQOM/Gqom`));
    expect(tg.last(CHAT).text).toContain("→ Gqom");
  });

  it("offers buttons when there's no hint or it's unclear, and a tap queues it", async () => {
    const { c, tg } = tgCloud();
    const { t } = await paired(c);
    await upload(c, t);

    await hook(c, msg(CHAT, YT(3)));
    const ask = tg.last(CHAT);
    expect(ask.text).toBe("Which playlist should 1 link go into?");
    const rows = ask.reply_markup.inline_keyboard.map((r: Any) => r[0]);
    expect(rows[0].text).toBe("DJ Sync/Friday (1)");
    expect(rows.at(-1).text).toBe("Default (ChatGPT Downloads)");
    expect(rows.some((b: Any) => b.text.startsWith("New playlist"))).toBe(false);
    for (const b of rows) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);

    const gqom = rows.find((b: Any) => b.text === "GQOM/Gqom (2)");
    await hook(c, tap(CHAT, gqom.callback_data, 91));
    expect(tg.of("answerCallbackQuery").at(-1)).toEqual({ callback_query_id: `cb-${gqom.callback_data}` });
    expect(tg.of("editMessageText").at(-1)).toMatchObject({ chat_id: String(CHAT), message_id: 91 });
    expect(tg.of("editMessageText").at(-1).text).toContain("Queued: 1 link → Gqom");
    // Tapping again: the choice is used up.
    await hook(c, tap(CHAT, gqom.callback_data));
    expect(tg.of("answerCallbackQuery").at(-1).text).toContain("expired");
    expect(await pushedJob(c, t)).toMatchObject({ playlist: "Gqom", playlist_id: "p1" });

    // Unclear: suggestions, Default and New.
    await hook(c, msg(CHAT, `${YT(4)} amapino`));
    const unclear = tg.last(CHAT);
    expect(unclear.text).toContain("couldn't find a playlist called “amapino”");
    const choices = unclear.reply_markup.inline_keyboard.map((r: Any) => r[0].text);
    expect(choices).toEqual(expect.arrayContaining(["AMAPIANO/Amapiano Chill (0)", "Default (ChatGPT Downloads)", "New playlist: amapino"]));
    const fresh = unclear.reply_markup.inline_keyboard.at(-1)[0].callback_data;
    await hook(c, tap(CHAT, fresh));
    expect(tg.of("editMessageText").at(-1).text).toContain("→ amapino");

    await hook(c, msg(CHAT, YT(5)));
    const def = tg.last(CHAT).reply_markup.inline_keyboard.at(-1)[0].callback_data;
    await hook(c, tap(CHAT, def));
    expect(tg.of("editMessageText").at(-1).text).toContain("→ ChatGPT Downloads");

    // Duplicate names: ask which, no "New".
    await hook(c, msg(CHAT, `${YT(6)} gqom`));
    const dup = tg.last(CHAT);
    expect(dup.text).toBe("2 playlists are called “gqom”. Which one?");
    expect(dup.reply_markup.inline_keyboard.map((r: Any) => r[0].text)).toEqual([
      "GQOM/Gqom (2)",
      "3 STEP/Gqom (0)",
      "Default (ChatGPT Downloads)",
    ]);

    // Pending choices expire after a day.
    const late = dup.reply_markup.inline_keyboard[0][0].callback_data;
    c.advance(TELEGRAM_PENDING_SECONDS + 60);
    await hook(c, tap(CHAT, late));
    expect(tg.of("answerCallbackQuery").at(-1).text).toContain("expired");
  });

  it("without a library snapshot, uses the hint as the playlist name", async () => {
    const { c, tg } = tgCloud();
    const { t } = await paired(c);
    await hook(c, msg(CHAT, `${YT(7)} Sunday Brunch`));
    expect(tg.last(CHAT).text).toContain("→ Sunday Brunch");
    await hook(c, msg(CHAT, "https://example.com/song"));
    expect(tg.last(CHAT).text).toContain("I can only download");
    expect(await pushedJob(c, t)).toMatchObject({ playlist: "Sunday Brunch" });
  });

  it("answers /playlists, /search, /status and /help", async () => {
    const { c, tg } = tgCloud();
    const { t } = await paired(c);
    await hook(c, msg(CHAT, "/playlists"));
    expect(tg.last(CHAT).text).toContain("hasn't shared its Rekordbox library");
    await upload(c, t);
    await hook(c, msg(CHAT, "/playlists@DJSyncAppBot"));
    const list = tg.last(CHAT).text.split("\n");
    expect(list[0]).toBe("5 playlists:");
    expect(list[1]).toBe("• DJ Sync/Friday — 1 track");
    await hook(c, msg(CHAT, "/playlists amapiano"));
    expect(tg.last(CHAT).text.split("\n")).toHaveLength(3);
    await hook(c, msg(CHAT, "/search burna"));
    expect(tg.last(CHAT).text).toBe("1 track match:\n• Burna Boy — Ye · 102 BPM · 8A");
    await hook(c, msg(CHAT, "/search"));
    expect(tg.last(CHAT).text).toContain("Usage");
    await hook(c, msg(CHAT, "/status"));
    expect(tg.last(CHAT).text).toBe("Nothing yet — send me a link.");
    await hook(c, msg(CHAT, `${YT(8)} friday`));
    await hook(c, msg(CHAT, "/status"));
    expect(tg.last(CHAT).text).toMatch(/^Latest:\n• 1 link → Friday: queued — Queued\./);
    await hook(c, msg(CHAT, "/help"));
    expect(tg.last(CHAT).text).toContain("/playlists");
    await hook(c, msg(CHAT, "/dance"));
    expect(tg.last(CHAT).text).toContain("I don't know /dance");
    await hook(c, msg(CHAT, "just chatting"));
    expect(tg.last(CHAT).text).toContain("Send me a Spotify or YouTube link");
  });

  it("tells the chat when its job finishes", async () => {
    const { c, tg } = tgCloud();
    const { t } = await paired(c);
    await upload(c, t);
    await hook(c, msg(CHAT, `${YT(9)} friday`));
    const ws = await c.connect(t);
    await c.hello(t, ws);
    const job = ws.frames().find((f) => f.type === "job")!;
    await c.send(t, ws, { type: "complete", job_id: job.job_id, state: "done", message: "1 track ready in Friday." });
    expect(tg.last(CHAT).text).toBe("✅ 1 track ready in Friday.");
    const sent = tg.texts(CHAT).length;
    await c.send(t, ws, { type: "complete", job_id: job.job_id, state: "done", message: "again" });
    expect(tg.texts(CHAT)).toHaveLength(sent); // duplicates aren't re-announced

    await hook(c, msg(CHAT, `${YT(10)} friday`));
    await c.send(t, ws, { type: "ready" });
    const second = ws.frames().filter((f) => f.type === "job").at(-1)!;
    await c.send(t, ws, { type: "complete", job_id: second.job_id, state: "failed", message: "YouTube said no." });
    expect(tg.last(CHAT).text).toBe("⚠️ YouTube said no.");
  });

  it(`stops listening after ${TELEGRAM_MESSAGES_PER_HOUR} messages an hour, with one warning`, async () => {
    const { c, tg } = tgCloud();
    await paired(c);
    const before = tg.texts(CHAT).length;
    for (let i = 0; i < TELEGRAM_MESSAGES_PER_HOUR; i++) await hook(c, msg(CHAT, "/help"));
    expect(tg.texts(CHAT).length - before).toBe(TELEGRAM_MESSAGES_PER_HOUR);
    await hook(c, msg(CHAT, "/help"));
    expect(tg.last(CHAT).text).toContain("a lot of messages");
    await hook(c, msg(CHAT, "/help"));
    expect(tg.texts(CHAT).length - before).toBe(TELEGRAM_MESSAGES_PER_HOUR + 1);
    c.advance(3600);
    await hook(c, msg(CHAT, "/help"));
    expect(tg.last(CHAT).text).toContain("/playlists");
  });

  it("sets up the webhook, commands and descriptions for the admin", async () => {
    const { c, tg } = tgCloud();
    const setup = (auth?: string) =>
      c.call(req("POST", "/v2/admin/telegram/setup", {}, auth ? { authorization: `Bearer ${auth}` } : {}));
    expect((await setup()).status).toBe(401);
    const res = await setup(ADMIN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, webhook_url: "https://djsync.jeffrey.build/telegram/webhook", bot: { username: "DJSyncAppBot" } });
    expect(tg.of("setWebhook")[0]).toEqual({
      url: "https://djsync.jeffrey.build/telegram/webhook",
      secret_token: TG.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    expect(tg.of("setMyCommands")[0].commands.map((x: Any) => x.command)).toEqual(["playlists", "search", "status", "help", "stop"]);
    expect(tg.of("setMyDescription")).toHaveLength(1);
    expect(tg.of("setMyShortDescription")).toHaveLength(1);

    const bare = makeCloud(undefined, {}, { telegram: new FakeTelegram() });
    const off = await bare.call(req("POST", "/v2/admin/telegram/setup", {}, { authorization: `Bearer ${ADMIN}` }));
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: "telegram_not_configured" });
  });
});

describe("Telegram helpers", () => {
  it("splits links from a playlist hint", () => {
    expect(splitMessage("https://youtu.be/x add to my gqom playlist please")).toEqual({
      links: ["https://youtu.be/x"],
      full: "add to my gqom playlist please",
      hint: "gqom",
    });
    expect(splitMessage("Into The Night https://youtu.be/x.")).toEqual({
      links: ["https://youtu.be/x"],
      full: "Into The Night",
      hint: "Night",
    });
    expect(splitMessage("hi")).toEqual({ links: [], full: "hi", hint: "hi" });
  });

  it("clips long replies at whole lines", () => {
    const text = Array.from({ length: 500 }, (_, i) => `• playlist number ${i}`).join("\n");
    const out = clip(text);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toMatch(/…and \d+ more$/);
  });
});
