// Jev (TypeSafe's System One model) as the Telegram bot's fast router: one
// call answers "what does the DJ want?", "which playlist did they name?" and
// "which folder?", each with calibrated probabilities. It can't write text,
// so replies come from templates; anything it isn't sure of goes on to the
// assistant or to buttons (routing.ts decides).

import { JEV_MAX_CHOICES, JEV_TIMEOUT_MS } from "./constants";
import { closestPlaylists, playlistPath, sortPlaylists } from "./library";
import type { LibPlaylist } from "./store";
import { tokensOf, type UsageEvent } from "./usage";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export type RouteAction = "download" | "link_task" | "list_playlists" | "search_tracks" | "other";
export const NO_PLAYLIST = "(none)";
export const ALL_FOLDERS = "(all)";

export interface JevRoute {
  action: RouteAction;
  actionConfidence: number;
  /** The playlist named, or null for none. */
  playlist: LibPlaylist | null;
  playlistConfidence: number;
  /** Playlists by probability (highest first), for ordering buttons. */
  ranked: { playlist: LibPlaylist; p: number }[];
  /** The folder to list, or null for all of them. */
  folder: string | null;
  folderConfidence: number;
  model: string;
  ms: number;
}

export interface JevClient {
  route(text: string, links: string[], playlists: LibPlaylist[]): Promise<JevRoute>;
}

const ACTIONS: Record<RouteAction, unknown> = {
  download: {
    what:
      "The message has a Spotify or YouTube link and only asks to get that song/album/playlist into Rekordbox, " +
      "optionally into a named playlist",
    examples: ["add this to Gqom <link>", "<link> amapiano", "put this song in my wedding playlist <link>", "<link>", "download this playlist <link>"],
  },
  link_task: {
    what:
      "The message has a link but asks for more than downloading it: check or compare its songs with the library " +
      "or a playlist, copy or move songs, make a new playlist with a name, or a question about it",
    examples: [
      "check which songs in this playlist we already have <link>",
      "<link> find these in shayo 29 and copy them to oct 29",
      "<link> into a new playlist called Lagos Nights",
    ],
  },
  list_playlists: { what: "No link. Show or list their playlists, optionally filtered by a folder or words" },
  search_tracks: { what: "No link. Find songs already in their library by title, artist or genre" },
  other: {
    what: "No link. Move, remove, rename or delete tracks or playlists, ask a question about a playlist, or anything unclear",
    not_for: "Any message containing a link",
  },
};

/**
 * The playlists offered as choices, labelled "Folder/Name". A Jev choice
 * takes at most JEV_MAX_CHOICES options (one is "(none)"): beyond that, the
 * ones closest to the message come first.
 */
export function playlistChoices(playlists: LibPlaylist[], text: string): Map<string, LibPlaylist> {
  const room = JEV_MAX_CHOICES - 1;
  const ordered =
    playlists.length <= room ? playlists : [...new Set([...closestPlaylists(playlists, text, room), ...sortPlaylists(playlists)])];
  const out = new Map<string, LibPlaylist>();
  for (const p of ordered) {
    if (out.size >= room) break;
    let label = playlistPath(p);
    if (out.has(label) || label === NO_PLAYLIST) label = `${label} [${p.id}]`;
    out.set(label, p);
  }
  return out;
}

function folderChoices(playlists: LibPlaylist[]): string[] {
  return [...new Set(playlists.map((p) => p.folder).filter((f): f is string => !!f))].slice(0, JEV_MAX_CHOICES - 1);
}

interface JevAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export function jevClient(
  apiKey: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = JEV_TIMEOUT_MS,
  onCall: (e: UsageEvent) => void = () => {},
): JevClient {
  return {
    async route(text, links, playlists) {
      const byLabel = playlistChoices(playlists, text);
      const folders = folderChoices(playlists);
      const questions = {
        action: { type: "choice", instructions: "What does the DJ want DJ Sync to do with this Telegram message?", criteria: ACTIONS },
        playlist: {
          type: "choice",
          instructions:
            "Which of the DJ's existing Rekordbox playlists did they name? Words after a link are a playlist name " +
            '("<link> gqom" names a Gqom playlist). Names can be loose (case, spacing, missing punctuation). ' +
            `Pick ${NO_PLAYLIST} only if no playlist is named.`,
          criteria: Object.fromEntries([[NO_PLAYLIST, "No playlist named"], ...[...byLabel.keys()].map((k) => [k, null])]),
        },
        folder: {
          type: "choice",
          instructions: `Which playlist folder do they want listed? Pick ${ALL_FOLDERS} unless they name a folder.`,
          criteria: Object.fromEntries([[ALL_FOLDERS, "No folder named"], ...folders.map((f) => [f, null])]),
        },
      };
      const started = Date.now();
      let body: { model?: string; answers?: Record<string, JevAnswer>; usage?: Record<string, unknown> };
      try {
        const res = await fetcher(JEV_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: JEV_MODEL, state: { message: text, links }, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
        body = (await res.json()) as typeof body;
      } catch (e) {
        onCall({ kind: "model", name: JEV_MODEL, ok: false, ms: Date.now() - started, tokensIn: 0, tokensOut: 0 });
        throw e;
      }
      onCall({ kind: "model", name: body.model ?? JEV_MODEL, ok: true, ms: Date.now() - started, ...tokensOf(body) });
      const a = body.answers ?? {};
      const action = a.action?.choice;
      if (!action || !(action in ACTIONS)) throw new Error("jev: no action in the answer");
      const ranked = Object.entries(a.playlist?.probabilities ?? {})
        .flatMap(([label, p]) => (byLabel.has(label) ? [{ playlist: byLabel.get(label)!, p }] : []))
        .sort((x, y) => y.p - x.p);
      const pick = a.playlist?.choice;
      const folder = a.folder?.choice;
      return {
        action: action as RouteAction,
        actionConfidence: a.action?.confidence ?? 0,
        playlist: pick && byLabel.has(pick) ? byLabel.get(pick)! : null,
        playlistConfidence: a.playlist?.confidence ?? 0,
        ranked,
        folder: folder && folder !== ALL_FOLDERS && folders.includes(folder) ? folder : null,
        folderConfidence: a.folder?.confidence ?? 0,
        model: body.model ?? JEV_MODEL,
        ms: Date.now() - started,
      };
    },
  };
}
