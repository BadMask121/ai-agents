# 43 — Rekordbox's own library (master.db) and ChatGPT playlist tools

**Status:** live 2026-10-28 (bd `ai-agents-jff.5`).
- **Mac:** dj-sync 0.8.0, `src/rekordbox_db.rs` + `rekordbox/rbdb.py`; DJ Sync menu app 0.7.0.
- **Worker:** dj-sync-cloud 0.2.0; agent protocol 1.1.0.

## Why

At first, downloads only went into the *rekordbox xml* tree. You could see them
under "rekordbox xml" in Rekordbox, but not in Collection or Playlists until
you dragged them in yourself. Now every change goes to **both**:

| Target | When it updates | Why both |
|---|---|---|
| Import XML (*Imported Library*) | Immediately | Visible under *rekordbox xml* even while Rekordbox is open |
| `~/Library/Pioneer/rekordbox/master.db` | Immediately if Rekordbox is closed, otherwise right after you quit it | Collection plus a **DJ Sync** folder in Playlists, like music you imported by hand |

Rekordbox keeps master.db open and overwrites it on exit, so dj-sync never
writes while it's running. It queues changes in
`~/.dj-sync/rekordbox-pending.json` and checks every `check_secs` (10 s) with
`pgrep -x rekordbox`.

## How master.db is written

- **The helper.** `rbdb.py` uses pyrekordbox 0.5.0 (which handles Rekordbox's
  SQLCipher encryption) in a managed venv at `~/.dj-sync/pyenv`. That venv is
  created with `uv` on first use. dj-sync embeds the script and rewrites
  `~/.dj-sync/rbdb.py` whenever its copy differs.
- **One batch, one transaction.** Each job queues a batch of ops:
  `add_track`, `ensure_playlist` (created in the "DJ Sync" folder),
  `add_to_playlist`, `remove_from_playlist`, `rename_playlist` and
  `delete_playlist`.
  - All pending batches are applied in one transaction. Any failure rolls
    the whole thing back.
  - Ops are idempotent: re-adding a track never duplicates it.
  - Rekordbox opening mid-write gives exit 3, and the batch stays queued.
- **Failures.** A batch that keeps failing (3 attempts) is set aside with its
  error. The menu app shows it with **Retry** and **Dismiss**, backed by
  `POST /local/rekordbox/retry` and `POST /local/rekordbox/dismiss`.
- **Backups (semver).** Every write is preceded by a copy, named
  `~/.dj-sync/rekordbox-backups/master.vX.Y.Z.db` and listed in `index.json`.
  - MAJOR: the pristine original (`1.0.0`) or an outside change.
  - MINOR: a new playlist.
  - PATCH: tracks added, removed or renamed, or a playlist deleted.

  The newest 12 are kept, and `1.0.0` is always kept.
- **Restore.** In the menu app, go to **Rekordbox library → Backups →
  Restore**, or use `POST /local/rekordbox/restore {version}`. It needs
  Rekordbox closed, and it backs up the current library first, so a restore
  can itself be undone.

## Playlist tools (ChatGPT)

The Worker answers reads from a **library snapshot** the Mac shares, so
browsing works while the Mac is offline. Writes are checked against the
snapshot and queued as **library jobs**.

| Tool | Input | Notes |
|---|---|---|
| `list_playlists` | `query?` | Name, folder, track count |
| `search_tracks` | `query?`, `artist?`, `genre?`, `bpm_min?`, `bpm_max?`, `key?`, `limit?` | Returns `track_id`s for the write tools, best match first, each with the playlists it's in. Ignores accents, case, punctuation and filler words (*by, the, feat*); forgives small typos but then says "No exact match" (`match: "close"`), and the Telegram assistant asks before changing a playlist with a close match. Index built once per snapshot (`src/search.ts`); test set in `test/search-cases.ts`. Keys are as Rekordbox shows them (`10B`, `F#m`) |
| `get_playlist` | `name` | First 200 tracks. A misspelled name suggests the closest match |
| `create_playlist` | `name`, `track_ids?` | In the DJ Sync folder. If it already exists, the tracks are added |
| `add_tracks_to_playlist` | `playlist`, `track_ids` | |
| `remove_tracks_from_playlist` | `playlist`, `track_ids` | Tracks stay in the library |
| `rename_playlist` | `name`, `new_name` | |
| `delete_playlist` | `name` | `destructiveHint`, so ChatGPT asks first. Tracks stay. Restorable from a backup |

The write tools return a `job_id`. `get_download_status` reports it as `done`
only once the change is **in master.db**, together with the library version.
Until then the job stays `running`, and the Mac keeps its lease alive. The
same change is mirrored into the import XML straight away (as `xml_version`).

### Snapshot

- **What's in it.** `rbdb.py snapshot` is read-only, so it's safe while
  Rekordbox is open. It returns `playlists[{id, name, folder, track_ids}]` and
  `tracks[{id, title, artist, album, genre, bpm, key, duration_secs, path}]`.
- **Paths stay local.** dj-sync removes `path` before uploading. It keeps
  `id → path` locally, so it can mirror library edits into the XML.
- **When it updates.** The snapshot is rebuilt when master.db's mtime changes,
  at most once a minute. The poll sends its sha256 as `library_hash`. When the
  Worker answers `library_wanted`, the Mac uploads it to `POST /agent/library`.
- **Size.** The real library (232 playlists, 12,783 tracks) is about 2.5 MB
  and takes about 5 s to build. The Worker stores it in KV (`LIBRARY`) as two
  keys, so `list_playlists` never parses the track index. Live tool calls take
  130–160 ms end to end.

### Name matching

The Worker resolves a playlist name to the snapshot's exact spelling (exact
match first, then case-insensitive) before queueing. That's because
`rbdb.py` matches exactly. Among same-named playlists, the one in the DJ Sync
folder wins, on both sides.

## Verified end to end (2026-10-28, real library)

1. ChatGPT tools via the live Worker: `search_tracks "burna"`, then
   `create_playlist "DJ Sync Tool Test"` with 2 tracks. That gave master.db
   **v1.2.0** and the playlist in the DJ Sync folder.
   - The first attempt found a bug: a lookup by ID returned the row itself,
     not a query, so `.first()` failed. It was fixed in 0.8.0 and the change
     was retried from the set-aside list.
2. `delete_playlist "DJ Sync Tool Test"`: the job finished `done` with
   *"applied to your Rekordbox library"* and library version **1.2.1**.
