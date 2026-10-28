# DJ Sync (menu bar app)

A small native macOS menu bar companion for the `dj-sync` service
(SwiftUI, macOS 14+). Version is in [`VERSION`](VERSION) (semver).

The menu has these parts:

- **Status.** It shows whether dj-sync is running and which version.
- **Downloads folder.** **Change…** opens the native folder picker and saves the
  choice to `~/.dj-sync/settings.json`. dj-sync applies it from the next
  download, with no restart needed. There are also **Show in Finder** and
  **Use Default** buttons. Files that were already downloaded stay where they
  are.
- **Warnings.** dj-sync runs in the background, and macOS can block background
  processes from Desktop, Documents, Downloads, iCloud Drive and external
  drives. The menu warns about those locations, and it shows dj-sync's own
  write test if the folder really is blocked.
- **Rekordbox XML.** It shows where the XML is and its current semver snapshot
  version.
- **Recent jobs**, plus **Restart Service**, **Open Log** and **Open at Login**.

## Build and install

```bash
./build-app.sh --install     # → ~/Applications/DJ Sync.app, launched
swift test                   # DJSyncCore tests (Swift Testing)
```

`build-app.sh` builds a release binary and puts it in an `.app` bundle with
`LSUIElement`, so the app has no Dock icon. The bundle is ad-hoc signed in a
temp folder. That's because iCloud's file provider tags anything new under
`~/Desktop` with attributes that `codesign` rejects.

## Layout

```
Package.swift
Sources/DJSyncCore/    settings.json read/write, path helpers, /local/status client  (nonisolated, tested)
Sources/DJSyncMenu/    SwiftUI MenuBarExtra app (main-actor by default)
Tests/DJSyncCoreTests/ Swift Testing
```

The app talks to dj-sync through `GET http://127.0.0.1:8000/local/status`,
which needs `[mcp] enabled = true`. Everything else goes through
`~/.dj-sync/settings.json` and `launchctl`.
