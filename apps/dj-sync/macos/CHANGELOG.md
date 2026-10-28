# Changelog — DJ Sync (menu bar app)

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning:
[Semantic Versioning](https://semver.org/). The version lives in `VERSION`, and
`build-app.sh` stamps it into the bundle.

## [1.2.1] — 2026-10-28 · songs load to the deck

### Fixed
- **Downloaded songs load to a deck in Rekordbox again.**
  - **Before:** dj-sync's songs previewed but did nothing when loaded.
  - **New songs:** they now load.
  - **Older songs:** they're repaired the next time Rekordbox is closed. The
    library is backed up first and can be restored from Backups.

## [1.2.0] — 2026-10-28 · one-scan iPhone setup

### Changed
- **Connect iPhone shows a QR code.**
  - **Install:** scan it with the iPhone camera and tap Add Shortcut. DJ Sync
    builds and signs a personal Shortcut, and the code lasts 10 minutes, with
    New QR for a fresh one.
  - **New Key** makes a new code automatically, since the old Shortcut has the
    old key.
  - **Building by hand:** the URL and key move under "Show key and URL". That
    section opens by itself when this Mac can't sign Shortcuts (not signed
    into iCloud), with the setup guide.

## [1.1.0] — 2026-10-28 · connect from anywhere

### Added
- **Telegram in Assistants.** Connect Telegram shows a QR code of the bot's
  pairing link (CoreImage, kept crisp), with **Open Telegram**, **New Code**
  and the code's expiry. It checks every 3 s until the chat is paired, then
  shows **Telegram (@user)**. Onboarding offers Telegram next to ChatGPT and
  Claude.
- **iPhone in Assistants.** Connect iPhone shows the Shortcut's API URL and
  key, each with Copy; the key is masked unless revealed. **New Key** makes a
  fresh one, and **Setup guide** opens djsync.jeffrey.build/connect/iphone/.
- **Setup guide link on every assistant** (ChatGPT, Claude, Telegram, iPhone).
- **The Connect buttons sit in a 2×2 grid** that shows what each costs: Free,
  or Paid plan for ChatGPT.
### Changed
- **If the cloud hasn't set up Telegram yet** (503 `telegram_not_configured`),
  the app says "Telegram isn't available yet" instead of an error code.
- **Diagnostics** also masks Telegram pairing codes (`?start=…`).

## [1.0.2] — 2026-10-28

### Changed
- **The menu leads with Recent**, then Assistants, Downloads, Rekordbox and
  About.
- **The Tools card is gone.** Tools appear only while they're being installed,
  or when one needs repair (with Repair Tools).
- **The "Original ChatGPT URL" row is gone.** Assistant links are the one way
  to connect. The old address still works for anything already using it.

## [1.0.1] — 2026-10-28
- **Updates come from djsync.jeffrey.build** (`/download/appcast.json`). The
  DMG fallback link uses the same host. Older apps still find this release
  through `downloads.triplejmusic.art`, which serves the same files.

## [1.0.0] — 2026-10-28 · first public release
- **Released as DJ Sync 1.0.0.** It's one download at
  djsync.triplejmusic.art, and the app updates itself from now on.
- **Same app as 1.0.0-rc.1:** onboarding, Assistants, Tools, About, the
  bundled service and the signed updater.

## [1.0.0-rc.1] — 2026-10-28 · the public, one-download app

### Added
- **The service is inside the app.** `Contents/Helpers/dj-sync` is universal
  (Apple silicon and Intel), like the app. On launch the app copies the
  service to `~/.dj-sync/bin/dj-sync`, byte by byte so it carries no
  quarantine attribute. It also writes the
  `com.triplejmusic.dj-sync` LaunchAgent and (re)starts it, but only when
  either has changed. An older agent pointing elsewhere (e.g.
  `~/.cargo/bin`) is taken over.
- **Onboarding** (resumable until finished or skipped), one compact column:
  1. **Tools:** progress from the toolbox, plus Try Again.
  2. **Rekordbox:** detects the installed Rekordbox, takes the "before
     DJ Sync" backup, and lets the DJ choose the download folder.
  3. **Connect your assistant:** ChatGPT or Claude. It makes a private
     link, copies it, shows where to paste it, and runs a live check until
     the assistant calls in.

  Macs set up before onboarding existed skip it.
- **Assistants card,** replacing Connections. Each link shows when it was
  last used, with Copy, New URL and Disconnect, plus Connect ChatGPT and
  Connect Claude buttons and the cloud connection state. The original
  secret-path URL shows only while dj-sync still serves it.
- **Tools card:** what the toolbox installed and its versions, plus Repair.
- **About card:** the version, Check for Updates, and **Copy Diagnostics**
  (versions, macOS, chip, tools, assistants, and the last 50 warnings and
  errors, with every secret, token and URL secret masked).
- **Self-update.** Once a day, and on request, the app reads the signed feed
  `downloads.triplejmusic.art/djsync/appcast.json`.
  - **Checks:** the feed's Ed25519 signature against the release key
    (CryptoKit; verified against signatures from `dj-sync-sign`). Only
    newer versions this macOS can run are offered.
  - **Install:** download the zip and check its sha256, `ditto` it, check
    the bundle id and version, swap the app in place, relaunch.
  - **Fallback:** a read-only Applications folder opens the DMG instead.

### Changed
- **Signing.** `build-app.sh` builds both binaries universal and signs them
  inside-out with "DJ Sync Release" when that identity exists, else ad-hoc.
  CFBundleVersion is the numeric part of the version.
- **Worker 1.0's `/health`** has no single-agent fields; the app reads the
  connection from `/local/status` instead.
- **Timestamps** with milliseconds (from the cloud) parse.

### Removed
- **The tunnel and secret-URL rows,** which are superseded by assistant links.

## [0.8.0] — 2026-10-28
### Changed
- **The app finds dj-sync through `~/.dj-sync/runtime.json`** instead of
  assuming port 8000. It's read on every request, so a service restart on a new
  port is picked up. Needs dj-sync ≥ 0.9.0; older services still answer on 8000.

## [0.7.0] — 2026-10-28
### Added
- **Retry** and **Dismiss** for library changes that were set aside after
  failing. For example, after a fix, retry the change instead of losing it.

## [0.6.0] — 2026-10-28
### Added
- The **Rekordbox** card shows your **library** (master.db):
  - its semver version;
  - whether it's up to date, or how many changes are waiting ("quit
    Rekordbox to apply");
  - **Apply Now** when Rekordbox is closed;
  - changes that failed, with the reason.
- **Backups**: every master.db snapshot, with version, age and reason, and a
  **Restore** button behind a native confirmation. Restore is only enabled
  while Rekordbox is closed, and the current library is backed up first, so a
  restore is undoable.
- A **"Rekordbox library updated"** notification when queued changes reach
  the library.

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
