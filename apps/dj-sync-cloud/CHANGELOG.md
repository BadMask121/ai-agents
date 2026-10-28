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
