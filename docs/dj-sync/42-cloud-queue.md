# 42 — Cloud queue (works while the Mac is offline)

**Status:** live 2026-10-28 (bd epic `ai-agents-jff.3`).
- **Worker:** [`apps/dj-sync-cloud`](../../apps/dj-sync-cloud/) (0.2.0, agent protocol 1.1.0).
- **Mac side:** `apps/dj-sync/src/cloud.rs` (dj-sync 0.8.0).
- **Playlist tools:** protocol 1.1 adds a library snapshot and library jobs.
  See [doc 43](43-rekordbox-library.md).

## Why

The first version of the ChatGPT lane needed the Mac to be awake and online.
ChatGPT reached it through a Cloudflare Tunnel, so a request sent while the Mac
was asleep, off, or on a plane just failed. The cloud queue moves the public
endpoint onto Cloudflare and lets the Mac **pull** work whenever it's online.

```
ChatGPT ──MCP──▶ mcp.triplejmusic.art/*  (Worker route, always on)
iOS Shortcut ─REST─┘          │
                              ▼
                       D1  jobs · agent
                              ▲
        poll every ~15 s      │  outbound HTTPS only (Bearer AGENT_TOKEN)
dj-sync on the Mac ───────────┘  claim → spotdl / yt-dlp → Rekordbox XML → complete
```

- **Same URL, same tools.** The Worker is a *route* in front of the existing
  proxied DNS record, so the ChatGPT plugin URL
  (`https://mcp.triplejmusic.art/<MCP_SECRET_PATH>/mcp`) didn't change. It
  serves the same `download_to_rekordbox` and `get_download_status` tools as
  the Mac.
- **Requests always land.** A download request gets a job ID immediately. If
  the Mac is offline, the reply says so (*"Your Mac is offline (last seen 3 h
  ago); it will download when it's back online"*).
- **The Mac never needs to be reachable.** It polls `/agent/poll`, claims one
  job at a time, runs it through the usual queue, and reports
  tracks, errors and the new XML version to `/agent/jobs/{id}/complete`.
- **Recovery:** a claimed job holds a 15-minute lease, and each poll that lists
  the job extends it. If the Mac sleeps mid-download, the lease runs out and
  the job is claimed again later. That's safe, because files that already
  landed are reused (same name and size) and tracks are upserted, not
  duplicated.

The Cloudflare Tunnel isn't used for ChatGPT any more. Its LaunchAgent can stay
installed for rollback: remove the Worker route and traffic goes back to the
tunnel.

## Versioning (semver everywhere)

| What | Where | Rule |
|---|---|---|
| dj-sync (Mac) | `apps/dj-sync/Cargo.toml`, `CHANGELOG.md` | Normal semver; 0.x MINOR may change config. |
| dj-sync-cloud (Worker) | `package.json` = `WORKER_VERSION` (test-enforced), `CHANGELOG.md`, `wrangler deploy --tag vX.Y.Z` | Normal semver. |
| Agent protocol | `AGENT_PROTOCOL` in both `cloud.rs` and `src/constants.ts` | The Worker accepts an agent with the **same MAJOR** whose **MINOR is no newer** than its own. Anything else gets `409 incompatible_protocol`, and the Mac logs an error and stops claiming until one side is updated. Bump MINOR for additive changes and MAJOR for breaking ones. Deploy the Worker first. |
| Rekordbox import XML | `<file>.versions/<stem>.vX.Y.Z.xml` | MAJOR is a baseline or outside edit, MINOR a new playlist, PATCH added tracks (see [doc 40](40-chatgpt-mcp-design.md#versioned-snapshots-semver)). Reported per job as `xml_version`. |
| Rekordbox library (master.db) | `~/.dj-sync/rekordbox-backups/master.vX.Y.Z.db` | Same rules. The newest 12 are kept, plus the original `1.0.0`. Reported per library job as `library_version` ([doc 43](43-rekordbox-library.md)). |

## Operations

```bash
# Is the Mac polling? Queue depth?
curl -s https://mcp.triplejmusic.art/health
# → {"status":"ok","version":"0.2.0","protocol":"1.1.0","agent":{"online":true,"last_seen":"…","version":"0.8.0"},"queued":0}

# Mac side
grep cloud ~/Library/Logs/dj-sync.log | tail

# Worker logs (live)
cd apps/dj-sync-cloud && npx wrangler tail

# Deploy a new Worker version (bump package.json + WORKER_VERSION + CHANGELOG first)
pnpm --filter @ai-agents/dj-sync-cloud test && cd apps/dj-sync-cloud && \
  npx wrangler deploy --tag v$(node -p "require('./package.json').version")

# Roll back the Worker
npx wrangler rollback
```

Secrets live in the Worker, set with `wrangler secret put`. They are copies of
values in `~/.dj-sync/.env`:

| Worker secret | Mac `.env` | Purpose |
|---|---|---|
| `MCP_SECRET_PATH` | `MCP_SECRET_PATH` | ChatGPT plugin URL path |
| `AGENT_TOKEN` | `CLOUD_AGENT_TOKEN` | Mac ↔ Worker agent API |
| `SHORTCUT_API_KEY` | `SHORTCUT_API_KEY` | iOS Shortcut REST |

To rotate one, put a new value in both places and restart dj-sync with
`launchctl kickstart -k gui/$(id -u)/com.triplejmusic.dj-sync`. Rotating
`MCP_SECRET_PATH` also means updating the URL in the ChatGPT plugin.

## Failure modes

| Situation | What happens |
|---|---|
| Mac asleep, off, or offline | Jobs stay `queued`, and status says when the Mac was last seen. When it's back, it drains them one at a time, oldest first. |
| Mac drops mid-download | The lease expires after 15 minutes and the job is reclaimed. A completion that arrives late is still accepted (idempotent). |
| Network flaps | The Mac backs off (15 s → 5 min max) and logs once when the Worker goes unreachable and once when it's back. |
| DNS for the hostname is stale on the Mac | Same as offline, until the cache expires. To clear it now: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`. |
| Protocol mismatch after an upgrade | `409` on every poll and an error in `dj-sync.log`. No jobs are claimed until the Worker and Mac agree. |
| Worker or D1 incident | ChatGPT gets an error. Nothing is lost, because jobs already in D1 stay queued. |
| Rekordbox open when a playlist change arrives | It's mirrored into the XML at once, and the job stays `running` until Rekordbox quits and master.db is updated. |
| Mac hasn't shared its library yet | The playlist tools answer *"Your Mac hasn't shared its Rekordbox library yet"*. The Mac uploads the snapshot on its next poll. |

## Cost (free plan)

Polling every 15 s comes to about 5.8k Worker requests and 5.8k D1 writes a day
while the Mac is online. That's well inside the free limits of 100k requests
and 100k D1 writes a day. The library snapshot is a KV write, and it only
happens when the library changes. Finished jobs are deleted after 30 days by a daily
cron.
