import type { Deps } from "../src/jobs";
import { MemoryStore } from "../src/store";

export const SECRET = "0123456789abcdef0123456789abcdef0123";
export const AGENT_TOKEN = "agent-token-0123456789abcdef";
export const SHORTCUT_KEY = "shortcut-key-0123456789abcdef";

/** Deps with an in-memory store and a clock tests can move. */
export function makeDeps(start = "2026-10-28T12:00:00.000Z") {
  let now = new Date(start);
  const store = new MemoryStore();
  const deps: Deps = {
    store,
    now: () => new Date(now),
    config: { defaultPlaylist: "ChatGPT Downloads", maxUrls: 3, publicHost: "mcp.example.test" },
  };
  return {
    deps,
    store,
    advance(seconds: number) {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}
