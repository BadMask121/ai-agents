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
