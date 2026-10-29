// Shared by the Telegram bot and assistant tests: a paired chat on a whole
// cloud, a library snapshot, and webhook update builders.

import { expect } from "vitest";
import type { JevClient } from "../src/jev";
import { FakeTelegram, agentHeaders, makeCloud, req, type Any, type FakeAi, type Registered } from "./cloud";

export const TG = {
  TELEGRAM_BOT_TOKEN: "123456:fake-token-for-tests",
  TELEGRAM_WEBHOOK_SECRET: "hook-secret-0123456789abcdef",
  TELEGRAM_BOT_USERNAME: "DJSyncAppBot",
};

export const LIBRARY = {
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

export function tgCloud(ai?: FakeAi, router?: JevClient, titles?: Record<string, string>) {
  const tg = new FakeTelegram();
  const c = makeCloud(undefined, { ...TG }, { env: TG, telegram: tg, ai, router, titles });
  return { c, tg };
}

export type Cloud = ReturnType<typeof makeCloud>;
export const CHAT = 555;

export const hook = (c: Cloud, update: unknown, secret: string | null = TG.TELEGRAM_WEBHOOK_SECRET) =>
  c.call(req("POST", "/telegram/webhook", update, secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }));
export const msg = (chat: number, text: string, from: Any = { username: "djbob", first_name: "Bob" }, type = "private") => ({
  update_id: 1,
  message: { message_id: 7, chat: { id: chat, type }, from, text },
});
export const tap = (chat: number, data: string, messageId = 50) => ({
  update_id: 2,
  callback_query: { id: `cb-${data}`, from: { username: "djbob" }, data, message: { message_id: messageId, chat: { id: chat, type: "private" } } },
});
export const codeOf = (link: Any) => new URL(link.url).searchParams.get("start")!;
export const links = async (c: Cloud, t: Registered): Promise<Any[]> =>
  (await c.call(req("GET", "/v2/agent/links", undefined, agentHeaders(t)))).json() as Promise<Any[]>;
export const upload = (c: Cloud, t: Registered, body: unknown = LIBRARY) => c.call(req("PUT", "/v2/agent/library", body, agentHeaders(t)));

export async function paired(c: Cloud, chat = CHAT) {
  const t = await c.registered(`198.51.100.${chat % 250}`);
  const link = await c.link(t, "telegram");
  expect((await hook(c, msg(chat, `/start ${codeOf(link)}`))).status).toBe(200);
  return { t, link };
}

/** The pushed job frame once the Mac connects (to see playlist / playlist_id). */
export async function pushedJob(c: Cloud, t: Registered): Promise<Any> {
  const ws = await c.connect(t);
  await c.hello(t, ws);
  return ws.frames().find((f) => f.type === "job");
}

/** The DJ's tenant store (private on Tenant). */
export const storeOf = (c: Cloud, t: Registered): Any => (c.tenant(t) as Any).store;
