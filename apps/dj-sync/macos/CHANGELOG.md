# Changelog — DJ Sync (menu bar app)

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning:
[Semantic Versioning](https://semver.org/). The version lives in `VERSION`, and
`build-app.sh` stamps it into the bundle.

## [0.5.0] — 2026-10-28
### Added
- macOS notifications. **New download request** fires as soon as a request
  reaches this Mac (including ones queued while it was offline, once they're
  claimed). **Added to Rekordbox** or **Download failed** fires when a job
  finishes, with track count and XML version. Clicking a notification opens
  DJ Sync.
  - It works even with the panel closed: dj-sync is checked every 4 s.
  - Launching the app doesn't replay old jobs.
  - A job that's new and already finished produces one notification, not two.
  - Muted or restyled in System Settings → Notifications → DJ Sync.
  - Every notification is logged to `~/.dj-sync/notifications.log`.

## [0.4.2] — 2026-10-28
### Changed
- Compact everywhere: the window now uses the same single 340 pt column as
  the menu bar popover. The two-column wide layout is gone.

## [0.4.1] — 2026-10-28
### Fixed
- The popover under the menu bar icon is half width again: one 340 pt column,
  with Open at Login and the service actions in a footer row. It sizes to its
  content. The two-column 684 pt layout is used only in the window (opening
  the app from Finder or Spotlight), where there's room for it.

## [0.4.0] — 2026-10-28
### Added
- A **Connections** card:
  - The ChatGPT plugin MCP URL and the local MCP URL, with the secret path
    masked (an eye button reveals it) and a Copy button that confirms.
  - Cloud queue health: whether the Mac is online, how many jobs are queued,
    and the Worker version.
  - Cloudflare Tunnel route and whether it's running (standby while the cloud
    queue serves the hostname).
- If macOS hides the menu bar icon, the window explains why and how to fix it.
  The icon's placement is also written to `~/.dj-sync/menu-bar.json`.

### Changed
- The menu bar icon is now an AppKit `NSStatusItem` placed next to the clock
  on first run, rather than leftmost where a crowded notched menu bar hides
  it. The popover opens instantly.
- The visual design follows Emil Kowalski's design-engineering principles:
  - grouped cards with real Finder icons for the folder and the XML;
  - status dot and app glyph;
  - press feedback (scale 0.97, 120 ms ease-out) and hover fills;
  - 200 ms ease-out transitions on state changes only, with Reduce Motion
    respected.
- A pure AppKit entry point, so no stray Settings window.

### Fixed
- Building and testing from a folder iCloud manages. Build products now go to
  `~/Library/Caches/dj-sync-menu`, and bundles are signed in a temp dir.

## [0.2.0] — 2026-10-28
### Added
- Opening the app (Finder, Spotlight, `open`) shows the panel in a window.

## [0.1.0] — 2026-10-28
### Added
- A menu bar app that shows status and the downloads folder picker (writes
  `~/.dj-sync/settings.json`), plus Rekordbox XML, recent jobs, Restart
  Service, Open Log and Open at Login.
