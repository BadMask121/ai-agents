# Changelog — dj-sync

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning:
[Semantic Versioning](https://semver.org/). While the version is below 1.0.0, a
MINOR bump may include breaking config changes. Those are called out.

Three things are versioned independently:
- **this crate**
- **the cloud agent protocol**: `cloud::AGENT_PROTOCOL`, which must stay
  MAJOR-compatible with `apps/dj-sync-cloud`
- **the import XML**: each saved state is a semver snapshot (see
  `docs/dj-sync/40-chatgpt-mcp-design.md`)

## [1.1.0] — 2026-10-28 · connect from anywhere

### Added
- **`/local/links` accepts kind `telegram`.**
- **Links pass through the cloud's `paired`, `telegram_username` and
  `expires_at`.** The pairing link (`url`) and its expiry stay in
  `links.json` like other secrets; `paired` always comes from the cloud.
  Rotate sets a new code and clears the pairing.
### Changed
- **`CloudError::Rejected` carries the cloud's `error` code.** `/local/*`
  error replies now include `"code"`.
- **A 503 with error `telegram_not_configured` is a refusal, not an outage.**
  It reaches the app with its message instead of "cloud returned 503". Other
  5xx answers are still outages.

## [1.0.2] — 2026-10-28
- **No service changes.** The version moves with the menu app (one product
  version).

## [1.0.1] — 2026-10-28

### Changed
- **DJ Sync lives at djsync.jeffrey.build.** It's the cloud default, and the
  tools manifest is now `https://djsync.jeffrey.build/download/tools-manifest.json`.
  The release feed and downloads are under `/download/`.
- **mcp.triplejmusic.art still serves the same cloud.** A Mac whose
  `cloud.json` names it keeps its identity on the new host: `cloud.json` and
  the saved link URLs are re-pointed (`adopt_credentials`). It is never
  re-registered, which would have replaced every assistant link.

## [1.0.0] — 2026-10-28 · first public release

### Added
- **Downloads and playlist changes land in exactly the playlist ChatGPT
  resolved,** even when two playlists share a name.
  - Cloud jobs and library ops carry Rekordbox's `playlist_id`.
  - `rbdb.py` finds playlists by id first, falling back to the name if
    that id is gone.
  - `JobQueue::submit_to` takes the id.
- **Everything from 1.0.0-rc.1:** the public app, the bundled service, the
  toolbox, cloud v2, onboarding and the updater.

## [1.0.0-rc.1] — 2026-10-28 · one product version with the app

From this release the menu app and the service it carries share one version.

### Added
- **Runs with no setup.** A brand-new install needs no `config.toml` and no
  `.env`:
  - every section has a default, and `[library]`/`[rekordbox]` are checked
    only when the Telegram bot lane runs;
  - the cloud lane is on by default;
  - `rekordbox_db` is on whenever Rekordbox has a library on this Mac;
  - new installs save to `~/Music/DJ Sync`, while Macs that already have
    `~/Music/DJ_Downloads` keep it.
- **`POST /local/rekordbox/baseline`** backs up Rekordbox's library right away
  ("your library as it was before DJ Sync", v1.0.0 on a fresh Mac). It needs
  Rekordbox closed; otherwise the backup is taken before the first change, as
  before.

### Changed
- **The local HTTP server always runs** for the menu app (`/local/*`). The
  secret-path MCP route exists only with `[mcp] enabled = true` and
  `MCP_SECRET_PATH`; the Shortcut REST only with `SHORTCUT_API_KEY`.
  `/local/status` reports `mcp: null` without that route.

## [0.9.0] — 2026-10-28 · agent protocol 2.0.0 (cloud v2)

### Added
- **Cloud lane v2** (`cloud_v2.rs`; spec
  `docs/superpowers/specs/2026-10-28-dj-sync-public-distribution-design.md` §3).
  It needs dj-sync-cloud 1.0.0.
  - **No account.** The Mac registers itself and keeps
    `{tenant_id, agent_token}` in `~/.dj-sync/cloud.json` (0600).
  - **One WebSocket** to the DJ's Durable Object replaces 15-second polling, so
    jobs are pushed instantly.
  - **Results are resent** after a dropped socket until the Worker acks them.
  - **Keep-alive** pings, `extend` for leases, and `library_hash` →
    `library_wanted` → a gzip `PUT` of the snapshot.
  - **Close codes:** 4001 means re-register, but only after 3 in a row, since
    re-registering changes every link. 4009 and 4029 wait 10 min; 4010 waits
    1 min.
- **Assistant links:** `GET/POST /local/links`, `POST /local/links/{id}/rotate`
  and `DELETE /local/links/{id}`, local only. Link URLs live only in
  `~/.dj-sync/links.json` (0600); the cloud keeps hashes.
- **`~/.dj-sync/runtime.json` `{port, pid, version}`.** If 127.0.0.1:8000 is
  taken, the HTTP lane falls back to a free port. `/local/status` reports
  `cloud.protocol`, `cloud.registered` and `cloud.connected`.
- **`[cloud] protocol`** (default 2; 1 is the v1 poll, kept for rollback) and
  **`ping_secs`** (default 60).
- **Toolbox** (`toolbox.rs`, `[toolbox]`, spec §2.4). It installs yt-dlp,
  deno, uv, ffmpeg and spotdl (in a uv-managed Python) into
  `~/.dj-sync/tools`.
  - **Manifest:** signed with the release key. It comes from
    `downloads.triplejmusic.art`, else the last verified copy, else the one
    built in.
  - **Downloads:** sha256-checked, smoke-tested (`--version`), then switched
    live by an atomic `current` symlink. The previous version is kept.
  - **yt-dlp** follows its GitHub releases daily, verified against
    `SHA2-256SUMS`, and never downgrades.
  - **Cloud lane** waits for the first install pass, so jobs wait in the
    cloud rather than failing.
  - **Local API:** `GET /local/toolbox`, `POST /local/toolbox/install`.
  - **Tested for real:** all five tools install and run on this Mac in
    48 s (about 390 MB once uv's cache is cleared).
- **Defaults point at the toolbox:** tool paths, `extra_path` (deno and
  ffmpeg) and `rekordbox_db.uv_bin`. Explicit paths in `config.toml` still
  win. uv's Pythons and cache stay inside the toolbox.
- **`signing.rs` + `dj-sync-sign`** (feature `release-tools`): Ed25519 keygen,
  sign and verify for the tools manifest and the update feed. The release
  public key is compiled in; the private key lives in
  `~/.dj-sync-release/ed25519.key` (0600).
- **The library is re-shared right after a playlist change lands**, so the
  assistant can act on a playlist it just created. Before, the
  once-a-minute snapshot limit left about a minute of "no such playlist".
- **Shortcut links** keep `api_url` and `token`. Cloud refusals (400/409, e.g.
  `too_many_links`) reach the menu app with their status and message.

### Changed
- **`agent_core.rs`:** the job handling both lanes share, with results kept
  pending until the transport confirms them. The v1 lane is now a thin HTTP
  transport over it.

### Fixed
- **Flaky test.** The cloud library-job test could report before the local job
  was marked done.

## [0.8.0] — 2026-10-28

### Added
- `POST /local/rekordbox/retry` and `POST /local/rekordbox/dismiss` (local
  only, like restore and apply). They requeue or forget library changes that
  were set aside after failing, and back the menu app's **Retry** and
  **Dismiss** buttons.

### Fixed
- **Playlist changes from ChatGPT failed with `'DjmdContent' object has no
  attribute 'first'`.** Looking a track up by its Rekordbox ID returns the
  row itself, not a query; `rbdb.py` now handles both.
- The finished-change message no longer repeats the summary and version,
  which the Worker already shows.
- **The untouched original master.db backup (v1.0.0) is never pruned.**
  Before, only the newest 12 backups were kept, so the pristine library would
  have been deleted after 12 changes.

## [0.7.0] — 2026-10-28 · agent protocol 1.1.0

### Added
- **ChatGPT playlist management, Mac side.**
  - **Library jobs** from the cloud queue (create, add to, remove from, rename
    or delete a playlist) run through the job queue. Each one is mirrored
    into the import XML straight away, so it shows under "rekordbox xml" even
    with Rekordbox open, and queued for Rekordbox's own library.
  - **Done means applied.** The cloud job stays open, with its lease extended,
    until that batch is actually applied to master.db. It's then reported
    with the library version.
- **Library snapshot sharing.** dj-sync shares the playlists (with folders and
  track IDs) and a track index (title, artist, album, genre, BPM, key, length)
  with the Worker, so ChatGPT can browse and search the library while this
  Mac is offline.
  - **Rebuilt** when master.db changes, at most once a minute (`rbdb.py
    snapshot`, read-only).
  - **Uploaded** only when the Worker's copy is stale (`library_hash` and
    `library_wanted`).
  - **File paths stay on this Mac.**
- `ImportDoc`: `rename_playlist`, `remove_from_playlist`, `delete_playlist`,
  `track_id_for_path`.
- `RekordboxLibrary`: `enqueue` returns a batch ID, plus `batch_outcome`,
  `snapshot` and `current_version`.

### Changed
- **Agent protocol 1.0.0 → 1.1.0 (MINOR, additive).** Deploy dj-sync-cloud
  0.2.0 first: a 1.0 Worker refuses 1.1 agents with `409 incompatible_protocol`
  by design.

## [0.6.0] — 2026-10-28

### Added
- **Writes to Rekordbox's own library** (`[rekordbox_db]`, `rekordbox_db.rs` and
  the bundled `rekordbox/rbdb.py`, pyrekordbox 0.5.0). Downloads now land in
  the real Collection and in a playlist inside a **DJ Sync** folder, with no
  manual "Import Playlist". The import XML is still written as well, so it
  keeps working while Rekordbox is open.
  - **Only while Rekordbox is closed.** Changes made while it's open are
    queued in `~/.dj-sync/rekordbox-pending.json` and applied within seconds
    of it quitting. Queued batches survive restarts and are merged into one
    transaction (all or nothing). A batch that keeps failing is set aside
    after 3 tries.
  - **Semver backups of master.db** in `~/.dj-sync/rekordbox-backups/`, made
    as APFS clones. A snapshot is taken before each write, as a MAJOR when
    Rekordbox itself changed the library since dj-sync last wrote. Another is
    taken after the write, MINOR for a new playlist or PATCH for other
    changes. `index.json` records when and why. `keep_backups` defaults to 12.
  - **Restore.** Rekordbox must be closed. The current library is snapshotted
    first, so the restore can be undone.
  - **Self-installing helper.** dj-sync installs the helper into `~/.dj-sync`
    and creates its Python environment with uv the first time it's needed.
- `/local/status` gains `rekordbox_db` (pending, failed, last applied, current
  version, backups). New `POST /local/rekordbox/apply` and `POST
  /local/rekordbox/restore` endpoints are for the menu bar app; they refuse
  requests relayed by Cloudflare and anything with a browser `Origin`.
- Job messages say when the tracks reach the Rekordbox library: now, or once
  Rekordbox quits.

### Changed
- `xml_versions::Versions` handles any file. Snapshots are APFS-clone copies,
  compared in chunks, with configurable retention and `restore`.

## [0.5.0] — 2026-10-28

### Added
- `GET /local/status` lists the last 10 jobs (was 3), each with `links`,
  `tracks`, `errors` and `xml_version`, so the menu bar app can notify about
  new requests and finished downloads.

## [0.4.0] — 2026-10-28

### Added
- `GET /local/status` now also reports `mcp.public_url` (the URL the ChatGPT
  plugin uses: the cloud queue host, or the tunnel host if the cloud lane is
  off), `mcp.local_url`, and `shortcut_url`. All are for the menu bar app's
  Connections card.

## [0.3.0] — 2026-10-28

### Added
- `~/.dj-sync/settings.json` (written by the **DJ Sync menu bar app**,
  `macos/`): `download_dir` overrides `[download].dir`. It's re-read before
  every job, so a new folder applies from the next download with no restart.
  The folder is created on demand and write-tested first. If it's blocked (for
  example by macOS privacy controls), the job fails with a clear hint instead
  of downloading nowhere.
- `GET /local/status` for the menu bar app (localhost only; refuses requests
  relayed by Cloudflare). It reports the effective download folder and its
  source, whether dj-sync can write there, the import XML path and version,
  the cloud lane, and recent jobs.

## [0.2.0] — 2026-10-28

### Added
- **ChatGPT MCP download lane** (`[mcp]`). It's an axum server with a
  hand-rolled MCP endpoint at `/<MCP_SECRET_PATH>/mcp` and two tools,
  `download_to_rekordbox` and `get_download_status`. Downloads go through
  spotdl (Spotify) and yt-dlp (YouTube) into `~/Music/DJ_Downloads`, and the
  tracks are upserted into the Rekordbox import XML without removing anything.
- **Cloud lane** (`[cloud]`) that polls the dj-sync-cloud Worker. Jobs sent
  from ChatGPT while the Mac is offline run when it's back. Agent protocol 1.0.0.
- **Semver snapshots** of the import XML in `<file>.versions/`. MAJOR covers
  the adopted original or an outside edit, MINOR a new playlist, PATCH added
  tracks. Configured with `download.keep_versions`.
- **No Rekordbox setup:** `download.import_xml` defaults to Rekordbox's own
  *Imported Library* path.
- **iOS Shortcut REST** at `/api/downloads`, behind `SHORTCUT_API_KEY`.
- **launchd and Cloudflare Tunnel templates** in `deploy/`.

### Changed
- **Lanes are optional:** the Telegram bot only starts when
  `TELEGRAM_BOT_TOKEN` is set, and an empty token counts as unset.
- **Secrets:** `~/.dj-sync/.env` is loaded before `./.env`.
- **Logging and shutdown:** logs go to stderr, and SIGTERM shuts down cleanly.
- **Single instance:** a lock file (`~/.dj-sync/dj-sync.lock`) allows only
  one download worker at a time.

### Fixed
- **Paths with `?` or `#`:** Rekordbox `Location` values containing them were
  cut short when read. Locations are now encoded the same way Rekordbox's own
  export encodes them.

## [0.1.0] — 2026-04-30

### Added
- **Telegram bot:** Spotify playlist → local-library matching (ISRC → fuzzy
  → optional AI), Rekordbox AutoImport copy, a Rekordbox XML browser, and
  optional USB sync.
