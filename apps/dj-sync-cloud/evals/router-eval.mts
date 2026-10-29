// The Telegram router against real Jev: every case in router-cases.json goes
// through the same steps as the bot (code, then Jev + routing.ts), and the
// decision must be one the case allows. A wrong action (queueing into,
// listing or searching the wrong thing) must never happen; asking with
// buttons or handing over to the assistant is safe, but still has to be what
// the case expects.
//
//   TYPESAFE_API_KEY=… npm run eval:router
//
// Costs about 100 Jev calls (well under a cent).

import { readFileSync } from "node:fs";
import { jevClient, type JevRoute } from "../src/jev.ts";
import { decideLink, decideText, exactPlaylist, looksLikeInstruction, renameRequest, type Decision } from "../src/routing.ts";
import type { LibPlaylist } from "../src/store.ts";
import { splitMessage } from "../src/telegram-bot.ts";

const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("set TYPESAFE_API_KEY");
const data = JSON.parse(readFileSync(new URL("./router-cases.json", import.meta.url), "utf8")) as {
  links: Record<string, string>;
  playlists: [string, string, string][];
  cases: [string, string[]][];
};
const playlists: LibPlaylist[] = data.playlists.map(([id, name, folder]) => ({ id, name, folder, track_ids: [] }));
const jev = jevClient(key, fetch, 5000);

const label = (d: Decision) =>
  d.kind === "queue" ? `queue:${d.playlist.id}` : d.kind === "list" ? `list:${d.filter}` : d.kind === "search" ? `search:${d.query}` : d.kind;

/** What the bot would do with this message (telegram-bot.ts onText / onPlainText). */
async function decide(text: string): Promise<{ decision: string; layer: string; route: JevRoute | null }> {
  const { links, full, hint } = splitMessage(text);
  if (links.length === 0) {
    const rename = renameRequest(text, playlists);
    if (rename?.kind === "rename") return { decision: `rename:${rename.playlist.id}`, layer: "code", route: null };
    const route = await jev.route(text, [], playlists);
    return { decision: label(decideText(route, text)), layer: "jev", route };
  }
  if (hint === "") return { decision: "buttons", layer: "code", route: null };
  if (looksLikeInstruction(hint)) return { decision: "assistant", layer: "code", route: null };
  const exact = exactPlaylist(playlists, full, hint);
  if (exact) return { decision: `queue:${exact.id}`, layer: "code", route: null };
  const route = await jev.route(text, links, playlists);
  return { decision: label(decideLink(route, hint, playlists)), layer: "jev", route };
}

let wrong = 0;
let unsafe = 0;
let acted = 0;
let couldAct = 0;
const ms: number[] = [];
for (const [template, allowed] of data.cases) {
  const text = template.replace(/\b([LY])\b/g, (m) => data.links[m]!);
  const { decision, layer, route } = await decide(text);
  if (route) ms.push(route.ms);
  // For a link, buttons and the assistant are both safe ways of asking; which one a borderline
  // Jev probability lands on can change between runs.
  const asks = (d: string) => d === "buttons" || d === "assistant";
  const ok = allowed.includes(decision) || (template.match(/\b[LY]\b/) !== null && asks(decision) && allowed.some(asks));
  const actsWhenRight = allowed[0]!.startsWith("queue:") || allowed[0]!.startsWith("list:") || allowed[0]!.startsWith("search:");
  if (actsWhenRight) couldAct++;
  if (ok && decision === allowed[0] && actsWhenRight) acted++;
  if (!ok) wrong++;
  if (!ok && /^(queue|list|search):/.test(decision)) unsafe++;
  const why = route ? ` (${route.action} ${route.actionConfidence.toFixed(2)}, ${route.playlist?.id ?? "none"} ${route.playlistConfidence.toFixed(2)})` : "";
  console.log(`${ok ? "ok  " : "FAIL"} ${layer.padEnd(4)} ${decision.padEnd(22)} ${template}${ok ? "" : `  — wanted ${allowed.join(" | ")}${why}`}`);
}
ms.sort((a, b) => a - b);
console.log(
  `\n${data.cases.length} cases: ${unsafe} wrong actions, ${wrong - unsafe} other mismatches. Acted straight away on ${acted}/${couldAct} that could be. ` +
    `Jev: ${ms.length} calls, median ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms.`,
);
process.exit(wrong === 0 ? 0 : 1);

