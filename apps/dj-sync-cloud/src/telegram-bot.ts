// The DJ Sync bot for one paired chat, run inside that DJ's Tenant
// (connect-anywhere spec §1): links (with a playlist hint, or buttons),
// /playlists, /search, /status, /help, /stop. Replies are plain text.

import { TELEGRAM_BUTTONS, TELEGRAM_PENDING_SECONDS } from "./constants";
import { agentStatus, offlineNote, stateWord, submit, type Deps } from "./jobs";
import { NO_LIBRARY, closestPlaylists, normalizeName, playlistPath, plural, resolvePlaylist, searchTracks, sortPlaylists } from "./library";
import { extractMediaRef, type MediaRef } from "./links";
import type { SqlStore } from "./sqlstore";
import type { LibPlaylist } from "./store";
import { answerCallback, clip, send, updateChat, type TelegramApi, type TgUpdate } from "./telegram";
import { randomBase64url } from "./bytes";
import { addSeconds } from "./util";

export interface BotHost {
  store: SqlStore;
  deps: Deps;
  api: TelegramApi;
  now(): Date;
  /** Delete this chat's link and forget the chat everywhere (/stop). */
  disconnect(linkId: string): Promise<void>;
  /** The per-chat limit: "ok", "warn" (tell them once), or "drop" (ignore). */
  rateLimit(chatId: string): "ok" | "warn" | "drop";
}

const DJ_SYNC_FOLDER = "DJ Sync";

export const HELP =
  "Send me a Spotify or YouTube link and it goes into your Rekordbox on your Mac. " +
  "Add a playlist name after the link to choose where it goes (e.g. “https://youtu.be/… gqom”), " +
  "or pick one from the buttons I show.\n\n" +
  "/playlists — your playlists (add words to filter)\n" +
  "/search <words> — find tracks in your library\n" +
  "/status — your latest downloads and changes\n" +
  "/stop — disconnect this chat";

export function welcome(firstName: string | null): string {
  return `✅ ${firstName ? `Hi ${firstName} — DJ Sync` : "DJ Sync"} is connected to this chat.\n\n${HELP}`;
}

/**
 * Handle one update for a chat already routed to this DJ. Returns false when
 * the chat isn't (or is no longer) paired here.
 */
export async function handleUpdate(host: BotHost, update: TgUpdate, linkId: string): Promise<boolean> {
  const who = updateChat(update);
  if (!who) return true;
  const chat = host.store.telegramChatByChat(who.chatId);
  if (!chat || chat.link_id !== linkId) return false;

  const verdict = host.rateLimit(who.chatId);
  if (verdict !== "ok") {
    if (who.callbackId) await answerCallback(host.api, who.callbackId);
    if (verdict === "warn") {
      await send(host.api, who.chatId, "That's a lot of messages — DJ Sync will listen again in a little while.");
    }
    return true;
  }
  host.store.purgeTgPendingBefore(addSeconds(host.now(), -TELEGRAM_PENDING_SECONDS).toISOString());

  const callback = update.callback_query;
  if (callback && who.callbackId) {
    await onButton(host, who.chatId, who.callbackId, callback.data ?? "", callback.message?.message_id ?? null);
    return true;
  }
  const text = who.text.trim();
  if (text.startsWith("/")) {
    await onCommand(host, who.chatId, linkId, text);
    return true;
  }
  await onText(host, who.chatId, text);
  return true;
}

// ---------- links ----------

const FILLER_BEFORE = new Set(["add", "put", "save", "send", "download", "to", "into", "in", "the", "my", "this", "these", "please"]);
const FILLER_AFTER = new Set(["playlist", "please"]);

/** The links in a message and what's left as a playlist hint (as typed, and without filler words). */
export function splitMessage(text: string): { links: string[]; full: string; hint: string } {
  const links: string[] = [];
  const words: string[] = [];
  for (const raw of text.split(/\s+/u)) {
    if (raw === "") continue;
    if (/^(https?:\/\/|spotify:)/iu.test(raw)) links.push(raw.replace(/[),.!?]+$/u, ""));
    else words.push(raw);
  }
  const trimmed = [...words];
  while (trimmed.length > 0 && FILLER_BEFORE.has(trimmed[0]!.toLocaleLowerCase())) trimmed.shift();
  while (trimmed.length > 0 && FILLER_AFTER.has(trimmed.at(-1)!.toLocaleLowerCase())) trimmed.pop();
  return { links, full: words.join(" "), hint: trimmed.join(" ") };
}

async function onText(host: BotHost, chatId: string, text: string): Promise<void> {
  const { links, full, hint } = splitMessage(text);
  if (links.length === 0) {
    await send(host.api, chatId, `Send me a Spotify or YouTube link to download it into Rekordbox.\n\n${HELP}`);
    return;
  }
  const media: MediaRef[] = [];
  const rejected: string[] = [];
  for (const l of links) {
    const r = extractMediaRef(l);
    if (!r.ok) rejected.push(l);
    else if (!media.some((m) => m.url === r.media.url)) media.push(r.media);
  }
  if (media.length === 0) {
    await send(
      host.api,
      chatId,
      "I can only download https Spotify links (track, album, playlist) and YouTube links (video, playlist).",
    );
    return;
  }
  if (media.length > host.deps.config.maxUrls) {
    await send(host.api, chatId, `That's ${media.length} links; send at most ${host.deps.config.maxUrls} at a time.`);
    return;
  }
  const urls = media.map((m) => m.url);
  const skipped = rejected.length > 0 ? ` (Skipped ${plural(rejected.length, "unsupported link")}.)` : "";

  const playlists = await host.store.getLibraryPlaylists();
  if (!playlists) {
    // No library shared yet: use the name as given (or the default).
    await send(host.api, chatId, (await queue(host, chatId, urls, hint || null, null)) + skipped);
    return;
  }
  if (hint !== "") {
    for (const candidate of [...new Set([full, hint])]) {
      const m = resolvePlaylist(playlists, candidate);
      if (m.kind === "one") {
        await send(host.api, chatId, (await queue(host, chatId, urls, m.playlist.name, m.playlist.id)) + skipped);
        return;
      }
    }
  }

  const id = randomBase64url(6);
  host.store.addTgPending({ id, chat_id: chatId, urls, hint: hint || null, created_at: host.now().toISOString() });
  let question: string;
  let options: LibPlaylist[];
  let offerNew = false;
  if (hint === "") {
    question = `Which playlist should ${plural(urls.length, "link")} go into?`;
    options = djSyncFirst(playlists).slice(0, TELEGRAM_BUTTONS);
  } else {
    const m = resolvePlaylist(playlists, hint);
    if (m.kind === "many") {
      question = `${m.options.length} playlists are called “${hint}”. Which one?`;
      options = m.options.slice(0, TELEGRAM_BUTTONS);
    } else {
      options = (m.kind === "none" ? m.suggestions : closestPlaylists(playlists, hint, TELEGRAM_BUTTONS)).slice(0, TELEGRAM_BUTTONS);
      question =
        options.length > 0
          ? `I couldn't find a playlist called “${hint}”. Did you mean one of these?`
          : `I couldn't find a playlist called “${hint}”.`;
      offerNew = true;
    }
  }
  const button = (label: string, target: string) => ({ text: label.slice(0, 64), callback_data: `d:${id}:${target}` });
  const rows = options
    .filter((p) => new TextEncoder().encode(`d:${id}:${p.id}`).length <= 64)
    .map((p) => [button(`${playlistPath(p)} (${p.track_ids.length})`, p.id)]);
  rows.push([button(`Default (${host.deps.config.defaultPlaylist})`, "def")]);
  if (offerNew) rows.push([button(`New playlist: ${hint}`, "new")]);
  await send(host.api, chatId, question + skipped, { reply_markup: { inline_keyboard: rows } });
}

async function onButton(host: BotHost, chatId: string, callbackId: string, data: string, messageId: number | null): Promise<void> {
  const m = /^d:([A-Za-z0-9_-]{8}):(.+)$/u.exec(data);
  const pending = m ? host.store.getTgPending(m[1]!) : null;
  if (!m || !pending || pending.chat_id !== chatId) {
    await answerCallback(host.api, callbackId, "That choice has expired — send the link again.");
    return;
  }
  let name: string | null = null;
  let playlistId: string | null = null;
  const target = m[2]!;
  if (target === "new") {
    name = pending.hint;
  } else if (target !== "def") {
    const p = (await host.store.getLibraryPlaylists())?.find((x) => x.id === target);
    if (!p) {
      await answerCallback(host.api, callbackId, "That playlist isn't in your library any more.");
      return;
    }
    name = p.name;
    playlistId = p.id;
  }
  const text = await queue(host, chatId, pending.urls, name, playlistId);
  host.store.deleteTgPending(pending.id);
  await answerCallback(host.api, callbackId);
  if (messageId !== null) {
    try {
      await host.api.call("editMessageText", { chat_id: chatId, message_id: messageId, text: clip(text) });
      return;
    } catch {
      /* fall through to a new message */
    }
  }
  await send(host.api, chatId, text);
}

/** Queue a download and say what happens next. */
async function queue(host: BotHost, chatId: string, urls: string[], name: string | null, playlistId: string | null): Promise<string> {
  const media = urls.map((u) => extractMediaRef(u)).flatMap((r) => (r.ok ? [r.media] : []));
  const sub = await submit(host.deps, media, name, "mcp", playlistId);
  if (!sub.ok) return `Couldn't queue that: ${sub.error}`;
  const { job, deduplicated } = sub.value;
  host.store.addTgJob(job.id, chatId);
  let text = deduplicated
    ? `That's already queued → ${job.playlist}. I'll tell you when it's in Rekordbox.`
    : `Queued: ${plural(job.urls.length, "link")} → ${job.playlist}. I'll tell you when it's in Rekordbox.`;
  const agent = await agentStatus(host.deps);
  if (!agent.online) text += offlineNote(agent, host.now());
  return text;
}

function djSyncFirst(playlists: LibPlaylist[]): LibPlaylist[] {
  const sorted = sortPlaylists(playlists);
  return [...sorted.filter((p) => p.folder === DJ_SYNC_FOLDER), ...sorted.filter((p) => p.folder !== DJ_SYNC_FOLDER)];
}

// ---------- commands ----------

async function onCommand(host: BotHost, chatId: string, linkId: string, text: string): Promise<void> {
  const [head = "", ...rest] = text.split(/\s+/u);
  const command = head.slice(1).split("@")[0]!.toLocaleLowerCase();
  const args = rest.join(" ").trim();
  switch (command) {
    case "start":
    case "help":
      return void (await send(host.api, chatId, HELP));
    case "playlists":
      return void (await send(host.api, chatId, await playlistsText(host, args)));
    case "search":
      return void (await send(host.api, chatId, await searchText(host, args)));
    case "status":
      return void (await send(host.api, chatId, await statusText(host)));
    case "stop":
      await send(host.api, chatId, "Disconnected. To connect again: DJ Sync on your Mac → Assistants → Connect Telegram.");
      return host.disconnect(linkId);
    default:
      return void (await send(host.api, chatId, `I don't know /${command}.\n\n${HELP}`));
  }
}

const PLAYLISTS_SHOWN = 40;
const SEARCH_SHOWN = 10;

async function playlistsText(host: BotHost, words: string): Promise<string> {
  const playlists = await host.store.getLibraryPlaylists();
  if (!playlists) return NO_LIBRARY;
  const q = normalizeName(words);
  const rows = djSyncFirst(playlists).filter((p) => q === "" || normalizeName(playlistPath(p)).includes(q));
  if (rows.length === 0) return `No playlists match “${words}”.`;
  const shown = rows.slice(0, PLAYLISTS_SHOWN).map((p) => `• ${playlistPath(p)} — ${plural(p.track_ids.length, "track")}`);
  const more = rows.length > shown.length ? `\n…and ${rows.length - shown.length} more — try /playlists <words>` : "";
  return `${plural(rows.length, "playlist")}${q ? ` matching “${words}”` : ""}:\n${shown.join("\n")}${more}`;
}

async function searchText(host: BotHost, words: string): Promise<string> {
  if (words === "") return "Usage: /search <words>, e.g. /search burna boy";
  const tracks = await host.store.getLibraryTracks();
  if (!tracks) return NO_LIBRARY;
  const hits = searchTracks(tracks, { query: words });
  if (hits.length === 0) return `No tracks match “${words}”.`;
  const lines = hits.slice(0, SEARCH_SHOWN).map((t) => {
    const extra = [t.bpm !== null ? `${Math.round(t.bpm * 10) / 10} BPM` : null, t.key].filter(Boolean).join(" · ");
    return `• ${t.artist ? `${t.artist} — ` : ""}${t.title}${extra ? ` · ${extra}` : ""}`;
  });
  return `${plural(hits.length, "track")} match${hits.length > SEARCH_SHOWN ? ` (showing ${SEARCH_SHOWN})` : ""}:\n${lines.join("\n")}`;
}

async function statusText(host: BotHost): Promise<string> {
  const jobs = await host.store.recentJobs(5);
  if (jobs.length === 0) return "Nothing yet — send me a link.";
  const lines = jobs.map((j) => {
    const what = j.kind === "library" ? (j.summary ?? j.playlist) : `${plural(j.urls.length, "link")} → ${j.playlist}`;
    const msg = j.message.length > 100 ? `${j.message.slice(0, 99)}…` : j.message;
    return `• ${what}: ${stateWord(j.state, j.kind)} — ${msg}`;
  });
  const agent = await agentStatus(host.deps);
  return `Latest:\n${lines.join("\n")}${agent.online ? "" : `\n${offlineNote(agent, host.now()).trim()}`}`;
}
