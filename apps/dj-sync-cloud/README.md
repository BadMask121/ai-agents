# dj-sync-cloud

> **1.0.0: one cloud for every DJ.** Each DJ (each Mac) gets its own SQLite
> Durable Object, and the Mac holds one WebSocket to it (agent protocol 2.0.0).
> See [Protocol 2](#protocol-2-200-public-multi-dj) below and the distribution
> spec (`docs/superpowers/specs/2026-10-28-dj-sync-public-distribution-design.md`
> §3). Everything from here to that section describes protocol 1, which keeps
> serving the owner's Mac until `V1_RETIRED="true"`.

This Worker is an always-on queue in front of [`apps/dj-sync`](../dj-sync/). It's a
Cloudflare Worker that stores jobs in D1. ChatGPT (MCP) and the iOS Shortcut talk to
it, so a download request is accepted even while the DJ laptop is asleep, off, or
offline. The laptop polls the Worker with **outbound** requests only. It claims queued
jobs, runs them through its normal spotdl / yt-dlp pipeline, and reports back.

```
ChatGPT ──MCP──▶ mcp.triplejmusic.art/* (Worker route) ──▶ D1: jobs, agent
iOS Shortcut ──REST──┘                                       ▲
                                                             │ poll / complete (Bearer AGENT_TOKEN)
                                       dj-sync on the Mac ───┘ (every ~15 s while it's online)
```

- **Plain TypeScript, no framework.** D1 access sits behind a small `Store`
  interface: `D1Store` in production and `MemoryStore` in the tests.
- **Same public contract as the Mac's local MCP lane.** The tool names, schemas
  and wording match. When the Mac is offline, the replies add *"Your Mac is
  offline (last seen …); it will download when it's back online."*
- **No DNS change.** The Worker is a *route* in front of the existing proxied
  `mcp.triplejmusic.art` record, and never forwards to the old tunnel. The
  ChatGPT plugin URL `https://mcp.triplejmusic.art/<MCP_SECRET_PATH>/mcp` stays
  the same.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | `{status, version, protocol, agent: {online, last_seen, version}, queued}` |
| `POST /<MCP_SECRET_PATH>/mcp` | secret path | MCP (`initialize`, `tools/list`, `tools/call`, `ping`). It follows the same transport rules as the Mac: `GET`/`DELETE` → 405, a 2026-07-28 probe → bare 400, foreign `Origin` → 403, more than 64 KB → 413. |
| `POST /api/downloads` | Bearer `SHORTCUT_API_KEY` | iOS Shortcut: `{url \| urls, playlist_name?}` → 202 with the job |
| `GET /api/downloads/{id}` | Bearer `SHORTCUT_API_KEY` | job status |
| `POST /agent/poll` | agent headers | heartbeat, lease extension, claim |
| `POST /agent/jobs/{id}/complete` | agent headers | report the result |
| `POST /agent/library` | agent headers (protocol ≥ 1.1) | upload the library snapshot (≤ 16 MB) to KV `LIBRARY` |
| anything else | — | 404. The `/api/*` and `/agent/*` routes also return 404 when their secret isn't set. |

## Agent protocol (1.1.0)

Every agent request carries these headers:

```
Authorization: Bearer <AGENT_TOKEN>
X-DJ-Sync-Agent-Protocol: 1.1.0      # semver; same MAJOR, MINOR ≤ the Worker's, else 409
X-DJ-Sync-Agent-Version: 0.8.0       # the Mac's dj-sync version (shown in /health)
```

**`POST /agent/poll`** takes `{"active": ["<job_id>", …], "can_claim": true,
"library_hash": "<sha256>"|null}`.

- It extends `lease_until` by 15 minutes for each `active` job that is still
  running.
- If `can_claim` is set, it atomically claims **one** job: the oldest queued
  job, or a running job whose lease has run out. Lease expiry is how a
  download abandoned by a sleeping Mac gets retried.
- It returns `{"worker_version", "protocol", "library_wanted", "job": null |
  {"job_id", "kind", "playlist", "urls", "attempt", "ops"?, "summary"?}}`.
  `library_wanted` is true when `library_hash` differs from the stored
  snapshot.
  - `kind` is `download` or `library`. A library job carries rbdb.py `ops`
    (`ensure_playlist`, `add_to_playlist`, `remove_from_playlist`,
    `rename_playlist`, `delete_playlist`, by exact playlist name and
    Rekordbox `content_id`) and a `summary`.
  - Agents on protocol 1.0 are never handed library jobs.

**`POST /agent/library`** takes `{hash, generated_at, library_version,
playlists: [{id, name, folder, track_ids}], tracks: [{id, title, artist,
album, genre, bpm, key, duration_secs}]}` and answers `{ok, playlists,
tracks}`. File paths are never sent.

**`POST /agent/jobs/{id}/complete`** takes `{"state": "done"|"failed",
"message", "tracks": [{artist, title, file, already_downloaded}], "errors":
[{url, error}], "xml_version": "1.3.0"|null, "library_version":
"1.2.1"|null}`. The Mac completes a library job only once the change is in
master.db.

| Response | When |
|---|---|
| 200 `{ok: true}` | Normal completion, or a retried report of the same state. |
| 404 | Unknown job ID. |
| 409 | The job already finished in a different state. |

Failures:

| Code | Body |
|---|---|
| 401 | Wrong or missing token. |
| 400 | `missing_or_invalid_protocol`, or `invalid_body`. |
| 409 | `{error: "incompatible_protocol", worker_protocol, agent_protocol, worker_version}`. |

## Protocol 2 (2.0.0): public, multi-DJ

```
ChatGPT/Claude ─MCP─▶ /<tenant_id>/<link_secret>/mcp ─┐
iOS Shortcut ─REST─▶ /api/downloads (Bearer <tenant_id>.<secret>) ─┤   Worker: routes only
                                                                    ▼
                                    Tenant DO (one per DJ, SQLite): jobs · links · agent · library
                                                                    ▲
dj-sync on the Mac ── WebSocket GET /v2/agent (hibernates when idle) ┘
POST /v2/register ─▶ Registry DO (sign-up limits, tenant list, /v2/stats, weekly sweep)
```

### Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /v2/register` | none; 5 per IP per day | `{protocol: "2.0.0", platform: "macos", arch, agent_version}` → 201 `{tenant_id, agent_token, worker_version}`. Errors: 409 incompatible protocol, 400 invalid body, 429 `rate_limited` (`retry_after` s), 503 `registration_paused` |
| `GET /v2/agent` (WebSocket) | `Authorization: Bearer <agent_token>`, `X-DJ-Sync-Tenant`, `X-DJ-Sync-Agent-Protocol`, `X-DJ-Sync-Agent-Version` | The agent connection. Refusals are a 101 followed by an `error` frame and a close code |
| `PUT /v2/agent/library` | agent headers | Snapshot `{hash, generated_at, library_version, playlists, tracks}`, gzip'd (detected from the bytes) or plain JSON, at most 8 MB → `{ok, playlists, tracks}` |
| `GET /v2/agent/links` | agent headers | `[{id, kind, label, created_at, last_used_at}]` |
| `POST /v2/agent/links` | agent headers | `{kind: chatgpt\|claude\|shortcut\|other, label?}` → 201 `{id, kind, label, created_at, last_used_at, url}`. A `shortcut` link also returns `api_url` and `token` (`<tenant_id>.<secret>`). 409 `too_many_links` past 10 |
| `POST /v2/agent/links/{id}/rotate` | agent headers | Same shape with a new `url`; the old one stops working at once |
| `DELETE /v2/agent/links/{id}` | agent headers | 204, or 404 |
| `POST /<tenant_id>/<link_secret>/mcp` | the link | MCP, with v1's transport rules. An unknown tenant or link is 404 |
| `GET /v2/stats` | `Bearer ADMIN_TOKEN` | `{tenants, active_24h, active_7d, registrations_24h}` (day granularity) |

Agent REST errors: 401 `unauthorized`, 400 `missing_or_invalid_protocol`, and
409 `{error: "incompatible_protocol", worker_protocol, agent_protocol, worker_version}`.

### WebSocket frames (JSON text; `ping` → `pong` is answered without waking the DO)

| Mac → cloud | Cloud → Mac |
|---|---|
| `hello {protocol, agent_version, active[], can_claim, library_hash\|null}` (first) | `welcome {worker_version, protocol, library_wanted}` |
| `ready {}`: can take one job | `job {job_id, kind, playlist, urls, attempt, ops?, summary?}`, one at a time |
| `extend {active[]}`: every 5 min while busy | `ack {job_id, result: ok\|duplicate\|not_found\|already_finished}` |
| `complete {job_id, state, message, tracks, errors, xml_version, library_version}` | `library_wanted {}` |
| `library_hash {hash}` | `error {code, message}` (`bad_message` keeps the socket open) |

Close codes:

| Code | Meaning | What the Mac does |
|---|---|---|
| 4001 | Unauthorized | Re-register |
| 4009 | Incompatible protocol | Retry rarely |
| 4010 | Replaced by a newer connection | Nothing |
| 4029 | More than 120 reconnects an hour | Wait |

**Leases:** a pushed job holds a 15-minute lease. `extend` (or `hello` with the
job in `active`) pushes it out. An alarm exists only while something is leased,
and it requeues expired jobs.

### Migration from protocol 1 (spec §3.9)

1. Deploy 1.0.0. v1 keeps working.
2. The owner's Mac registers on protocol 2.
3. Set `LEGACY_TENANT_ID` to that tenant and `V1_RETIRED` to `"true"`
   (`wrangler.jsonc` vars). The old secret path and Shortcut key now reach that
   DJ, and `/agent/*` returns 410.
4. Later, remove the D1 and KV bindings after a final export.

## Develop

```bash
pnpm install                         # from the repo root
pnpm --filter @ai-agents/dj-sync-cloud test
pnpm --filter @ai-agents/dj-sync-cloud typecheck

cd apps/dj-sync-cloud
cat > .dev.vars <<EOF                # gitignored; throwaway values
MCP_SECRET_PATH=$(openssl rand -hex 24)
AGENT_TOKEN=$(openssl rand -hex 24)
SHORTCUT_API_KEY=$(openssl rand -hex 24)
EOF
pnpm db:migrate:local
pnpm dev                             # wrangler dev --local (routes are ignored locally)
```

Tests run in plain Node. Protocol 1 runs against `MemoryStore`. The protocol 2
Durable Objects run against `node:sqlite` with fake sockets and alarms
(`test/do-harness.ts`), and `cloudflare:workers` is aliased to a shim.

Hibernation, the auto-response and the 101 upgrade need real workerd. Smoke-test
them against `pnpm dev`: register, create a link, open the socket, then check
`hello`→`welcome`, `ping`→`pong`, that a queued job is pushed, `complete`→`ack`,
a gzip library upload, and close codes 4001, 4009 and 4010.

## Deploy

Steps 1 and 2 need the account owner (a browser login, and creating the D1 database).

```bash
cd apps/dj-sync-cloud
npx wrangler login                                    # 1. browser OAuth
npx wrangler d1 create dj-sync-queue                  # 2. copy database_id into wrangler.jsonc
pnpm db:migrate:remote                                # 3. schema
# 4. secrets: piped from files, never typed on the command line
grep '^MCP_SECRET_PATH=' ~/.dj-sync/.env | cut -d= -f2- | npx wrangler secret put MCP_SECRET_PATH
grep '^SHORTCUT_API_KEY=' ~/.dj-sync/.env | cut -d= -f2- | npx wrangler secret put SHORTCUT_API_KEY
grep '^CLOUD_AGENT_TOKEN=' ~/.dj-sync/.env | cut -d= -f2- | npx wrangler secret put AGENT_TOKEN
npx wrangler deploy                                   # 5. goes live on mcp.triplejmusic.art/*
curl -s https://mcp.triplejmusic.art/health
```

**1.0.0 adds nothing to create by hand.** The `Tenant` and `Registry` Durable
Object classes come from the `v1-tenants` migration in `wrangler.jsonc`, which
`wrangler deploy` applies. Optionally, enable `/v2/stats`:

```bash
openssl rand -hex 24 > /tmp/admin && npx wrangler secret put ADMIN_TOKEN < /tmp/admin && rm /tmp/admin   # keep a copy somewhere safe first
npx wrangler deploy --tag v1.0.0 --message "dj-sync-cloud 1.0.0: per-DJ Durable Objects, agent protocol 2.0.0"
```

`MCP_SECRET_PATH` must match the value in the ChatGPT plugin URL, so the plugin
keeps working. To roll back to the tunnel, run `npx wrangler delete`, or remove
the route in the dashboard. The tunnel CNAME is untouched underneath.

## Notes

- **Logs.** Invocation logs are disabled (`observability.logs.invocation_logs:
  false`), because the request URL contains `MCP_SECRET_PATH`. Console logs
  never print paths or secrets. `wrangler tail` does show URLs, so treat its
  output as secret.
- **Free-plan cost.**
  - **Protocol 1:** a Mac polling every 15 s makes about 5.8k requests a day
    and about 5.8k D1 writes a day (agent heartbeats). Both are well under the
    free-plan limits.
  - **Protocol 2:** an idle Mac costs one request per connect, then nothing.
    Its keep-alive pings are auto-responses with no duration charge, but
    whether they count toward the request total is undocumented (bd
    `ai-agents-jff.6.3`).
- **Retention.** Finished jobs are deleted after 30 days. Queued and running
  jobs are never deleted.
