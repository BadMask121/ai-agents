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
