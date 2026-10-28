import { RETENTION_DAYS, SWEEP_CRON } from "./constants";
import { D1Store } from "./d1store";
import type { Deps } from "./jobs";
import { route } from "./router";
import { addSeconds, publicHosts, validSecretPath } from "./util";

export { Registry } from "./registry";
export { Tenant } from "./tenant";

export interface Env {
  /** Protocol 1 queue (one DJ); kept until V1_RETIRED, then dropped (spec §3.9). */
  DB: D1Database;
  /** Protocol 1 library snapshot (see d1store.ts). */
  LIBRARY?: KVNamespace;
  /** One Durable Object per DJ (protocol 2). */
  TENANT: DurableObjectNamespace;
  /** The single registration / stats / sweep Durable Object. */
  REGISTRY: DurableObjectNamespace;
  DEFAULT_PLAYLIST: string;
  MAX_URLS: string;
  /** Canonical hostname (link URLs use it); browsers on other hosts are sent there. */
  PUBLIC_HOST: string;
  /** Older hostnames that still serve everything (connector URLs can't redirect). */
  PUBLIC_HOST_ALIASES?: string;
  MCP_SECRET_PATH?: string;
  AGENT_TOKEN?: string;
  SHORTCUT_API_KEY?: string;
  ADMIN_TOKEN?: string;
  V1_RETIRED?: string;
  LEGACY_TENANT_ID?: string;
  /** The shared Telegram bot (connect-anywhere spec §1): secrets, and its @username (a var). */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_USERNAME?: string;
}

function deps(env: Env): Deps {
  return {
    store: new D1Store(env.DB, env.LIBRARY),
    now: () => new Date(),
    config: {
      defaultPlaylist: env.DEFAULT_PLAYLIST || "ChatGPT Downloads",
      maxUrls: Number.parseInt(env.MAX_URLS, 10) || 25,
      publicHost: publicHosts(env),
    },
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (env.V1_RETIRED !== "true" && !validSecretPath(env.MCP_SECRET_PATH)) {
      // Never logs the value — only that it's unusable.
      console.error("MCP_SECRET_PATH is missing or invalid (≥32 chars of [A-Za-z0-9_-]); /mcp is disabled");
    }
    // Someone opening an old hostname in a browser gets the website.
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/" && env.PUBLIC_HOST && url.hostname !== env.PUBLIC_HOST) {
      return Response.redirect(`https://${env.PUBLIC_HOST}/`, 301);
    }
    return route(req, env, deps(env), { TENANT: env.TENANT, REGISTRY: env.REGISTRY });
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === SWEEP_CRON) {
      const res = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch("https://registry/__/sweep", {
        method: "POST",
      });
      console.log(`inactivity sweep: ${await res.text()}`);
      return;
    }
    if (env.V1_RETIRED === "true") return;
    const before = addSeconds(new Date(), -RETENTION_DAYS * 24 * 3600).toISOString();
    const removed = await new D1Store(env.DB).purgeFinishedBefore(before);
    console.log(`retention: removed ${removed} finished job(s) older than ${RETENTION_DAYS} days`);
  },
} satisfies ExportedHandler<Env>;
