# DJ Sync uninstaller: design

- **Date:** 2026-10-28
- **bd:** `ai-agents-jff.6.22` (epic), under `ai-agents-jff.6`
- **Builds on:** `2026-10-28-dj-sync-public-distribution-design.md`, which
  covers the bundle and service (§2.1), the data layout (§2.2), the cloud
  (§3), privacy (§3.8) and the FAQ (§4).

## Goal

Removing DJ Sync should leave nothing running and nothing hidden:
- no background service;
- no 2 GB hidden folder;
- no data left in the cloud.

The DJ's music and Rekordbox library must not be touched.

**Today:**
- **Dragging the app to the Bin** leaves the LaunchAgent service running and
  connected. It shows in Login Items as "dj-sync" from "Triple J Music".
- **The hidden `~/.dj-sync` folder stays**, holding tools, settings and
  library backups (about 2 GB).
- **Smaller leftovers stay too:** preferences, caches and logs.
- **The cloud keeps the DJ** for up to 90 days.
- **The FAQ** asks people to delete a hidden folder and a plist by hand.

## Decisions (owner, 2026-10-28)

| Question | Decision |
|---|---|
| App dragged to the Bin | The service **stops itself and keeps data** (§3) |
| Library backups on uninstall | Kept by default, moved to **Music › DJ Sync Backups** |
| Cloud data on uninstall | **Deleted right away** (§2). The 90-day sweep still covers an offline Mac |
| Already deleted the app | **One Terminal command** in the FAQ: `~/.dj-sync/bin/dj-sync uninstall` |
| Where the logic lives | **The Rust service** (`dj-sync uninstall`). The menu button and the FAQ command run the same code |

**Never touched:**
- the download folders (music);
- Rekordbox's library (`master.db`);
- `rekordbox.xml` and its `rekordbox.xml.versions/`;
- anything outside the inventory in §1.2.

## 1. `dj-sync uninstall` and the menu button

### 1.1 Command

```
dj-sync uninstall [--delete-backups]
```

- **Module:** a new `src/uninstall.rs`, reached from `main.rs` before config
  loading and the service start.
- **Output:** one line per step on stdout, with a final `removed DJ Sync` or a
  list of anything still present.
- **Exit codes:** 0 when the inventory is gone, 1 otherwise.
- **Idempotent:** missing pieces are skipped, so it's safe to re-run.

### 1.2 Steps, in order

1. **Stop the service.** This step comes first because a running service that
   the cloud forgets re-registers on its next 401, which writes a brand-new
   `cloud.json` mid-uninstall.
   - Delete `~/Library/LaunchAgents/com.triplejmusic.dj-sync.plist`.
   - Run `launchctl bootout gui/<uid>/com.triplejmusic.dj-sync`; "not
     loaded" is fine.
2. **Forget the cloud.**
   - If `~/.dj-sync/cloud.json` exists, call `DELETE {base_url}/v2/agent`
     with the agent credentials (§2).
   - 204 and 404 both count as done.
   - Any other answer, or a network error, gives a warning ("the cloud deletes
     this Mac's data after 90 days without use") and the uninstall continues.
   - Timeout: 10 s.
3. **Library backups.**
   - **Kept (the default):** move `~/.dj-sync/rekordbox-backups` to
     `~/Music/DJ Sync Backups/`, and write `How to restore.txt` there.
     - If `DJ Sync Backups` already exists, the move goes into
       `DJ Sync Backups/<YYYY-MM-DD HHMM>/` instead.
     - A move across volumes falls back to copy, then delete.
   - **`--delete-backups`:** delete them.
4. **Delete `~/.dj-sync`.** This covers `bin/` (the running binary too: on
   macOS an unlinked binary keeps running), `tools/`, `pyenv/`, `config.toml`,
   `settings.json`, `cloud.json`, `links.json`, `runtime.json`, the pending
   queue, markers and `.env`.
5. **Menu app leftovers.**
   - `defaults delete com.triplejmusic.dj-sync.menu`.
   - Remove `~/Library/Caches/com.triplejmusic.dj-sync.menu`,
     `~/Library/Caches/dj-sync-menu` and
     `~/Library/HTTPStorages/com.triplejmusic.dj-sync.menu`.
   - Remove `~/Library/Logs/dj-sync.log` and `dj-sync.out.log`.
   - Run `tccutil reset All com.triplejmusic.dj-sync.menu`.

The paths come from the existing constants (`config::state_dir()`, the
service label, the menu app's bundle id), not from a second list.

`launchctl`, `defaults`, `tccutil` and the cloud call go through an injected
runner, so tests can use fakes, as `RekordboxLibrary`'s `Helper` does today.

### 1.3 Menu button (Swift)

- **Where:** About → **Uninstall DJ Sync…**, with `role: .destructive`.
- **Dialog:**
  - **Text:** "Uninstall DJ Sync? Your music and Rekordbox library stay as
    they are."
  - **Checkbox, ticked:** **Keep my library backups (Music › DJ Sync
    Backups)**.
  - **Queued changes:** when changes are waiting for Rekordbox to close, the
    dialog adds "N changes waiting for Rekordbox to close will be dropped".
  - **Buttons:** **Uninstall** and **Cancel**.
- **On Uninstall:**
  1. Run the bundle's `Contents/Helpers/dj-sync uninstall`, adding
     `--delete-backups` when the box is unticked. That copy always matches the
     button's version; the installed `~/.dj-sync/bin/dj-sync` is only a
     fallback.
  2. On exit 0, move the app to the Bin (`NSWorkspace.recycle`).
  3. Show "DJ Sync is removed" with the backups' location.
  4. Quit.
- **On failure:** show the command's output and leave the app in place.

## 2. The cloud forgets the Mac (Worker 1.5.0)

- **Route:** `DELETE /v2/agent`, with the agent headers from public
  distribution §3.3 (Bearer `agent_token` and `X-DJ-Sync-Tenant`).
- **Tenant DO:** `DELETE /__/agent` checks `sha256(agent_token)` in constant
  time, then runs the existing `purge()` (`deleteAll`). The agent WebSocket
  closes with it.
- **Registry: `forget(tenant_id)`.**
  - It deletes the `tenants`, `pairing_codes` and `telegram_chats` rows.
  - The weekly inactivity sweep's per-tenant steps move into this one function,
    so the sweep and the uninstall can't drift apart.
- **Responses:**

| Case | Response |
|---|---|
| Forgotten | 204 |
| Wrong or missing token | 401 |
| Unknown tenant (already forgotten) | 404 |

- **What other channels see afterwards:**
  - **MCP links and the Shortcut API:** the normal unknown-link 404.
  - **A paired Telegram chat:** the bot's usual "not paired" reply.
- **Owner's tenant:** it is also `LEGACY_TENANT_ID`. Forgetting it makes the
  legacy secret MCP path and Shortcut key stop working until a new install is
  connected. That is accepted.
- **Protocol:** agent protocol 2.0.0 is unchanged; this is a plain HTTP route.
  Deploy the Worker before the Mac release.

## 3. Watchdog: the service stops itself if the app is deleted

- **`app_path`.** On every launch the menu app writes its bundle path into
  `settings.json` as `app_path`, through `SettingsFile.recordAppPath`; other
  keys are kept.
  - **Not recorded:** temporary locations that vanish when the app quits, such
    as the installer disk image (`/Volumes/…`) and macOS App Translocation (an
    app opened straight from Downloads).
- **Check.** Once a minute, the service sees whether `app_path` exists.
  - **Stop:** when it has been missing for **10 consecutive minutes**, the
    service:
    1. deletes its LaunchAgent plist;
    2. logs `the DJ Sync app is gone; stopping the service (data kept)`;
    3. runs `launchctl bootout` on itself.
  - **Data:** kept. The cloud isn't called.
  - **Reinstall:** launching the app reinstalls the service, using the existing
    install-on-launch logic.
- **No-ops:**
  - `app_path` isn't set: an older app, or a source build run without the app.
  - The updater replaces the bundle in place (`replaceItemAt`), so the path
    never goes missing.
- **App moved to another folder:** the next launch rewrites `app_path`. If
  the app isn't opened within 10 minutes, the service pauses until it is.
- **Testability:** the clock and the "does it exist" check are injected, so
  tests don't wait 10 minutes.

## 4. Website, testing, release

### 4.1 Website (ships with `release.sh`)

- **FAQ "How do I remove DJ Sync?":**
  - In DJ Sync, About → **Uninstall DJ Sync…**.
  - Already deleted the app? In Terminal, run
    `~/.dj-sync/bin/dj-sync uninstall`.
  - What stays: your music and Rekordbox library, plus library backups in
    Music › DJ Sync Backups.
  - The cloud forgets the Mac immediately.
- **Privacy:** "Uninstalling deletes your data from the cloud immediately",
  next to the 90-day rule.

### 4.2 Tests

- **Rust, `uninstall.rs`** (temp `HOME`, fake runner, fake cloud):
  - every inventory path is removed;
  - backups are moved, deleted, or put in a dated subfolder;
  - an offline cloud only produces a warning;
  - a second run is a no-op that exits 0;
  - planted files in the download folder, `rekordbox.xml` and a fake
    `master.db` are untouched.
- **Rust, watchdog:** fake clock and existence check:
  - stops after 10 min missing;
  - resets when the app reappears;
  - no-op without `app_path`.
- **Cloud (vitest):**
  - `DELETE /v2/agent` removes jobs, links, the library, the Registry row and
    the Telegram chat;
  - 401 on a wrong token, 404 on a second call;
  - the sweep still purges through `forget()`.
- **Swift:** the dialog's choice maps to the right arguments, with and without
  `--delete-backups`.
- **End to end on the owner's Mac:** install from the website, connect, then
  Uninstall:
  - every inventory path is gone;
  - the backups are in Music;
  - the links answer 404;
  - a reinstall works.

### 4.3 Release

- **Versions:**
  - dj-sync and the app: **1.3.0**.
  - Worker: **1.5.0**.
  - Site: the next PATCH.
- **Order:**
  1. Deploy the Worker.
  2. Run `release.sh`, which builds, uploads, tags and deploys the site.
