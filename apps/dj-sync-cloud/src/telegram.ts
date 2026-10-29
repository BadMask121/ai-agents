// The shared DJ Sync Telegram bot, Worker side (connect-anywhere spec §1):
// the webhook (secret header, pairing by /start <code>, routing each chat to
// its DJ's Tenant) and the one-time setup route. What the bot does for a
// paired chat lives in the Tenant (telegram-bot.ts).
//
// The Bot API is injected (`TelegramApi`) so tests never call Telegram.
// The token is only ever in the API URL, which is never logged.

import { readJson } from "./http";
import { json, empty, timingSafeEqual } from "./util";

export interface TelegramApi {
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
}

export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_USERNAME?: string;
  PUBLIC_HOST?: string;
}

/** The real Bot API (https://core.telegram.org/bots/api). */
export function botApi(token: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): TelegramApi {
  return {
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      const res = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
      if (!res.ok || !body.ok) throw new Error(`telegram ${method} failed: ${res.status} ${body.description ?? ""}`.trim());
      return body.result as T;
    },
  };
}

/** The bot exists: token, webhook secret and its @username (for t.me links). */
export function telegramConfigured(env: TelegramEnv): boolean {
  return [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, env.TELEGRAM_BOT_USERNAME].every(
    (v) => typeof v === "string" && v.trim() !== "",
  );
}

export const TELEGRAM_MAX_TEXT = 4096;

/** Telegram's message limit, trimming whole lines ("…and N more"). */
export function clip(text: string, max = TELEGRAM_MAX_TEXT): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const tail = `…and ${lines.length - i} more`;
    if (size + lines[i]!.length + 1 + tail.length + 1 > max) {
      kept.push(tail);
      return kept.join("\n");
    }
    kept.push(lines[i]!);
    size += lines[i]!.length + 1;
  }
  return kept.join("\n").slice(0, max);
}

/** Send, never throw (a failed reply mustn't fail the update). */
export async function send(api: TelegramApi, chatId: string, text: string, extra: Record<string, unknown> = {}) {
  try {
    return await api.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: clip(text),
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function answerCallback(api: TelegramApi, id: string, text?: string) {
  try {
    await api.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
  }
}

export const NOT_CONNECTED =
  "This chat isn't connected to DJ Sync. In DJ Sync on your Mac: Assistants → Connect Telegram, then tap the link it shows.";
export const BAD_CODE =
  "That connection link has expired or was already used. In DJ Sync on your Mac: Assistants → Connect Telegram (or New code), then tap the new link.";
export const SOMETHING_WRONG = "Something went wrong; try again in a minute.";

// ---------- updates ----------

export interface TgUser {
  username?: string;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number | string; type?: string };
  from?: TgUser;
  text?: string;
}

export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: { id: string; from?: TgUser; data?: string; message?: TgMessage };
}

/** Who sent it and from which chat; null for anything we don't handle (groups, channels, edits). */
export function updateChat(u: TgUpdate): { chatId: string; user: TgUser; text: string; callbackId: string | null } | null {
  const msg = u.message ?? u.callback_query?.message;
  if (!msg || (msg.chat.type !== undefined && msg.chat.type !== "private")) return null;
  return {
    chatId: String(msg.chat.id),
    user: (u.callback_query ? u.callback_query.from : u.message?.from) ?? {},
    text: u.message?.text ?? "",
    callbackId: u.callback_query?.id ?? null,
  };
}

const START = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/;
const PAIRING_CODE = /^[A-Za-z0-9_-]{22}$/;

// ---------- Worker: the webhook ----------

interface Namespaces {
  TENANT: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
}

const registry = (ns: Namespaces) => ns.REGISTRY.get(ns.REGISTRY.idFromName("registry"));
const tenant = (ns: Namespaces, id: string) => ns.TENANT.get(ns.TENANT.idFromName(id));
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/**
 * POST /telegram/webhook. Always 200 for anything that passed the secret
 * check (Telegram retries non-2xx), so a bad update never jams the queue.
 */
export async function telegramWebhook(req: Request, env: TelegramEnv, ns: Namespaces, api: TelegramApi | null): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!api || secret === "") return empty(404);
  if (req.method !== "POST") return empty(405, { allow: "POST" });
  if (!timingSafeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = await readJson(req);
  if (body.kind !== "ok" || typeof body.value !== "object" || body.value === null) return json({ ok: true });
  const update = body.value as TgUpdate;
  const who = updateChat(update);
  if (!who) return json({ ok: true });

  try {
    const start = who.callbackId === null ? START.exec(who.text.trim()) : null;
    if (start?.[1] && PAIRING_CODE.test(start[1])) {
      await pair(start[1], who.chatId, who.user, ns, api);
      return json({ ok: true });
    }
    const res = await registry(ns).fetch(`https://registry/__/telegram/chat?id=${encodeURIComponent(who.chatId)}`);
    if (res.status !== 200) {
      if (who.callbackId) await answerCallback(api, who.callbackId, "This chat isn't connected to DJ Sync.");
      await send(api, who.chatId, NOT_CONNECTED);
      return json({ ok: true });
    }
    const { tenant_id, link_id } = (await res.json()) as { tenant_id: string; link_id: string };
    const handled = await tenant(ns, tenant_id).fetch("https://tenant/__/telegram/update", post({ update, link_id, chat_id: who.chatId }));
    if (handled.status === 404) {
      // The DJ (or this link) is gone: forget the chat.
      await registry(ns).fetch("https://registry/__/telegram/forget_chat", post({ chat_id: who.chatId, tenant_id }));
      if (who.callbackId) await answerCallback(api, who.callbackId);
      await send(api, who.chatId, NOT_CONNECTED);
    }
  } catch (e) {
    console.error(`telegram update failed: ${e instanceof Error ? e.message : String(e)}`);
    if (who.callbackId) await answerCallback(api, who.callbackId);
    await send(api, who.chatId, SOMETHING_WRONG);
  }
  return json({ ok: true });
}

/** /start <code>: bind this chat to the DJ whose Mac issued the code. */
async function pair(code: string, chatId: string, user: TgUser, ns: Namespaces, api: TelegramApi): Promise<void> {
  const res = await registry(ns).fetch("https://registry/__/telegram/pair", post({ code, chat_id: chatId }));
  if (res.status !== 200) {
    await send(api, chatId, BAD_CODE);
    return;
  }
  const paired = (await res.json()) as {
    tenant_id: string;
    link_id: string;
    previous: { tenant_id: string; link_id: string } | null;
    replaced: string[];
  };
  // One chat belongs to one DJ: the latest pairing wins.
  if (paired.previous && paired.previous.tenant_id !== paired.tenant_id) {
    await tenant(ns, paired.previous.tenant_id).fetch("https://tenant/__/telegram/unbind", post({ chat_id: chatId }));
  }
  for (const old of paired.replaced) {
    await send(api, old, "This chat was disconnected from DJ Sync: Telegram was connected again from another chat.");
  }
  const bound = await tenant(ns, paired.tenant_id).fetch(
    "https://tenant/__/telegram/bind",
    post({ link_id: paired.link_id, chat_id: chatId, username: user.username ?? null, first_name: user.first_name ?? null }),
  );
  if (bound.status !== 200) {
    await registry(ns).fetch("https://registry/__/telegram/forget_chat", post({ chat_id: chatId, tenant_id: paired.tenant_id }));
    await send(api, chatId, BAD_CODE);
  }
}

// ---------- Worker: one-time bot setup ----------

export const BOT_COMMANDS = [
  { command: "playlists", description: "Your Rekordbox playlists (add words to filter)" },
  { command: "search", description: "Find tracks in your library" },
  { command: "rename", description: "Rename a playlist: /rename Friday to Friday Night" },
  { command: "status", description: "Your latest downloads and changes" },
  { command: "help", description: "How to use DJ Sync here" },
  { command: "stop", description: "Disconnect this chat from DJ Sync" },
];

/**
 * POST /v2/admin/telegram/setup (Bearer ADMIN_TOKEN, checked by the router):
 * point the bot's webhook here and set its commands and descriptions.
 */
export async function telegramSetup(env: TelegramEnv, api: TelegramApi | null): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!api || secret === "") {
    return json(
      { error: "telegram_not_configured", detail: "Set the TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET secrets first." },
      503,
    );
  }
  const webhookUrl = `https://${env.PUBLIC_HOST || "djsync.jeffrey.build"}/telegram/webhook`;
  try {
    await api.call("setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    await api.call("setMyCommands", { commands: BOT_COMMANDS });
    await api.call("setMyDescription", {
      description:
        "DJ Sync puts Spotify and YouTube links into your Rekordbox library on your Mac, and lets you browse your playlists. " +
        "Connect it from the DJ Sync app on your Mac: Assistants → Connect Telegram.",
    });
    await api.call("setMyShortDescription", { short_description: "Send links to your Rekordbox, from your phone." });
    const bot = await api.call<Record<string, unknown>>("getMe", {});
    return json({ ok: true, webhook_url: webhookUrl, bot });
  } catch (e) {
    return json({ error: "telegram_error", detail: e instanceof Error ? e.message : String(e) }, 502);
  }
}
