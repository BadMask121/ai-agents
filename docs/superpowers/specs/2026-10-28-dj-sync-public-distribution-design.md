# DJ Sync public distribution (Mac first): design

**Date:** 2026-10-28 · **Status:** approved in brainstorming, part by part.

**Scope:** `apps/dj-sync` (service and menu app), `apps/dj-sync-cloud` (Worker), and a
new `apps/dj-sync-site` (website).

**Builds on:**
- [40](../../dj-sync/40-chatgpt-mcp-design.md), the ChatGPT lane
- [42](../../dj-sync/42-cloud-queue.md), the cloud queue
- [43](../../dj-sync/43-rekordbox-library.md), Rekordbox's library and playlist tools

## Goal

Any DJ with a Mac and Rekordbox can install DJ Sync for free in about five minutes,
without a terminal, an account or technical knowledge. They can then tell ChatGPT or
Claude to download tracks and manage Rekordbox playlists, even while their Mac is off.

**Not in scope for this design:**
- **Windows:** phase 2. The Rust core stays cross-platform for it.
- **Telegram:** after launch. Section 7 reserves its shape.
- **App-directory listings, paid tiers and analytics or telemetry.**

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Audience | **Fully public launch** |
| 2 | Platforms | **Mac first.** Windows next, as a new app shell over the same Rust core |
| 3 | Spotify/YouTube downloads | **On by default.** Downloaders run only on the DJ's Mac, and the cloud only ever carries links and status, never audio |
| 4 | Identity | **No accounts. The Mac is the account.** Each assistant (ChatGPT, Claude, later Telegram) is a revocable **link** to it. Chosen as the easiest model for non-technical DJs, and it extends to Telegram pairing |
| 5 | Signing | **Unsigned by Apple** (no $99 Developer ID). One self-made code-signing certificate keeps a stable identity. A clear "Open Anyway" guide, needed once |
| 6 | Cloud | **One Durable Object per DJ.** The Mac holds a hibernating WebSocket |
| 7 | Domain | **triplejmusic.art:** `mcp.` (connectors, fixed forever), `djsync.` (site), `downloads.` (files) |

### Earlier decisions this reverses (called out per CLAUDE.md)

- **`03-stack-decisions.md` → "Single-tenant by design … don't add multi-tenant code
  paths".** The **cloud** becomes multi-tenant, with each DJ isolated in their own
  Durable Object. Each **Mac** stays single-user.
- **`40-chatgpt-mcp-design.md` → "personal-use tool for one DJ's own prep".** DJ Sync is
  now distributed publicly with downloads on. The legal posture is limited to this:
  - the tools are fetched from their official sources;
  - nothing is downloaded or stored server-side;
  - the Terms say DJs are responsible for their rights to the music.
- **`42-cloud-queue.md` → HTTP polling every 15 s and one D1 queue.** Both are
  superseded by agent protocol 2.0.0. The v1 routes are retired once the owner's Mac
  has migrated (§3.9).

Those three docs get a short amendment pointing here when the work lands.

## 1. User journey

1. **Download.** `djsync.triplejmusic.art` has one **Download for Mac** button, which
   gives `DJ-Sync-<version>.dmg` (about 20 MB, universal). It contains no downloaders.
2. **First open.** The DJ drags the app to Applications and opens it. macOS blocks it
   once. The DMG window and the site both show *System Settings → Privacy & Security →
   Open Anyway*, with screenshots.
3. **Onboarding.** One window, three steps:
   - **Tools.** A progress bar fetches yt-dlp, deno, uv (which brings Python, spotdl
     and pyrekordbox) and ffmpeg. That's about 250 MB, from official sources, with
     checksums verified (§2.4).
   - **Rekordbox.** The app detects Rekordbox 6 or 7, master.db and the Imported
     Library path, and takes backup **v1.0.0**. It explains that every change is
     backed up and can be restored from the menu. The DJ picks a download folder
     (default `~/Music/DJ Sync`).
   - **Connect your assistant.** **ChatGPT** and **Claude** buttons each create a
     link (§3.2) and show its URL with a **Copy** button and a looping clip of where
     to paste it. A live check turns green once that link is first used
     (`last_used_at`): *"Connected — try: 'add this to a playlist called Friday'"*.
     The step can be skipped and finished later from the menu.
4. **Done.** The menu bar icon stays, and notifications arrive for incoming requests
   and finished downloads (existing behaviour).

After that, the app updates itself (§2.5) and yt-dlp is refreshed daily. Requests made
while the Mac is off wait in the cloud. Nothing asks for an email or a password.

## 2. Mac app and installer

### 2.1 Bundle and background service

```
DJ Sync.app/Contents/
  MacOS/DJSyncMenu           Swift menu bar app (LSUIElement)
  Helpers/dj-sync            Rust service (universal)
  Resources/…                icons, onboarding clips
```

- **Install.** On first launch, and whenever the bundled service version differs from
  the installed one, the app does the following:
  - copies `Helpers/dj-sync` to `~/.dj-sync/bin/dj-sync`;
  - writes `~/Library/LaunchAgents/com.triplejmusic.dj-sync.plist` (the existing
    label, `KeepAlive`, log at `~/Library/Logs/dj-sync.log`);
  - (re)starts the agent with `launchctl bootstrap` or `kickstart -k`.
- **Why a copy.** A copy written by the app carries no quarantine attribute, so the
  service never triggers its own Gatekeeper block. `SMAppService` isn't used, because
  it is unreliable without a Developer ID.
- **Ports.** The service binds a free local port (preferring `127.0.0.1:8000`, then
  ephemeral) and writes `~/.dj-sync/runtime.json` `{port, pid, version}`. The menu app
  reads the port from that file instead of hard-coding 8000.

### 2.2 Data layout (unchanged root)

All state stays in `~/.dj-sync/`, so the owner's install needs no migration:

| Path | What |
|---|---|
| `bin/dj-sync` | Installed service (§2.1) |
| `tools/<name>/<version>/`, `tools/<name>/current` | Toolbox (§2.4) |
| `pyenv/` | pyrekordbox venv (existing; now created with the toolbox's `uv`) |
| `config.toml` | **Optional.** Every section has defaults; only power users touch it |
| `settings.json` | App choices: download folder, `onboarded`, update channel |
| `cloud.json` (0600) | `{base_url, tenant_id, agent_token}` from registration (§3.2) |
| `links.json` (0600) | `[{id, kind, label, url}]`. Link URLs exist only here and in the DJ's assistant |
| `runtime.json` | `{port, pid, version}` |
| `rekordbox-pending.json`, `rekordbox-backups/` | Existing |

**Secrets:** the cloud stores hashes only, and the Mac stores the plain values in
0600 files. The Keychain isn't used, because its access lists are tied to code
identity and would prompt after updates if the certificate ever changed.

### 2.3 Service defaults for the public build

- **Cloud lane:** on by default (`https://mcp.triplejmusic.art`).
- **Local tunnel MCP lane and Telegram bot:** off unless configured, as today.
- **Library writing:** `rekordbox_db.enabled = true` when Rekordbox is detected.
- **Tool paths:** default to the toolbox's `current` paths. Explicit `config.toml`
  values still win.

### 2.4 Toolbox manager (new Rust module `toolbox.rs`)

**Signed manifest.** The manifest lives at
`https://downloads.triplejmusic.art/djsync/tools-manifest.json`, with a detached
Ed25519 signature at `tools-manifest.json.sig` (base64). The public key is compiled
into the service. The last good manifest is cached, and a copy built into the binary
is the fallback.

```json
{
  "schema": 1,
  "generated_at": "2026-11-01T00:00:00Z",
  "tools": {
    "yt-dlp": { "version": "2026.10.26", "bin": "yt-dlp",
                "universal": { "url": "…/yt-dlp_macos", "sha256": "…" },
                "auto_update": "github-release:yt-dlp/yt-dlp:yt-dlp_macos:SHA2-256SUMS" },
    "deno":   { "version": "2.9.8", "bin": "deno",
                "arm64": { "url": "…", "sha256": "…", "archive": "zip" },
                "x86_64": { "url": "…", "sha256": "…", "archive": "zip" } },
    "uv":     { "version": "…", "bin": "uv", "arm64": { … }, "x86_64": { … } },
    "ffmpeg": { "version": "…", "bin": "ffmpeg", "arm64": { … }, "x86_64": { … } }
  },
  "python": { "version": "3.12",
              "venvs": { "spotdl": ["spotdl==4.6.0"], "pyrekordbox": ["pyrekordbox==0.5.0"] } }
}
```

- **Install.** Each tool is downloaded over HTTPS to a temp file, checked against its
  `sha256`, unpacked into `tools/<name>/<version>/`, marked executable, and then
  `current` is atomically re-pointed.
- **Python.** `uv venv` + `uv pip install` creates the spotdl venv and the existing
  pyrekordbox venv (`uv` brings its own Python).
- **Sources.** Each tool comes from its own official release: yt-dlp, deno and uv from
  their GitHub releases. ffmpeg has no official Mac binary, so it comes from a
  reputable static build pinned by checksum. The source is chosen during
  implementation; it lives in the manifest, so it can change without an app release.
- **Daily yt-dlp check.** Once a day, the service compares the latest yt-dlp GitHub
  release with `current`. A newer one is verified against that release's
  `SHA2-256SUMS` and swapped in. The other tools change only when the manifest does.
- **Failure.** The previous `current` is kept, and the error appears in `/local/status`
  and the menu app. A job never starts against a half-installed tool.
- **Local API** for the menu app:
  - `GET /local/toolbox` returns `{tools: [{name, version, state, error?}], installing, progress}`.
  - `POST /local/toolbox/install` starts an install or repair.

### 2.5 Updater (Swift, inside the menu app)

Sparkle isn't used: its installer helpers expect Developer-ID-signed apps. Instead
there's a small built-in updater. The feed is
`https://downloads.triplejmusic.art/djsync/appcast.json` plus `appcast.json.sig`,
signed with the same Ed25519 key:

```json
{ "latest": { "version": "1.0.1", "min_macos": "14.0",
              "url": "https://downloads.triplejmusic.art/djsync/DJ-Sync-1.0.1.zip",
              "sha256": "…", "size": 0, "published_at": "…", "notes": "…" } }
```

1. **Check.** Daily, and from **About → Check for updates**. Verify the feed signature.
   If `latest.version` is newer, show *"Update to 1.0.1"* (the default is install on
   quit or click).
2. **Download.** Fetch the zip with `URLSession`. Downloads made by the app itself
   aren't quarantined, so there's no repeat "Open Anyway". Check its `sha256`.
3. **Unpack.** `ditto -x -k` into a temp dir. Check that `CFBundleIdentifier` matches
   and the version equals `latest.version`.
4. **Replace.** Move the old bundle aside, move the new one into place (same volume),
   and relaunch. The new app re-installs the service (§2.1). If `/Applications` isn't
   writable, open the DMG link instead.

### 2.6 Signing

- **Certificate.** One self-made code-signing certificate, "DJ Sync Release" (10-year
  validity), is created once by a script. The private key stays in the owner's login
  keychain, with a `.p12` backup kept by the owner.
- **What's signed.** The menu app and the service are signed with it (no hardened
  runtime, no notarization).
- **Why it matters.** The designated requirement stays the same across releases, so
  macOS keeps notification and folder permissions after updates.
- **Builds.** Universal (arm64 + x86_64) for both the Rust and Swift binaries.

### 2.7 Menu app screens (additions)

- **Onboarding window** (§1). It's shown when `settings.json` lacks `onboarded: true`,
  and it can be resumed.
- **Assistants.**
  - Each link shows its kind and label, *last used*, **Copy**, **Rotate** (new URL,
    old one stops working) and **Disconnect**.
  - **+ Connect ChatGPT / Claude** adds a link.
  - The actions go through `GET/POST /local/links`, `POST /local/links/{id}/rotate`
    and `DELETE /local/links/{id}`, which the service proxies to §3.3.
- **Tools.** Versions and state from `/local/toolbox`, plus a **Repair** button.
- **About.** The product version, **Check for updates**, and **Copy diagnostics**:
  versions, macOS, chip, tool states and the last 50 warning/error log lines, with
  every secret and URL path masked.

## 3. Shared cloud (Worker 1.0.0, agent protocol 2.0.0)

### 3.1 Components

| Unit | Responsibility |
|---|---|
| **Worker** (`src/index.ts`, `router.ts`) | Parses the route, does cheap validation, forwards to a Durable Object. Holds no per-DJ state |
| **`Tenant` DO** (SQLite), one per DJ, `idFromName(tenant_id)` | Jobs, links, agent connection, library snapshot, limits. Runs the existing MCP dispatch (`mcp.ts`, `library.ts`, `jobs.ts`) over a new `DoStore` implementing the existing `Store` interface |
| **`Registry` DO** (SQLite), a single instance | Registration (per-IP limits), the tenant list with `last_seen_day`, `/v2/stats`, the weekly inactivity sweep |

D1 and KV are retired after migration (§3.9).

### 3.2 Identity: tenants, tokens, links

- **`tenant_id`:** 128 random bits, base64url (22 chars). Not secret on its own.
- **`agent_token`:** 256 random bits, base64url, prefix `djsa_`. Used only by the Mac.
- **Link secret:** 256 random bits, base64url. One per link.
  - Link URL: `https://mcp.triplejmusic.art/<tenant_id>/<link_secret>/mcp`.
  - Link kinds: `chatgpt`, `claude`, `shortcut`, `other`, and later `telegram`.
  - A Shortcut link uses the same secret as `Authorization: Bearer <tenant_id>.<link_secret>`
    on `/api/downloads`.
- **Storage.** The DO stores only `sha256(agent_token)` and `sha256(link_secret)`.
  Comparisons are constant-time.
- **Showing a URL.** A link URL is returned only when it's created or rotated. The Mac
  keeps it in `links.json` so **Copy** works later.
- **Usage.** `last_used_at` is written on first use, then at most hourly. It powers
  the onboarding live check.

### 3.3 HTTP routes (Worker 1.0.0)

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | `{status, version, protocol}` (no per-DJ data) |
| `POST /v2/register` | Rate-limited per IP | Body `{agent_version, protocol, platform: "macos", arch}`. Returns 201 `{tenant_id, agent_token, worker_version}`. See §3.7 for limits |
| `GET /v2/agent` (WebSocket upgrade) | Bearer `agent_token` + `X-DJ-Sync-Tenant`, plus protocol and version headers as in v1 | The agent connection (§3.4) |
| `PUT /v2/agent/library` | Agent headers | Library snapshot, `Content-Encoding: gzip`, at most 8 MB compressed (§3.6) |
| `GET /v2/agent/links` | Agent headers | `[{id, kind, label, created_at, last_used_at}]` (no URLs) |
| `POST /v2/agent/links` | Agent headers | `{kind, label?}` → 201 `{id, kind, label, url}`. At most 10 links |
| `POST /v2/agent/links/{id}/rotate` | Agent headers | Returns the new `{url}`; the old secret stops working immediately |
| `DELETE /v2/agent/links/{id}` | Agent headers | 204 |
| `POST /<tenant_id>/<link_secret>/mcp` | Link secret | MCP, with the same transport rules as today: GET/DELETE → 405, 2026-07-28 probe → 400, foreign Origin → 403, >64 KB → 413. Unknown tenant or link → 404 |
| `POST /api/downloads`, `GET /api/downloads/{id}` | `Bearer <tenant_id>.<link_secret>` (shortcut link) | iOS Shortcut, as today |
| `GET /v2/stats` | Bearer `ADMIN_TOKEN` (Worker secret) | `{tenants, active_24h, active_7d, registrations_24h}` from the Registry |
| Legacy `POST /<MCP_SECRET_PATH>/mcp`, legacy `/api/downloads` with `SHORTCUT_API_KEY` | Existing secrets | Forwarded to `LEGACY_TENANT_ID` when that var is set (§3.9) |
| v1 `/agent/*` | n/a | 410 `{error: "upgrade_required"}` once retired |

### 3.4 Agent protocol 2.0.0 (WebSocket)

- **Format.** JSON text frames. One connection per tenant; a new one closes the old
  with code 4010 `replaced`.
- **Keep-alive.** The Mac sends the text frame `ping` every 60 s (the interval is a
  setting), and the DO answers `pong` with `setWebSocketAutoResponse`. This never
  wakes the DO or bills duration. Whether auto-answered pings still count as billed
  requests is checked in build step 1 (§3.10).
- **Online status.** The tenant is online while a socket is attached; no last-seen
  writes per message.

**Mac → cloud:**
- `{"type":"hello","protocol":"2.0.0","agent_version":"…","active":["<job_id>"],"can_claim":true,"library_hash":"<sha256>"|null}`
  is the first frame after connecting.
- `{"type":"ready"}`: the Mac can take one job (it finished or rejected the previous one).
- `{"type":"extend","active":["<job_id>"]}` every 5 min while a job is running.
- `{"type":"complete","job_id":"…","state":"done"|"failed","message":"…","tracks":[…],"errors":[…],"xml_version":"…"|null,"library_version":"…"|null}`
  has the same fields as v1 `complete`.
- `{"type":"library_hash","hash":"<sha256>"}` when the local snapshot changes.

**Cloud → Mac:**
- `{"type":"welcome","worker_version":"…","protocol":"2.0.0","library_wanted":bool}`
  answers `hello`.
- `{"type":"job","job_id":"…","kind":"download"|"library","playlist":"…","urls":[…],"attempt":n,"ops":[…]?,"summary":"…"?}`
  is pushed when the Mac can claim and a job is queued, or immediately when a job is
  enqueued while the Mac is idle and connected. One job at a time.
- `{"type":"ack","job_id":"…"}` follows a `complete`. Completions are idempotent, as in v1.
- `{"type":"library_wanted"}` follows a `library_hash` that differs from the stored
  one. The Mac then sends `PUT /v2/agent/library`.
- `{"type":"error","code":"…","message":"…"}` comes before a close.

**Close codes:**
- 4001 unauthorized
- 4009 incompatible protocol (the Mac logs it and retries every 10 min, as v1 does with 409)
- 4010 replaced
- 4029 over limits

**Compatibility:** the same rule as v1. Same MAJOR, and the agent's MINOR is no newer
than the Worker's.

### 3.5 Jobs and leases

- **What carries over from v1:** job rows and their fields, dedupe, `kind`/`ops`/`summary`,
  the 15-minute lease, and `attempt`.
- **Delivery.** It happens when the job is pushed, which sets `lease_until`. `extend`
  pushes the lease forward.
- **Expired leases.** A DO **alarm** is armed only while a job is leased, set to the
  earliest `lease_until`. When it fires, expired jobs go back to `queued` (attempt + 1)
  and are pushed again if the Mac is ready. There are no idle alarms.
- **Retention.** Cleanup is lazy and runs on `hello` and on MCP calls (at most once a
  day): finished jobs older than 30 days are deleted.

### 3.6 Library snapshot

- **Upload.** `PUT /v2/agent/library` carries
  `{hash, generated_at, library_version, playlists, tracks}`, gzip-encoded, with the
  same shape as v1 (no paths).
- **Storage.** The DO keeps the gzip bytes in `library_chunks(seq, data BLOB)`, at most
  1 MB per row, plus a `library_meta` row. The real library is about 2.5 MB of JSON and
  about 300–400 KB compressed.
- **Reads.** Decompressed once and cached in memory per DO instance, keyed by hash.
  Tool behaviour is unchanged from Worker 0.2.0.

### 3.7 Limits and abuse (free service)

**Per tenant** (enforced in the DO; over a limit, MCP tools return `isError` with a
plain message, and the agent socket closes with 4029 only for runaway reconnects):

| Limit | Value |
|---|---|
| Links per request | 25 (existing) |
| Track IDs per op | Existing `MAX_TRACK_IDS` |
| Queued jobs | 50 |
| Jobs per day | 200 |
| MCP calls per hour | 600 (in-memory window) |
| Links | 10 |

**Registration:** at most 5 per IP per day, counted in the Registry by `sha256(ip)`.
A global cap of 5,000 a day is a kill switch. Cloudflare's free rate-limiting rule on
`/v2/register` is a first line of defence.

**Inactivity:** a weekly cron asks the Registry for tenants not seen in 90 days and
calls each one's `purge()` (`deleteAll`). A purged Mac that comes back gets 401 on
connect and re-registers automatically. Its links change, and the app says so.

### 3.8 Privacy

| Stored per DJ | Never stored |
|---|---|
| Job links, playlist names and results | Names, emails or IP addresses (only salted per-day IP hashes, for the registration limit) |
| Library titles, artists, album, genre, BPM, key and length | File paths and audio |
| Hashes of tokens and link secrets | |

Finished jobs are deleted after 30 days and whole tenants after 90 days inactive. The
Privacy page states all of this.

### 3.9 Owner migration and v1 retirement

1. Deploy Worker 1.0.0 **alongside** the v1 routes, which stay working.
2. The owner's Mac updates to the new app and registers like anyone else.
3. Set `LEGACY_TENANT_ID` to that tenant. The existing `MCP_SECRET_PATH` and
   `SHORTCUT_API_KEY` secrets now reach it, so the owner's ChatGPT connector and iOS
   Shortcut keep working unchanged.
4. Retire v1: `/agent/*` returns 410, and the D1 database and KV namespace are deleted
   after a final export. Job history isn't migrated; the library is re-uploaded by the
   Mac.

### 3.10 Capacity (free tier)

| Resource | Limit | Per active DJ a day | Room |
|---|---|---|---|
| Worker requests | 100k / day | about 50 (MCP calls + a few REST); idle sockets cost about 0 | about 2,000 active DJs a day |
| DO storage | 5 GB | about 400 KB snapshot + jobs | about 12,000 DJs |
| DO rows written | 100k / day | about 20 | about 5,000 active DJs a day |

Past that, Workers Paid ($5/mo) raises every row by about 100×.

**To verify in build step 1:** do keep-alive pings answered by
`setWebSocketAutoResponse` count toward the request allowance (incoming WebSocket
messages bill at 20:1)?
- **If they do,** every **connected** Mac costs about 72 requests a day at a 60 s
  interval, which caps the free tier at about 1,400 online Macs. The fix is to raise
  the interval to the longest value that survives Cloudflare's and home routers' idle
  timeouts (measured, likely 2–4 min, giving about 2,800–5,500 Macs), or to switch on
  Workers Paid sooner.
- **If they don't,** idle Macs are free, as the table assumes.

## 4. Release, website and support

- **Website** (`apps/dj-sync-site`, plain HTML/CSS, Cloudflare Pages →
  `djsync.triplejmusic.art`). Pages:
  - home: what it does, 3 steps, **Download for Mac**
  - `/install`: Open Anyway with real screenshots
  - `/connect/chatgpt` and `/connect/claude`
  - `/faq`: Rekordbox open or closed, backups and restore, Mac offline, removing DJ Sync
  - `/terms` and `/privacy`
- **Downloads.** Cloudflare R2 bucket `dj-sync-downloads` on the custom domain
  `downloads.triplejmusic.art`, under `djsync/`:
  - `DJ-Sync-<v>.dmg`, `DJ-Sync-<v>.zip` and `DJ-Sync-latest.dmg`
  - `appcast.json` + `.sig`
  - `tools-manifest.json` + `.sig`
- **`apps/dj-sync/release.sh`:**
  1. Check for a clean tree and that the versions and CHANGELOGs agree.
  2. Build universal Rust (`lipo`) and Swift.
  3. Assemble and sign (§2.6) in `~/Library/Caches` (the iCloud xattr workaround).
  4. Make the DMG, whose background shows the drag arrow and Open Anyway steps, and
     the update zip.
  5. Compute checksums and sign the feed and the manifest with the dev-only Rust bin
     `dj-sync-sign` (Ed25519; key outside the repo).
  6. Upload with `wrangler r2 object put`, and `git tag djsync-v<version>`.
- **Versions.** From 1.0.0 the menu app and the bundled service share **one product
  version**. Worker 1.0.0, protocol 2.0.0. Semver and Keep a Changelog as today.
- **Support.** **Copy diagnostics** (§2.7) plus the support contact on the site. There
  is no telemetry.
- **Terms** cover: personal use; DJs are responsible for their rights to the music;
  library changes are backed up but there's no warranty; and what the cloud stores
  (§3.8).

## 5. Testing

- **Cloud.**
  - Move the 55 existing tests onto `DoStore` with `@cloudflare/vitest-pool-workers`,
    which runs real Durable Objects locally.
  - New tests:
    - tenant isolation (no job, library or link of one DJ is reachable with another's
      secret)
    - link create, rotate and revoke (an old secret returns 404)
    - WebSocket hello, welcome, job, complete and ack
    - lease expiry and redelivery through the alarm
    - each limit in §3.7
    - registration limits
    - the legacy mapping
    - v1 routes return 410 after retirement
- **Mac (Rust).**
  - The WebSocket lane against a fake server: reconnect with backoff, pushed job,
    extend, complete, `library_wanted` → PUT, close codes.
  - Registration, and re-registration on 401.
  - Toolbox: bad checksum refused, bad manifest signature refused, a failed update
    keeps `current`.
  - `runtime.json` port fallback.
- **Mac (Swift).** Updater (bad signature or checksum refused, older version ignored),
  the onboarding state machine, and the links model.
- **Clean-Mac test.** The full §1 journey in a fresh macOS user account, ending with a
  real download into Rekordbox via ChatGPT and via Claude. The owner signs in to
  Rekordbox in that account. The Intel build is smoke-tested under Rosetta.

## 6. Rollout and build order

**Build order:**
1. **Cloud v2 and the Mac WebSocket lane:** §3, plus `cloud.rs` v2, registration and
   links.
2. **Toolbox and bundled service:** §2.1–2.4.
3. **Onboarding, Assistants, Tools and About screens:** §2.7.
4. **Updater, signing, release script and R2:** §2.5, §2.6, §4.
5. **Website:** §4.
6. **Clean-Mac test, owner migration (§3.9), closed beta of 3–5 DJs, then the public page.**

## 7. Later (reserved, not built now)

- **Telegram.**
  - One shared bot whose webhook is `POST /telegram/<bot_secret>` on the Worker.
  - Pairing: the menu app shows a QR code for `t.me/<bot>?start=<code>`. The code is
    issued by the tenant and lasts 10 minutes, with `code → tenant_id` held in the
    Registry.
  - `/start <code>` creates a `telegram` link bound to that chat ID. Messages are then
    routed to the tenant's DO.
- **Windows.** A new tray app shell (for example Tauri) over the same Rust service.
  launchd, `pgrep` and paths get Windows equivalents. The cloud is unchanged.
- **Acapellas via the VoxSplit CLI** (bd `ai-agents-jff.5.6`, on hold).

## 8. Owner decisions before the public page goes live

- **Support contact** for the site and Terms: an email address, or a form.
- **Workers Paid.** Turn it on ($5/mo) when `/v2/stats` shows more than about 1,500
  active DJs a day.

## 9. Changes made during the build (2026-10-28)

- **Release key file.** The Ed25519 release key lives in
  `~/.dj-sync-release/ed25519.key` (0600, owner backs it up) instead of the
  keychain, which avoids keychain prompts in `release.sh`. It sits next to the
  "DJ Sync Release" certificate backup (`dj-sync-release.p12` and its password
  file).
- **The certificate stays untrusted.** It isn't marked trusted in macOS, so
  `security find-identity -v` hides it. `codesign -s "DJ Sync Release"` still
  signs with it, and the designated requirement anchors on its root hash.
- **Worker tests.** They use a `node:sqlite` Durable Object harness plus a
  workerd smoke test instead of `@cloudflare/vitest-pool-workers`, which would
  have meant a vitest major upgrade.
- **Socket refusals.** The Worker refuses sockets after the upgrade, with an
  `error` frame plus the close code (§3.4 allowed either). `ack` carries
  `result`. Shortcut links also return `api_url` and `token`.
- **Website hosting.** The site is served by Cloudflare Workers static assets on
  a custom domain rather than Pages. It's equally free and deploys from the CLI.
- **Library refresh.** After a playlist change is acked, the Mac re-shares the
  library immediately (skipping the once-a-minute limit), so an assistant can
  act on a playlist it just created.
- **Owner decisions:**
  - Support contact: **jeff.emakpor@gmail.com**, on the website footer,
    Privacy and Terms.
  - The closed beta (§6 step 3) is **dropped**. The public page went live
    directly after the owner migration, a fresh-home E2E run, and a live
    updater test (rc.1 → 1.0.0).
