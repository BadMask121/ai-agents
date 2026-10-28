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
