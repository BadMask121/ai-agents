import { RETENTION_DAYS } from "./constants";
import { D1Store } from "./d1store";
import type { Deps } from "./jobs";
import { route } from "./router";
import { addSeconds, validSecretPath } from "./util";

export interface Env {
  DB: D1Database;
  DEFAULT_PLAYLIST: string;
  MAX_URLS: string;
  PUBLIC_HOST: string;
  MCP_SECRET_PATH?: string;
  AGENT_TOKEN?: string;
  SHORTCUT_API_KEY?: string;
}

function deps(env: Env): Deps {
  return {
    store: new D1Store(env.DB),
    now: () => new Date(),
    config: {
      defaultPlaylist: env.DEFAULT_PLAYLIST || "ChatGPT Downloads",
      maxUrls: Number.parseInt(env.MAX_URLS, 10) || 25,
      publicHost: env.PUBLIC_HOST || "",
    },
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!validSecretPath(env.MCP_SECRET_PATH)) {
      // Never logs the value — only that it's unusable.
      console.error("MCP_SECRET_PATH is missing or invalid (≥32 chars of [A-Za-z0-9_-]); /mcp is disabled");
    }
    return route(req, env, deps(env));
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const before = addSeconds(new Date(), -RETENTION_DAYS * 24 * 3600).toISOString();
    const removed = await new D1Store(env.DB).purgeFinishedBefore(before);
    console.log(`retention: removed ${removed} finished job(s) older than ${RETENTION_DAYS} days`);
  },
} satisfies ExportedHandler<Env>;
