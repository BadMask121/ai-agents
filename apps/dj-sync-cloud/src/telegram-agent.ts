// The Telegram bot's assistant (connect-anywhere spec §1c): free text goes to
// a Workers AI model with the same 11 tools as MCP, executed through the MCP
// dispatcher (same validation, playlist resolution, suggestions, dedupe).
// Short per-chat memory makes follow-ups work; deleting a playlist or moving
// a whole one waits for a button tap.

import {
  AGENT_CONFIRM_SECONDS,
  AGENT_MAX_ROUNDS,
  AGENT_MAX_TOKENS,
  AGENT_MEMORY_SECONDS,
  AGENT_MEMORY_TURNS,
  AGENT_MESSAGES_PER_DAY,
  AGENT_MODEL,
  AGENT_TOOL_RESULT_CHARS,
} from "./constants";
import { randomBase64url, utcDay } from "./bytes";
import type { Deps } from "./jobs";
import { playlistPath, plural, resolvePlaylist } from "./library";
import { dispatch } from "./mcp";
import type { SqlStore } from "./sqlstore";
import type { LibPlaylist } from "./store";
import { TELEGRAM_MAX_TEXT, clip } from "./telegram";
import { addSeconds } from "./util";

/** The Workers AI binding (env.AI), narrowed to what we use. */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface AgentHost {
  ai: AiRunner;
  model?: string;
  deps: Deps;
  store: SqlStore;
  chatId: string;
  now(): Date;
}

export type AgentOutcome =
  | { kind: "reply"; text: string }
  /** A destructive change waits for the DJ: show `text` with Confirm / Cancel buttons. */
  | { kind: "confirm"; text: string; id: string; button: string }
  /** Over the per-chat daily cap. */
  | { kind: "limited"; text: string }
  /** Workers AI failed (error, allowance used up, nonsense back). */
  | { kind: "unavailable"; text: string };

export const AGENT_UNAVAILABLE =
  "I can't think right now — commands and links still work: /playlists, /search <words>, /status, " +
  "or send a link with a playlist name after it.";

export const agentLimited = () =>
  `That's today's limit of ${AGENT_MESSAGES_PER_DAY} questions to DJ Sync's assistant — commands and links still ` +
  "work: /playlists, /search <words>, /status, or send a link.";

const TRACK_CHANGES = new Set(["add_tracks_to_playlist", "remove_tracks_from_playlist", "move_tracks", "copy_tracks"]);

/**
 * The changes that need a tap first: ones that change a lot at once, and
 * ones about songs a search only found as close matches (a typo forgiven or
 * a word missing), so a near-miss never lands in a playlist unasked.
 */
function needsConfirmation(name: string, args: Record<string, unknown>, close: Set<string>): boolean {
  if (name === "delete_playlist" || (name === "move_tracks" && args.all === true)) return true;
  return TRACK_CHANGES.has(name) && Array.isArray(args.track_ids) && args.track_ids.some((id) => close.has(String(id)));
}

/** Track ids this chat's searches only found as close matches (kept as long as the chat's memory). */
function closeIds(host: AgentHost): Set<string> {
  const raw = host.store.meta(`agent_close:${host.chatId}`);
  if (!raw) return new Set();
  try {
    const { at, ids } = JSON.parse(raw) as { at: string; ids: string[] };
    return at >= addSeconds(host.now(), -AGENT_MEMORY_SECONDS).toISOString() ? new Set(ids) : new Set();
  } catch {
    return new Set();
  }
}

function rememberClose(host: AgentHost, ids: Set<string>): void {
  host.store.setMeta(`agent_close:${host.chatId}`, JSON.stringify({ at: host.now().toISOString(), ids: [...ids].slice(-100) }));
}

export function systemPrompt(today: string): string {
  return [
    "You are DJ Sync's assistant in a Telegram chat with a DJ. DJ Sync downloads Spotify, YouTube and SoundCloud links into the " +
      "DJ's Rekordbox library on their Mac and manages their Rekordbox playlists. Every change is queued for the Mac.",
    `Today is ${today}.`,
    "Rules:",
    "- Use the tools for anything about the DJ's library. Look before you act: list_playlists, search_tracks or " +
      "get_playlist first. Never invent track_ids, playlist names or playlist_ids — take them from tool results.",
    "- To filter playlists by folder or name, pass words as list_playlists' query (e.g. query \"DJ Sync\").",
    "- Playlist names can be loose. If a tool says a name is ambiguous or not found, show the options briefly and " +
      "ask which one; then call again with its \"Folder/Name\" or playlist_id.",
    "- Links: call download_to_rekordbox with the links from the message. If the user names a playlist anywhere in " +
      "the message (\"add this to Afrobeat - Wa\"), you MUST pass it as playlist_name in that same call — never " +
      "download to the default and add later. Omit playlist_name only when the user named none. For a new " +
      "playlist set create_playlist: true.",
    "- Copy songs from one playlist to another = copy_tracks (all: true for the whole playlist); move them = " +
      "move_tracks; songs found with search_tracks go in with add_tracks_to_playlist. For a playlist that doesn't " +
      "exist yet, set create_playlist: true.",
    "- \"Which playlist has <song>?\" = one search_tracks call: each track it finds lists the playlists it's in.",
    "- If search_tracks says \"No exact match\", say which song you found and ask before changing a playlist with it.",
    "- To see the songs in a Spotify playlist/album or YouTube playlist link without downloading it, call link_tracks: " +
      "it says which are already in the library, in which playlists, with track_ids. To copy the ones in a playlist " +
      "(e.g. \"the songs from this link that are in Shayo 29, into Oct 29\"), keep the matches whose playlists include " +
      "it and call copy_tracks with from_playlist, those track_ids and create_playlist: true if needed. A SoundCloud " +
      "link's songs can't be read before it's downloaded: say so plainly. Never download a link the DJ only asked you " +
      "to check.",
    "- If the request is unclear, ask one short question instead of guessing.",
    "- Never mention tool names, job ids, files (XML, databases) or other internals in a reply. Say what happened " +
      "in plain words, e.g. \"Added to Afrobeat - Wa.\"",
    "- Sound like a friendly person, not a system: short, warm, plain words. Say \"songs\" not \"tracks\", " +
      "\"on its way\" not \"queued\", and skip technical words. One or two sentences for simple things.",
    "- Reply in plain text for Telegram: no Markdown, no tables, a few short lines, lists as \"• item\". " +
      "Say briefly when a change is queued and if the Mac is offline.",
  ].join("\n");
}

// ---------- memory ----------

interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** The last few turns of this chat (a day at most). */
function memory(host: AgentHost): Turn[] {
  const since = addSeconds(host.now(), -AGENT_MEMORY_SECONDS).toISOString();
  return host.store.agentTurns(host.chatId, since, AGENT_MEMORY_TURNS);
}

function remember(host: AgentHost, role: Turn["role"], content: string): void {
  host.store.addAgentTurn(host.chatId, role, content.slice(0, 2000), host.now().toISOString());
  host.store.trimAgentTurns(host.chatId, AGENT_MEMORY_TURNS, addSeconds(host.now(), -AGENT_MEMORY_SECONDS).toISOString());
}

/**
 * Compact references from this turn's tool results (tracks and playlists with
 * their ids, in order), kept with the reply so "move the first two" works.
 */
function references(results: string[]): string {
  const tracks: string[] = [];
  const playlists: string[] = [];
  for (const r of results) {
    for (const line of r.split("\n")) {
      const t = /^\s*(?:\d+\.|-|•)?\s*(.+?)(?: · .*)? \[track_id ([^\]]+)\]/u.exec(line);
      if (t && tracks.length < 10) tracks.push(`${t[1]!.slice(0, 60)} [track_id ${t[2]}]`);
    }
    for (const m of r.matchAll(/"([^"]+)" \((\d+ tracks?), playlist_id ([^)]+)\)/gu)) {
      if (playlists.length < 8) playlists.push(`${m[1]} [playlist_id ${m[3]}]`);
    }
  }
  const parts = [];
  if (tracks.length > 0) parts.push(`Tracks, in order: ${tracks.map((t, i) => `${i + 1}. ${t}`).join("; ")}`);
  if (playlists.length > 0) parts.push(`Playlists: ${playlists.join("; ")}`);
  return parts.length > 0 ? `\n(${parts.join(". ")})` : "";
}

// ---------- the daily cap ----------

/** Count this message against the chat's daily cap; false when it's used up. */
function admit(host: AgentHost): boolean {
  const key = `agent_day:${host.chatId}`;
  const today = utcDay(host.now());
  const [day, n] = (host.store.meta(key) ?? "").split(":");
  const count = day === today ? Number(n ?? "0") : 0;
  if (count >= AGENT_MESSAGES_PER_DAY) return false;
  host.store.setMeta(key, `${today}:${count + 1}`);
  return true;
}

// ---------- the loop ----------

type Msg = Record<string, unknown>;
interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** OpenAI-style function tools from the MCP tool list. */
async function agentTools(deps: Deps): Promise<Msg[]> {
  const listed = (await dispatch({ jsonrpc: "2.0", id: 0, method: "tools/list" }, deps)) as { result: { tools: Msg[] } };
  return listed.result.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** choices[0].message from an OpenAI-style chat completion (or Workers AI's {response, tool_calls}). */
function parseReply(raw: unknown): { content: string; calls: ToolCall[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const message = (Array.isArray(r.choices) ? (r.choices[0] as Msg | undefined)?.message : r) as Msg | undefined;
  if (typeof message !== "object" || message === null) return null;
  if (!("content" in message) && !("response" in message) && !("tool_calls" in message)) return null;
  const content =
    typeof message.content === "string" ? message.content : typeof message.response === "string" ? message.response : "";
  const calls: ToolCall[] = [];
  for (const [i, c] of (Array.isArray(message.tool_calls) ? message.tool_calls : []).entries()) {
    const call = c as Msg;
    const fn = (call.function ?? call) as Msg;
    if (typeof fn.name !== "string") continue;
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    calls.push({ id: typeof call.id === "string" ? call.id : `call_${i}`, name: fn.name, arguments: args });
  }
  return { content, calls };
}

/** Plain, short Telegram text: no reasoning blocks, no Markdown emphasis. */
export function tidy(text: string): string {
  const out = text
    .replace(/<think>[\s\S]*?<\/think>/gu, "")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/__(.+?)__/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*]\s+/gmu, "• ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return clip(out, TELEGRAM_MAX_TEXT);
}

/** Run one tool through the MCP dispatcher; the text the model sees, truncated. */
async function runTool(
  deps: Deps,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; jobId: string | null; closeIds: string[] }> {
  const reply = (await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, deps)) as {
    result?: { content?: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
    error?: { message?: string };
  };
  if (reply.error) return { text: `Error: ${reply.error.message ?? "the tool failed"}`, jobId: null, closeIds: [] };
  const text = reply.result?.content?.[0]?.text ?? "";
  const jobId = typeof reply.result?.structuredContent?.job_id === "string" ? reply.result.structuredContent.job_id : null;
  const clipped = text.length > AGENT_TOOL_RESULT_CHARS ? `${text.slice(0, AGENT_TOOL_RESULT_CHARS)}\n…(truncated)` : text;
  const sc = reply.result?.structuredContent;
  const rows = Array.isArray(sc?.tracks) ? (sc.tracks as { track_id?: unknown; match?: unknown }[]) : [];
  const closeIds = rows.filter((t) => t.track_id !== undefined && (sc?.match === "close" || t.match === "close")).map((t) => String(t.track_id));
  return { text: (reply.result?.isError ? "Error: " : "") + clipped, jobId, closeIds };
}

/**
 * Answer one free-text message. Tool calls run through MCP; a delete or a
 * whole-playlist move comes back as `confirm` instead of running.
 * `onJob` hears about every job queued, for finish notifications.
 */
export async function runAgent(host: AgentHost, userText: string, onJob: (jobId: string) => void = () => {}): Promise<AgentOutcome> {
  if (!admit(host)) return { kind: "limited", text: agentLimited() };
  const today = host.now().toISOString().slice(0, 10);
  const messages: Msg[] = [
    { role: "system", content: systemPrompt(today) },
    ...memory(host).map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: userText },
  ];
  const results: string[] = [];
  const close = closeIds(host);
  try {
    const tools = await agentTools(host.deps);
    for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
      const raw = await host.ai.run(host.model || AGENT_MODEL, {
        messages,
        tools,
        max_tokens: AGENT_MAX_TOKENS,
        temperature: 0.2,
        chat_template_kwargs: { enable_thinking: false },
      });
      const reply = parseReply(raw);
      if (!reply) throw new Error("unexpected model output");
      if (reply.calls.length === 0) {
        const text = tidy(reply.content) || (results.length > 0 ? "Done." : "");
        if (text === "") throw new Error("empty model output");
        remember(host, "user", userText);
        remember(host, "assistant", text + references(results));
        return { kind: "reply", text };
      }
      messages.push({
        role: "assistant",
        content: reply.content || "",
        tool_calls: reply.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
      for (const call of reply.calls) {
        let args: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(call.arguments || "{}");
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
          args = parsed as Record<string, unknown>;
        } catch {
          messages.push({ role: "tool", tool_call_id: call.id, content: "Error: arguments must be a JSON object." });
          continue;
        }
        if (needsConfirmation(call.name, args, close)) {
          const confirm = await confirmation(host, call.name, args, close);
          if (confirm) {
            remember(host, "user", userText);
            remember(host, "assistant", confirm.text);
            return confirm;
          }
          // The playlist isn't clear: run it, so the model gets the suggestions.
        }
        const { text, jobId, closeIds: near } = await runTool(host.deps, call.name, args);
        if (near.length > 0) {
          for (const id of near) close.add(id);
          rememberClose(host, close);
        }
        if (jobId) onJob(jobId);
        results.push(text);
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
      }
    }
    const text = "That took too many steps — could you ask it more simply?";
    remember(host, "user", userText);
    remember(host, "assistant", text + references(results));
    return { kind: "reply", text };
  } catch (e) {
    console.error(`telegram agent failed: ${e instanceof Error ? e.message : String(e)}`);
    return { kind: "unavailable", text: AGENT_UNAVAILABLE };
  }
}

// ---------- confirmations ----------

/** Store the change and the question; null when the playlist(s) don't resolve to one (let the tool explain). */
async function confirmation(
  host: AgentHost,
  tool: string,
  args: Record<string, unknown>,
  close: Set<string> = new Set(),
): Promise<AgentOutcome | null> {
  const playlists = await host.store.getLibraryPlaylists();
  if (!playlists) return null;
  if (TRACK_CHANGES.has(tool) && !(tool === "move_tracks" && args.all === true)) return closeMatchConfirmation(host, tool, args, close);
  const pick = (name: unknown, id: unknown): LibPlaylist | null => {
    if (typeof id === "string" && id !== "") return playlists.find((p) => p.id === id) ?? null;
    if (typeof name !== "string") return null;
    const m = resolvePlaylist(playlists, name);
    return m.kind === "one" ? m.playlist : null;
  };
  let text: string;
  let button: string;
  let pinned: Record<string, unknown>;
  if (tool === "delete_playlist") {
    const p = pick(args.name, args.playlist_id);
    if (!p) return null;
    text = `Delete the playlist “${playlistPath(p)}” (${plural(p.track_ids.length, "track")})? Its tracks stay in your library.`;
    button = "Delete";
    pinned = { name: p.name, playlist_id: p.id };
  } else {
    const from = pick(args.from_playlist, args.from_playlist_id);
    if (!from) return null;
    const to = pick(args.to_playlist, args.to_playlist_id);
    if (!to && args.create_playlist !== true) return null;
    const toName = to ? playlistPath(to) : String(args.to_playlist);
    text = `Move all ${plural(from.track_ids.length, "track")} from “${playlistPath(from)}” to “${toName}”${to ? "" : " (a new playlist)"}?`;
    button = "Move";
    pinned = {
      ...args,
      from_playlist: from.name,
      from_playlist_id: from.id,
      ...(to ? { to_playlist: to.name, to_playlist_id: to.id } : {}),
    };
  }
  const id = randomBase64url(6);
  host.store.addAgentConfirm({ id, chat_id: host.chatId, tool, args: pinned, prompt: text, created_at: host.now().toISOString() });
  return { kind: "confirm", text, id, button };
}

/** "Add “Jealous” by Fireboy DML to Friday? I found it as a close match…" — the args run unchanged on Yes. */
async function closeMatchConfirmation(
  host: AgentHost,
  tool: string,
  args: Record<string, unknown>,
  close: Set<string>,
): Promise<AgentOutcome | null> {
  const tracks = (await host.store.getLibraryTracks()) ?? [];
  const ids = (Array.isArray(args.track_ids) ? args.track_ids : []).map(String);
  const named = ids.map((id) => tracks.find((t) => t.id === id)).filter((t) => t !== undefined);
  if (named.length === 0) return null; // unknown ids: let the tool explain
  const songs =
    named.length === 1
      ? `“${named[0]!.title}”${named[0]!.artist ? ` by ${named[0]!.artist}` : ""}`
      : `${named.length} songs (${named.slice(0, 3).map((t) => `“${t.title}”`).join(", ")}${named.length > 3 ? ", …" : ""})`;
  const where =
    tool === "add_tracks_to_playlist"
      ? `Add ${songs} to “${String(args.playlist)}”`
      : tool === "remove_tracks_from_playlist"
        ? `Remove ${songs} from “${String(args.playlist)}”`
        : `${tool === "copy_tracks" ? "Copy" : "Move"} ${songs} from “${String(args.from_playlist)}” to “${String(args.to_playlist)}”`;
  const nearCount = ids.filter((id) => close.has(id)).length;
  const text = `${where}? I found ${nearCount === 1 && named.length === 1 ? "it" : "them"} as a close match, not an exact one.`;
  const id = randomBase64url(6);
  host.store.addAgentConfirm({ id, chat_id: host.chatId, tool, args, prompt: text, created_at: host.now().toISOString() });
  return { kind: "confirm", text, id, button: "Yes" };
}

/** The Confirm / Cancel tap. Returns what to show, or null when it expired. */
export async function resolveConfirmation(
  host: Omit<AgentHost, "ai">,
  id: string,
  yes: boolean,
  onJob: (jobId: string) => void = () => {},
): Promise<string | null> {
  host.store.purgeAgentConfirmsBefore(addSeconds(host.now(), -AGENT_CONFIRM_SECONDS).toISOString());
  const c = host.store.takeAgentConfirm(id);
  if (!c || c.chat_id !== host.chatId) return null;
  let text: string;
  if (yes) {
    const ran = await runTool(host.deps, c.tool, c.args);
    if (ran.jobId) onJob(ran.jobId);
    text = tidy(ran.text.replace(/^Error: /u, ""));
  } else {
    text = "Cancelled — nothing was changed.";
  }
  host.store.addAgentTurn(host.chatId, "assistant", text.slice(0, 2000), host.now().toISOString());
  return text;
}
