# Changelog

All notable changes to `@ai-agents/dj-sync-cloud` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Worker has two versions:

- **Worker version.** `package.json` and `WORKER_VERSION`, kept in sync by a
  test.
- **Agent protocol.** `AGENT_PROTOCOL`, the API the Mac polls.
  - **MINOR bump:** additive changes. A Mac on an older MINOR keeps working.
  - **MAJOR bump:** breaking changes. Every Mac on the old MAJOR is refused with
    `409 incompatible_protocol` until it's upgraded.

## [1.3.0] — 2026-10-28

Connect-anywhere spec (`docs/superpowers/specs/2026-10-28-dj-sync-connect-anywhere-design.md`).
Agent protocol unchanged (2.0.0).

### Added
- **The shared Telegram bot** (§1).
  - **Webhook:** `POST /telegram/webhook`, which needs
    `X-Telegram-Bot-Api-Secret-Token`. Group chats are ignored.
  - **Pairing:** a `telegram` link (`POST /v2/agent/links {kind:"telegram"}`)
    returns `url: https://t.me/<bot>?start=<code>` and `expires_at`. The
    one-time code (22 characters) is held in the Registry for 10 minutes.
    `/start <code>` binds the chat, the latest pairing wins, and the chat
    gets a welcome.
  - **Link list:** `GET /v2/agent/links` shows `paired`, `telegram_username`
    and a label like "Telegram (@user)".
  - **Unpairing:** rotate issues a new code and lets the chat go. Delete and
    `/stop` unpair, and the chat is told.
  - **Sending links:** a clear playlist hint queues the download pinned to that
    playlist. No hint, or an unclear one, gets buttons: the closest playlists,
    the DJ Sync folder first, Default, and "New playlist" when unclear.
    Choices last 24 hours.
  - **Commands:** `/playlists [words]`, `/search <words>`, `/status`, `/help`,
    `/stop`.
  - **Finish notifications:** "✅ …" or "⚠️ …" reach the chat when its job
    completes.
  - **Limits:** 60 messages an hour per chat, with one warning. Replies are
    trimmed to 4,096 characters.
  - **Setup:** `POST /v2/admin/telegram/setup` (Bearer `ADMIN_TOKEN`) calls
    setWebhook (secret, message and callback_query updates, drop pending),
    setMyCommands, setMyDescription and setMyShortDescription, and returns
    getMe.
  - **New storage:** Registry tables `pairing_codes` and `telegram_chats`.
    Tenant tables `telegram_chats`, `tg_pending` and `tg_jobs`, added to
    existing DJs by `SqlStore.migrate`.
- **`move_tracks`** (§1b): moves `track_ids` (or `all: true`) from one
  playlist to another in **one** library job.
  - Ops: `ensure_playlist` when `create_playlist`, then `add_to_playlist` in
    source order, then `remove_from_playlist`, each pinned by `playlist_id`.
  - Playlists are resolved with the same suggestions and ambiguity question
    as the other tools, and `from_playlist_id`/`to_playlist_id` break ties.
  - Tracks not in the source are listed, and nothing is queued. Moving a
    playlist into itself is refused.
  - The summary reads "Move N tracks from "A" to "B"".
  - The server instructions and `add_tracks_to_playlist` now say that copying
    is `add_tracks_to_playlist` and moving is `move_tracks`.
- **`GET /api/playlists`** (Shortcut bearer, or the legacy key): `{playlists:
  [{playlist_id, name, folder, path, tracks}]}`, the DJ Sync folder first,
  then A–Z by path.

### Changed
- **`POST /api/downloads`** resolves `playlist_name` like the MCP tools,
  including the "Folder/Name" path that `/api/playlists` returns, and pins
  `playlist_id` when it matches one playlist. Otherwise the name is used as
  given. It also takes an optional `playlist_id` (a stale id gets 400), and
  the response includes `playlist_id`.
- **Claude's origins are accepted:** `claude.ai`, `*.claude.ai` and
  `*.anthropic.com`.
- **Link kinds** now include `telegram`. Without the bot configured, creating
  one is 503 `telegram_not_configured`.

## [1.2.0] — 2026-10-28

### Changed
- **The canonical host is djsync.jeffrey.build** (`PUBLIC_HOST`). It's reached
  through dj-sync-site's service binding, and new link and Shortcut URLs use
  it.
- **mcp.triplejmusic.art stays an alias** (`PUBLIC_HOST_ALIASES`): its route is
  kept and its Origin is accepted. Existing connector URLs keep working, since
  MCP clients don't reliably follow redirects on POST or WebSocket.

### Added
- **A browser opening `/` on an alias host gets a 301** to the canonical
  website.

## [1.1.0] — 2026-10-28

### Added
- **Playlists are matched the way people say them.** The tiers are: exact
  name, then ignoring case, then ignoring punctuation, emoji and accents,
  then ignoring spaces too ("warm up" → "Warmup"). "Folder/Name" also
  works, and `playlist_id` breaks exact ties.
- **When the name is unclear, nothing happens and the closest playlists come
  back instead**, as `error: playlist_not_found | playlist_ambiguous` with
  `suggestions[{playlist_id, name, folder, path, tracks}]`, so ChatGPT asks
  the user. Every playlist tool, and downloads, work this way.
- **`download_to_rekordbox` puts tracks in the playlist the user meant.** It
  resolves `playlist_name` (or `playlist_id`) against the library. A new
  playlist is made only with `create_playlist: true`.
- **Every library op, and download jobs, carry the resolved `playlist_id`**,
  so the Mac acts on exactly that playlist. Tenants get a `jobs.playlist_id`
  column through a lazy migration.
- **`get_playlist` pages:** `offset` and `limit` (500 per page by default,
  up to 1000), `next_offset`, and `playlist_id`.

### Fixed
- **ChatGPT couldn't see every song.** `get_playlist` stopped at 200 tracks,
  and `list_playlists` text stopped at 100 playlists.

## [1.0.0] — 2026-10-28 · agent protocol 2.0.0 (1.1.0 kept until retirement)

The public, multi-DJ cloud from the distribution spec
(`docs/superpowers/specs/2026-10-28-dj-sync-public-distribution-design.md` §3).

### Added
- **One SQLite Durable Object per DJ (`Tenant`)**, holding that DJ's jobs,
  assistant links, agent state and library snapshot. It runs the same 10 MCP
  tools over `SqlStore`, which implements the existing `Store` interface.
- **`Registry` Durable Object**, a single instance:
  - Handles `POST /v2/register`, with 5 sign-ups per IP per UTC day and a
    global kill switch at 5,000 a day. IPs are only kept as salted per-day
    hashes.
  - Keeps the tenant list with each DJ's last-seen day.
  - Serves `GET /v2/stats` (Bearer `ADMIN_TOKEN`).
  - Runs a weekly sweep (cron `41 4 * * 1`) that purges DJs inactive for 90
    days, in batches that continue from an alarm.
- **Links:** per-assistant secret URLs `/<tenant_id>/<link_secret>/mcp`.
  - `GET`/`POST /v2/agent/links`, `POST /v2/agent/links/{id}/rotate` and
    `DELETE /v2/agent/links/{id}`, with at most 10 links.
  - Only hashes are stored, and they're compared in constant time.
  - `last_used_at` is written on first use, then at most hourly.
  - `shortcut` links also work as `Bearer <tenant_id>.<secret>` on
    `/api/downloads`.
- **Agent protocol 2.0.0:** one WebSocket at `GET /v2/agent` (hibernation API).
  - Frames: `hello`, `ready`, `extend`, `complete` and `library_hash` from the
    Mac; `welcome`, `job`, `ack`, `library_wanted` and `error` from the cloud.
  - Close codes: 4001, 4009, 4010 and 4029.
  - `ping`→`pong` is an auto-response that never wakes the object.
  - Jobs are pushed the moment they're queued if the Mac is idle, one at a
    time.
  - A lease alarm exists only while a job is leased.
- **`PUT /v2/agent/library`:** a gzip'd (or plain) snapshot of up to 8 MB,
  stored gzip'd in rows of at most 1 MB and cached decompressed per instance.
- **Per-DJ limits:** 50 queued jobs, 200 jobs a day, 600 tool calls an hour
  and 120 agent reconnects an hour. Over a limit, MCP tools return `isError`
  with a plain message.
- **Retention:** lazy 30-day retention for each DJ.

### Changed
- `/health` adds `protocol_v2`. Once `V1_RETIRED="true"` it's just `{status,
  version, protocol: "2.0.0"}`.
- `submitLibrary` returns a `Result`, like `submit`. Both check the optional
  `Deps.admit` hook.
- The MCP and Shortcut HTTP handlers moved to `src/http.ts` and are shared by
  v1 and the Tenant.

### Migration (spec §3.9)
- **v1 is unchanged until `V1_RETIRED="true"`:** D1, KV, `/agent/*`, the
  legacy secret path and the Shortcut key all keep working.
- **After that:** `/agent/*` returns `410 upgrade_required`, and the legacy
  secrets are forwarded to the DJ named by `LEGACY_TENANT_ID`.

## [0.2.0] — 2026-10-28 · agent protocol 1.1.0

### Added
- ChatGPT playlist management, answered from a snapshot of the Mac's
  Rekordbox library:
  - Reads: `list_playlists`, `search_tracks`, `get_playlist`. These work while
    the Mac is offline and report `library_as_of` and `mac_online`.
  - Writes: `create_playlist`, `add_tracks_to_playlist`,
    `remove_tracks_from_playlist`, `rename_playlist`, `delete_playlist`.
    Each is checked against the snapshot, then queued as a **library job**
    (identical active jobs are reused), and returns a `job_id`.
- Agent protocol 1.1 (MINOR bump, so 1.0 Macs keep working):
  - `POST /agent/library` (body up to 16 MB, protocol ≥ 1.1): the Mac uploads
    `{hash, generated_at, library_version, playlists, tracks}`. It's stored in
    KV (binding `LIBRARY`), with the hash on the agent row.
  - `POST /agent/poll` accepts an optional `library_hash` and answers
    `library_wanted` (true when it differs from the stored one).
  - Claimed jobs carry `kind` (`download` or `library`). Library jobs add
    `ops` (`ensure_playlist`, `add_to_playlist`, `remove_from_playlist`,
    `rename_playlist`, `delete_playlist`) and a `summary`. Agents on protocol
    1.0 are never handed a library job.
  - `POST /agent/jobs/{id}/complete` accepts an optional `library_version`.
- Migration `0002_library.sql`: `jobs.kind`, `jobs.ops`, `jobs.summary` and
  `agent.library_hash`, `library_generated_at`, `library_version`.

### Changed
- `get_download_status` describes any job, download or playlist change, and
  shows the Rekordbox library version a library job produced.

## [0.1.0] — 2026-10-28 · agent protocol 1.0.0

### Added
- The MCP endpoint `POST /<MCP_SECRET_PATH>/mcp`, served on the
  `mcp.triplejmusic.art/*` route. It mirrors the Mac's own MCP lane
  (`download_to_rekordbox`, `get_download_status`), but downloads are queued
  in D1 so ChatGPT works while the Mac is offline.
- The iOS Shortcut REST routes `POST /api/downloads` and
  `GET /api/downloads/{id}`, using Bearer `SHORTCUT_API_KEY`.
- The agent API, protocol 1.0.0: `POST /agent/poll` (heartbeat, lease
  extension, and atomic claim of the oldest queued job or an expired lease)
  and `POST /agent/jobs/{id}/complete` (idempotent).
- `GET /health`, which reports whether the Mac is online and the queue depth.
- A daily cron that deletes finished jobs older than 30 days.
