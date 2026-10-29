// The DJ Sync bot for one paired chat, run inside that DJ's Tenant
// (connect-anywhere spec §1): links (with a playlist hint, or buttons),
// /playlists, /search, /status, /help, /stop. What isn't clear from code goes
// to Jev when it's configured (routing.ts decides what to trust), then to the
// assistant (telegram-agent.ts, spec §1c). Replies are plain text.

import { AGENT_MODEL } from "./constants";
import { agentEvent, type AgentEvent } from "./metrics";
import type { JevClient, JevRoute } from "./jev";
import { decideLink, decideText, exactPlaylist, looksLikeInstruction, renameRequest } from "./routing";
import { sha256Hex } from "./bytes";
import { MAX_PLAYLIST_NAME, TELEGRAM_BUTTONS, TELEGRAM_PENDING_SECONDS } from "./constants";
import { agentStatus, offlineNote, stateWord, submit, type Deps } from "./jobs";
import { NO_LIBRARY, closestPlaylists, normalizeName, playlistPath, plural, resolvePlaylist, sortPlaylists } from "./library";
import { libraryIndex, searchIndex } from "./search";
import { asLink, extractMediaRef, type MediaRef } from "./links";
import { isCollection } from "./oembed";
import type { SqlStore } from "./sqlstore";
import type { LibPlaylist } from "./store";
import { answerCallback, clip, send, updateChat, type TelegramApi, type TgUpdate } from "./telegram";
import { randomBase64url } from "./bytes";
import { resolveConfirmation, runAgent, type AiRunner } from "./telegram-agent";
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
  /** Workers AI for free text; null without the binding (then the bot stays rule-based). */
  agent: { ai: AiRunner; model?: string } | null;
  /** Hears about each assistant call (metrics, alerts); optional. */
  onAgentEvent?(e: AgentEvent): void | Promise<void>;
  /** The owner's private /stats: null for everyone else (then /stats isn't a command). */
  ownerStats?(chatId: string): Promise<string> | null;
  /** The owner's private /metrics (Telegram HTML): null for everyone else. */
  ownerMetrics?(chatId: string): Promise<string> | null;
  /** Jev, the fast router; null when it isn't configured (then code, then the assistant). */
  router?: JevClient | null;
  /** Hears what the router decided and which button the DJ picked (logs); optional. */
  onRouterEvent?(e: Record<string, unknown>): void;
}

const DJ_SYNC_FOLDER = "DJ Sync";
const STOP_YES = "x:y";
const STOP_NO = "x:n";
const DISCONNECTED = "Disconnected. To connect again: DJ Sync on your Mac → Assistants → Connect Telegram.";

export const HELP =
  "Send me a Spotify, YouTube or SoundCloud link and it goes into your Rekordbox on your Mac. " +
  "Add a playlist name after the link to choose where it goes (e.g. “https://youtu.be/… gqom”), " +
  "or pick one from the buttons I show. You can also just ask, e.g. “list the playlists in my DJ Sync " +
  "folder” or “move the first two tracks of Friday into Gqom”.\n\n" +
  "/playlists — your playlists (add words to filter)\n" +
  "/search <words> — find tracks in your library\n" +
  "/rename <playlist> to <new name> — rename a playlist\n" +
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
    await onButton(host, who.chatId, who.callbackId, callback.data ?? "", callback.message?.message_id ?? null, linkId);
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

const FILLER_BEFORE = new Set(["add", "put", "save", "send", "download", "get", "grab", "to", "into", "in", "the", "my", "this", "these", "please"]);
const FILLER_AFTER = new Set(["playlist", "album", "please", "pls", "for", "me", "now"]);

/** The links in a message and what's left as a playlist hint (as typed, and without filler words). */
export function splitMessage(text: string): { links: string[]; full: string; hint: string } {
  const links: string[] = [];
  const words: string[] = [];
  for (const raw of text.split(/\s+/u)) {
    if (raw === "") continue;
    const link = asLink(raw);
    if (link !== null) links.push(link);
    else words.push(raw);
  }
  const trimmed = [...words];
  while (trimmed.length > 0 && FILLER_BEFORE.has(trimmed[0]!.toLocaleLowerCase())) trimmed.shift();
  while (trimmed.length > 0 && FILLER_AFTER.has(trimmed.at(-1)!.toLocaleLowerCase())) trimmed.pop();
  return { links, full: words.join(" "), hint: trimmed.join(" ") };
}

async function onText(host: BotHost, chatId: string, text: string): Promise<void> {
  const { links, full, hint } = splitMessage(text);
  if (links.length === 0) return onPlainText(host, chatId, text);
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
      "I can only download https Spotify links (track, album, playlist), YouTube links (video, playlist) and SoundCloud links (track, set).",
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
  const instruction = looksLikeInstruction(hint);
  // "Download this playlist": one playlist or album link and no playlist named → its own name.
  if (hint === "" && media.length === 1 && isCollection(media[0]!.url)) {
    const title = await host.deps.mediaTitle?.(media[0]!.url);
    const m = title && playlists ? resolvePlaylist(playlists, title) : null;
    if (title && m?.kind !== "many") {
      const existing = m?.kind === "one" ? m.playlist : null;
      await routerEvent(host, chatId, { layer: "code", decision: "queue", playlist: existing?.id ?? null, named_after_link: true });
      const note = existing ? "" : ` (a new playlist named after the ${media[0]!.kind === "spotify" ? "Spotify" : "YouTube"} one)`;
      await send(host.api, chatId, (await queue(host, chatId, urls, existing?.name ?? title, existing?.id ?? null, note)) + skipped);
      return;
    }
  }
  if (hint !== "" && playlists && !instruction) {
    const exact = exactPlaylist(playlists, full, hint);
    if (exact) {
      await routerEvent(host, chatId, { layer: "code", decision: "queue", playlist: exact.id });
      await send(host.api, chatId, (await queue(host, chatId, urls, exact.name, exact.id)) + skipped);
      return;
    }
  }
  // A whole instruction or a question around the link ("check these against Shayo 29 and copy…"):
  // straight to the assistant.
  if (instruction && host.agent) {
    await routerEvent(host, chatId, { layer: "code", decision: "assistant" });
    if (await ask(host, chatId, text, true)) return;
  }
  let suggest: LibPlaylist[] = [];
  const route = hint !== "" && !instruction && playlists ? await jev(host, chatId, text, urls, playlists) : null;
  if (route && playlists) {
    const d = decideLink(route, hint, playlists);
    await routerEvent(host, chatId, { layer: "jev", decision: d.kind, ...routeFields(route) });
    if (d.kind === "queue") {
      await send(host.api, chatId, (await queue(host, chatId, urls, d.playlist.name, d.playlist.id)) + skipped);
      return;
    }
    if (d.kind === "assistant" && host.agent && (await ask(host, chatId, text, true))) return;
    if (d.kind === "buttons") suggest = d.suggest;
  } else if (host.agent && hint.split(/\s+/u).filter(Boolean).length >= 3) {
    // More than a playlist name after the link ("into a new playlist called
    // Lagos Nights"): the assistant reads it. A short unclear name or a
    // duplicate keeps the one-tap buttons below.
    if (await ask(host, chatId, text, true)) return;
  }
  if (!playlists) {
    // No library shared yet: use the name as given (or the default).
    await send(host.api, chatId, (await queue(host, chatId, urls, hint || null, null)) + skipped);
    return;
  }

  const id = randomBase64url(6);
  host.store.addTgPending({ id, chat_id: chatId, urls, hint: hint || null, created_at: host.now().toISOString() });
  let question: string;
  let options: LibPlaylist[];
  let offerNew = false;
  if (hint === "" || instruction) {
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
  // Jev's best guesses first.
  options = [...new Map([...suggest, ...options].map((p) => [p.id, p])).values()].slice(0, TELEGRAM_BUTTONS);
  const button = (label: string, target: string) => ({ text: label.slice(0, 64), callback_data: `d:${id}:${target}` });
  const rows = options
    .filter((p) => new TextEncoder().encode(`d:${id}:${p.id}`).length <= 64)
    .map((p) => [button(`${playlistPath(p)} (${p.track_ids.length})`, p.id)]);
  rows.push([button(`Default (${host.deps.config.defaultPlaylist})`, "def")]);
  if (offerNew) rows.push([button(`New playlist: ${hint}`, "new")]);
  await send(host.api, chatId, question + skipped, { reply_markup: { inline_keyboard: rows } });
  await routerEvent(host, chatId, { layer: "buttons", pending: id, offered: options.map((p) => p.id) });
}

/** A message without links: Jev for list / search when it's sure, else the assistant. */
async function onPlainText(host: BotHost, chatId: string, text: string): Promise<void> {
  if (await askRename(host, chatId, text)) return;
  const playlists = host.router ? await host.store.getLibraryPlaylists() : null;
  const route = playlists ? await jev(host, chatId, text, [], playlists) : null;
  if (route) {
    const d = decideText(route, text);
    await routerEvent(host, chatId, { layer: "jev", decision: d.kind, ...routeFields(route) });
    if (d.kind === "list") return void (await send(host.api, chatId, await playlistsText(host, d.filter)));
    if (d.kind === "search") return void (await send(host.api, chatId, await searchText(host, d.query)));
  }
  if (host.agent) return void (await ask(host, chatId, text, false));
  await send(host.api, chatId, HELP);
}

/**
 * "rename Friday to Friday Night": asks with a tap, then queues it for the
 * Mac. True when handled; false when it isn't a rename (or the playlist isn't
 * clear and the assistant is there to work it out).
 */
async function askRename(host: BotHost, chatId: string, text: string): Promise<boolean> {
  const playlists = await host.store.getLibraryPlaylists();
  if (!playlists) return false;
  const r = renameRequest(text, playlists);
  if (r === null) return false;
  if (r.kind === "unknown") {
    if (host.agent) return false;
    const close = closestPlaylists(playlists, r.from, 3).map((p) => playlistPath(p));
    await send(host.api, chatId, `I couldn't find a playlist called “${r.from}”.${close.length > 0 ? ` Did you mean ${close.join(", ")}?` : ""}`);
    return true;
  }
  await routerEvent(host, chatId, { layer: "code", decision: "rename", playlist: r.playlist.id });
  if (normalizeName(r.newName) === normalizeName(r.playlist.name)) {
    await send(host.api, chatId, `It's already called “${r.playlist.name}”.`);
    return true;
  }
  if (r.newName.length > MAX_PLAYLIST_NAME) {
    await send(host.api, chatId, `That name is too long (at most ${MAX_PLAYLIST_NAME} characters).`);
    return true;
  }
  const id = randomBase64url(6);
  const prompt = `Rename “${playlistPath(r.playlist)}” to “${r.newName}”?`;
  host.store.addAgentConfirm({
    id,
    chat_id: chatId,
    tool: "rename_playlist",
    args: { name: r.playlist.name, new_name: r.newName, playlist_id: r.playlist.id },
    prompt,
    created_at: host.now().toISOString(),
  });
  await send(host.api, chatId, prompt, {
    reply_markup: { inline_keyboard: [[{ text: "Rename", callback_data: `c:${id}:y` }, { text: "Cancel", callback_data: `c:${id}:n` }]] },
  });
  return true;
}

/** Jev's reading of a message, or null when it isn't configured, slow or failing. */
async function jev(host: BotHost, chatId: string, text: string, links: string[], playlists: LibPlaylist[]): Promise<JevRoute | null> {
  if (!host.router) return null;
  const started = Date.now();
  try {
    return await host.router.route(text, links, playlists);
  } catch (e) {
    await routerEvent(host, chatId, { layer: "jev", decision: "failed", ms: Date.now() - started, error: errorKind(e) });
    return null;
  }
}

/** "jev 503", "TimeoutError" — never a response body (it could echo the message). */
const errorKind = (e: unknown) =>
  e instanceof Error ? (/^jev \d{3}/u.exec(e.message)?.[0] ?? (e.name === "Error" ? "error" : e.name)) : "error";

const routeFields = (r: JevRoute) => ({
  action: r.action,
  aconf: Math.round(r.actionConfidence * 100) / 100,
  playlist: r.playlist?.id ?? null,
  pconf: Math.round(r.playlistConfidence * 100) / 100,
  ms: r.ms,
  model: r.model,
});

/** One JSON line per routing decision (no message text; the chat as a short hash). */
async function routerEvent(host: BotHost, chatId: string, fields: Record<string, unknown>): Promise<void> {
  if (!host.onRouterEvent) return;
  try {
    host.onRouterEvent({ event: "router", chat: (await sha256Hex(chatId)).slice(0, 8), ...fields });
  } catch {
    /* metrics never break the bot */
  }
}

/**
 * Free text → the assistant, with a typing indicator; a delete waits for a
 * tap. With `orButtons`, an unavailable assistant returns false (the caller
 * shows playlist buttons instead of an apology).
 */
async function ask(host: BotHost, chatId: string, text: string, orButtons: boolean): Promise<boolean> {
  try {
    await host.api.call("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {
    /* cosmetic */
  }
  const started = Date.now();
  const outcome = await runAgent(
    { ai: host.agent!.ai, model: host.agent!.model, deps: host.deps, store: host.store, chatId, now: () => host.now() },
    text,
    (jobId) => host.store.addTgJob(jobId, chatId),
  );
  try {
    await host.onAgentEvent?.(await agentEvent(outcome.kind, Date.now() - started, host.agent!.model || AGENT_MODEL, chatId));
  } catch {
    /* metrics never break the bot */
  }
  if (outcome.kind === "unavailable" && orButtons) return false;
  if (outcome.kind === "confirm") {
    await send(host.api, chatId, outcome.text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: outcome.button, callback_data: `c:${outcome.id}:y` },
            { text: "Cancel", callback_data: `c:${outcome.id}:n` },
          ],
        ],
      },
    });
    return true;
  }
  await send(host.api, chatId, outcome.text);
  return true;
}

/** Edit the message with the buttons (or send a new one if that fails). */
async function replaceMessage(host: BotHost, chatId: string, messageId: number | null, text: string): Promise<void> {
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

async function onButton(
  host: BotHost,
  chatId: string,
  callbackId: string,
  data: string,
  messageId: number | null,
  linkId: string,
): Promise<void> {
  if (data === STOP_YES || data === STOP_NO) {
    await answerCallback(host.api, callbackId);
    if (data === STOP_NO) return replaceMessage(host, chatId, messageId, "OK — this chat is still connected.");
    await replaceMessage(host, chatId, messageId, DISCONNECTED);
    return host.disconnect(linkId);
  }
  const confirm = /^c:([A-Za-z0-9_-]{8}):([yn])$/u.exec(data);
  if (confirm) {
    const text = await resolveConfirmation(
      { deps: host.deps, store: host.store, chatId, now: () => host.now() },
      confirm[1]!,
      confirm[2] === "y",
      (jobId) => host.store.addTgJob(jobId, chatId),
    );
    if (text === null) {
      await answerCallback(host.api, callbackId, "That question has expired — ask again.");
      return;
    }
    await answerCallback(host.api, callbackId);
    await replaceMessage(host, chatId, messageId, text);
    return;
  }
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
  await routerEvent(host, chatId, { layer: "pick", pending: pending.id, picked: playlistId ?? target });
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
async function queue(
  host: BotHost,
  chatId: string,
  urls: string[],
  name: string | null,
  playlistId: string | null,
  note = "",
): Promise<string> {
  const media = urls.map((u) => extractMediaRef(u)).flatMap((r) => (r.ok ? [r.media] : []));
  const sub = await submit(host.deps, media, name, "mcp", playlistId);
  if (!sub.ok) return `Couldn't queue that: ${sub.error}`;
  const { job, deduplicated } = sub.value;
  host.store.addTgJob(job.id, chatId);
  let text = deduplicated
    ? `That's already queued → ${job.playlist}. I'll tell you when it's in Rekordbox.`
    : `Queued: ${plural(job.urls.length, "link")} → ${job.playlist}${note}. I'll tell you when it's in Rekordbox.`;
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
    case "stats": {
      const stats = host.ownerStats?.(chatId);
      if (stats) return void (await send(host.api, chatId, await stats));
      return void (await send(host.api, chatId, `I don't know /${command}.\n\n${HELP}`));
    }
    case "metrics": {
      const report = host.ownerMetrics?.(chatId);
      if (report) return void (await send(host.api, chatId, await report, { parse_mode: "HTML" }));
      return void (await send(host.api, chatId, `I don't know /${command}.\n\n${HELP}`));
    }
    case "stop":
      return void (await send(host.api, chatId, "Disconnect this chat from DJ Sync? To use it here again you'd pair it from your Mac.", {
        reply_markup: { inline_keyboard: [[{ text: "Disconnect", callback_data: STOP_YES }, { text: "Cancel", callback_data: STOP_NO }]] },
      }));
    case "rename":
      if (args === "") return void (await send(host.api, chatId, "Usage: /rename <playlist> to <new name>, e.g. /rename Friday to Friday Night"));
      if (await askRename(host, chatId, `rename ${args}`)) return;
      return void (await send(host.api, chatId, "Usage: /rename <playlist> to <new name>, e.g. /rename Friday to Friday Night"));
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
  const [index, playlists] = await Promise.all([libraryIndex(host.store), host.store.getLibraryPlaylists()]);
  if (!index) return NO_LIBRARY;
  const result = searchIndex(index, { query: words });
  host.deps.onSearch?.(result.match);
  const hits = result.tracks;
  if (hits.length === 0) return `No tracks match “${words}”.`;
  const lines = hits.slice(0, SEARCH_SHOWN).map((t) => {
    const extra = [t.bpm !== null ? `${Math.round(t.bpm * 10) / 10} BPM` : null, t.key].filter(Boolean).join(" · ");
    const inPl = (playlists ?? []).filter((p) => p.track_ids.includes(t.id)).map(playlistPath);
    const where = inPl.length === 0 ? "" : `\n   in ${inPl.slice(0, 3).join(", ")}${inPl.length > 3 ? ` +${inPl.length - 3} more` : ""}`;
    return `• ${t.artist ? `${t.artist} — ` : ""}${t.title}${extra ? ` · ${extra}` : ""}${where}`;
  });
  const more = hits.length > SEARCH_SHOWN ? ` (showing ${SEARCH_SHOWN})` : "";
  const head =
    result.match === "close"
      ? `No exact match for “${words}”. Closest${more}:`
      : `${plural(hits.length, "track")} match${more}:`;
  return `${head}\n${lines.join("\n")}`;
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
