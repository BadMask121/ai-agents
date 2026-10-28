// The one global Durable Object (idFromName("registry")): registration with
// per-IP and global daily limits, the tenant list with the last day each DJ's
// Mac connected, /v2/stats, and the 90-day inactivity sweep (spec §3.7, §3.8).
// IPs are never stored: only sha256(salt|day|ip), dropped after the day.
//
// Internal routes (from the Worker / Tenant DOs / cron):
//   POST /__/register {ip, platform, arch, agent_version} → 201 {tenant_id, agent_token, worker_version}
//   POST /__/touch    {tenant_id, day}
//   GET  /__/stats
//   POST /__/sweep

import { DurableObject } from "cloudflare:workers";
import { TENANT_ID, newAgentToken, newTenantId, randomBase64url, sha256Hex, utcDay } from "./bytes";
import {
  INACTIVE_TENANT_DAYS,
  REGISTRATIONS_PER_DAY,
  REGISTRATIONS_PER_IP_PER_DAY,
  SWEEP_BATCH,
  WORKER_VERSION,
} from "./constants";
import { addSeconds, json } from "./util";

export interface RegistryEnv {
  TENANT?: DurableObjectNamespace;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_seen_day TEXT);
CREATE INDEX IF NOT EXISTS tenants_seen ON tenants (last_seen_day);
CREATE TABLE IF NOT EXISTS registrations (ip_hash TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (ip_hash, day));
CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, registrations INTEGER NOT NULL)
`;

type Row = Record<string, ArrayBuffer | string | number | null>;

export class Registry extends DurableObject<RegistryEnv> {
  clock: () => Date = () => new Date();

  constructor(ctx: DurableObjectState, env: RegistryEnv) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) ctx.storage.sql.exec(stmt);
    });
  }

  private rows(q: string, ...b: (string | number | null)[]): Row[] {
    return this.ctx.storage.sql.exec(q, ...b).toArray() as Row[];
  }

  private n(q: string, ...b: (string | number | null)[]): number {
    return Number(this.rows(q, ...b)[0]?.n ?? 0);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/__/register" && req.method === "POST") return this.register((await req.json()) as Record<string, unknown>);
    if (path === "/__/touch" && req.method === "POST") return this.touch((await req.json()) as Record<string, unknown>);
    if (path === "/__/stats" && req.method === "GET") return json(this.stats());
    if (path === "/__/sweep" && req.method === "POST") return json(await this.sweep());
    return new Response(null, { status: 404 });
  }

  private salt(): string {
    const have = this.rows("SELECT value FROM meta WHERE key = 'ip_salt'")[0]?.value;
    if (typeof have === "string") return have;
    const salt = randomBase64url(32);
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('ip_salt', ?)", salt);
    return salt;
  }

  private async register(b: Record<string, unknown>): Promise<Response> {
    const now = this.clock();
    const day = utcDay(now);
    const ip = typeof b.ip === "string" && b.ip !== "" ? b.ip : "unknown";
    const ipHash = await sha256Hex(`${this.salt()}|${day}|${ip}`);
    this.ctx.storage.sql.exec("DELETE FROM registrations WHERE day < ?", day);

    if (this.n("SELECT registrations AS n FROM days WHERE day = ?", day) >= REGISTRATIONS_PER_DAY) {
      return json({ error: "registration_paused", detail: "New sign-ups are paused for today; try again tomorrow." }, 503);
    }
    if (this.n("SELECT count AS n FROM registrations WHERE ip_hash = ? AND day = ?", ipHash, day) >= REGISTRATIONS_PER_IP_PER_DAY) {
      const tomorrow = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      return json(
        { error: "rate_limited", detail: "Too many sign-ups from this network today.", retry_after: Math.ceil((tomorrow - now.getTime()) / 1000) },
        429,
      );
    }

    // Counted before the awaited init, so parallel sign-ups can't slip past
    // the limits (a failed attempt still counts).
    this.ctx.storage.sql.exec(
      `INSERT INTO registrations (ip_hash, day, count) VALUES (?, ?, 1)
       ON CONFLICT (ip_hash, day) DO UPDATE SET count = count + 1`,
      ipHash,
      day,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO days (day, registrations) VALUES (?, 1)
       ON CONFLICT (day) DO UPDATE SET registrations = registrations + 1`,
      day,
    );

    const tenantId = newTenantId();
    const token = newAgentToken();
    const createdAt = now.toISOString();
    // Registry row first, so a tenant always ends up swept; undone if init fails.
    this.ctx.storage.sql.exec("INSERT INTO tenants (id, created_at, last_seen_day) VALUES (?, ?, NULL)", tenantId, createdAt);
    const ns = this.env.TENANT;
    let initOk = false;
    if (ns) {
      try {
        const res = await ns.get(ns.idFromName(tenantId)).fetch("https://tenant/__/init", {
          method: "POST",
          body: JSON.stringify({
            tenant_id: tenantId,
            agent_token_hash: await sha256Hex(token),
            created_at: createdAt,
            platform: typeof b.platform === "string" ? b.platform.slice(0, 16) : "",
            arch: typeof b.arch === "string" ? b.arch.slice(0, 16) : "",
            agent_version: typeof b.agent_version === "string" ? b.agent_version.slice(0, 64) : "",
          }),
        });
        initOk = res.status === 201;
      } catch (e) {
        console.error(`tenant init failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!initOk) {
      this.ctx.storage.sql.exec("DELETE FROM tenants WHERE id = ?", tenantId);
      return json({ error: "unavailable", detail: "Couldn't set up your DJ Sync cloud space; try again." }, 503);
    }
    return json({ tenant_id: tenantId, agent_token: token, worker_version: WORKER_VERSION }, 201);
  }

  private touch(b: Record<string, unknown>): Response {
    if (typeof b.tenant_id !== "string" || !TENANT_ID.test(b.tenant_id) || typeof b.day !== "string") {
      return json({ error: "invalid_body" }, 400);
    }
    this.ctx.storage.sql.exec(
      "UPDATE tenants SET last_seen_day = ? WHERE id = ? AND (last_seen_day IS NULL OR last_seen_day < ?)",
      b.day,
      b.tenant_id,
      b.day,
    );
    return json({ ok: true });
  }

  /** Day granularity: "24h" = seen on the current or previous UTC day. */
  stats() {
    const now = this.clock();
    const yesterday = utcDay(addSeconds(now, -86_400));
    const weekAgo = utcDay(addSeconds(now, -6 * 86_400));
    return {
      tenants: this.n("SELECT COUNT(*) AS n FROM tenants"),
      active_24h: this.n("SELECT COUNT(*) AS n FROM tenants WHERE last_seen_day >= ?", yesterday),
      active_7d: this.n("SELECT COUNT(*) AS n FROM tenants WHERE last_seen_day >= ?", weekAgo),
      registrations_24h: this.n("SELECT COALESCE(SUM(registrations), 0) AS n FROM days WHERE day >= ?", yesterday),
    };
  }

  /**
   * Purge DJs whose Mac hasn't connected for 90 days (never-connected ones
   * count from registration), a batch at a time; an alarm continues the rest.
   */
  async sweep(): Promise<{ purged: number; more: boolean }> {
    const now = this.clock();
    const cutoff = utcDay(addSeconds(now, -INACTIVE_TENANT_DAYS * 86_400));
    this.ctx.storage.sql.exec("DELETE FROM days WHERE day < ?", utcDay(addSeconds(now, -7 * 86_400)));
    const stale = this.rows(
      "SELECT id FROM tenants WHERE COALESCE(last_seen_day, substr(created_at, 1, 10)) < ? LIMIT ?",
      cutoff,
      SWEEP_BATCH,
    ).map((r) => r.id as string);
    const ns = this.env.TENANT;
    let purged = 0;
    for (const id of stale) {
      try {
        if (ns) await ns.get(ns.idFromName(id)).fetch("https://tenant/__/purge", { method: "POST" });
        this.ctx.storage.sql.exec("DELETE FROM tenants WHERE id = ?", id);
        purged++;
      } catch (e) {
        console.error(`purge failed for a tenant: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const more = stale.length === SWEEP_BATCH;
    if (more) await this.ctx.storage.setAlarm(Date.now() + 1000);
    if (purged > 0) console.log(`sweep: purged ${purged} inactive DJ(s)${more ? ", more to go" : ""}`);
    return { purged, more };
  }

  async alarm(): Promise<void> {
    await this.sweep();
  }
}
