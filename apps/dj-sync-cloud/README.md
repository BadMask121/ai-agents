# dj-sync-cloud

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
| anything else | — | 404. The `/api/*` and `/agent/*` routes also return 404 when their secret isn't set. |

## Agent protocol (1.0.0)

Every agent request carries these headers:

```
Authorization: Bearer <AGENT_TOKEN>
X-DJ-Sync-Agent-Protocol: 1.0.0      # semver; same MAJOR, MINOR ≤ the Worker's, else 409
X-DJ-Sync-Agent-Version: 0.2.0       # the Mac's dj-sync version (shown in /health)
```

**`POST /agent/poll`** takes `{"active": ["<job_id>", …], "can_claim": true}`.

- It extends `lease_until` by 15 minutes for each `active` job that is still
  running.
- If `can_claim` is set, it atomically claims **one** job: the oldest queued
  job, or a running job whose lease has run out. Lease expiry is how a
  download abandoned by a sleeping Mac gets retried.
- It returns `{"worker_version", "protocol", "job": null | {"job_id", "playlist", "urls", "attempt"}}`.

**`POST /agent/jobs/{id}/complete`** takes `{"state": "done"|"failed",
"message", "tracks": [{artist, title, file, already_downloaded}], "errors":
[{url, error}], "xml_version": "1.3.0"|null}`.

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

`MCP_SECRET_PATH` must match the value in the ChatGPT plugin URL, so the plugin
keeps working. To roll back to the tunnel, run `npx wrangler delete`, or remove
the route in the dashboard. The tunnel CNAME is untouched underneath.

## Notes

- **Logs.** Invocation logs are disabled (`observability.logs.invocation_logs:
  false`), because the request URL contains `MCP_SECRET_PATH`. Console logs
  never print paths or secrets. `wrangler tail` does show URLs, so treat its
  output as secret.
- **Free-plan cost.** A Mac polling every 15 s makes about 5.8k requests a day
  and about 5.8k D1 writes a day (agent heartbeats). Both are well under the
  free-plan limits.
- **Retention.** Finished jobs are deleted after 30 days. Queued and running
  jobs are never deleted.
