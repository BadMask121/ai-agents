# 44 — Serato's library

**Status:** code on branch `dj-sync-serato` (bd `ai-agents-jff.8`), not released.
Tested on the owner's Mac against **Serato DJ Pro 5.0.0.1278**, with a spike
script for the live rounds and the Rust writer on a copy of the real library.
The Rust writer hasn't yet been loaded by a running Serato. See
[What isn't proven](#what-isnt-proven).

Same job as [doc 43](43-rekordbox-library.md): downloads and playlist edits land
in the DJ's real library. The queue, backups, restore and failure handling are
shared (`src/dj_library.rs`). Only how the library is written differs
(`src/serato.rs`).

## Why it works

Serato has no API and no official import. From version 4 its library is SQLite,
in `~/Library/Application Support/Serato/Library` (`master.sqlite`,
`root.sqlite`). It still exports the old format to `~/Music/_Serato_`:

| File | Holds |
|---|---|
| `database V2` | Every track |
| `Subcrates/<name>.crate` | One crate. `Parent%%Child.crate` nests |
| `neworder.pref` | Crate order |

At launch Serato compares each of those files with the size and MD5 it stored in
`root.sqlite`'s `last_seen_dbv2_library`. A difference logs `IMPORT_REQUIRED` and
re-imports. No difference logs `IMPORT_NOT_REQUIRED`. So DJ Sync writes those
files with Serato closed and never touches the SQLite databases.

Observed on 5.0.0, with both the log and the databases as evidence:

- **Adding:** a new crate, and a track Serato had never seen, appeared and played.
- **A track needs only `ttyp` and `pfil`.** Serato read the tags and analysed it,
  and exported 33 fields for it.
- **Import replaces a crate's contents.** Removing a track or deleting a `.crate`
  file takes effect in Serato. Tracks stay in the library.
- **A one-file change is enough.** Changing only a crate triggered the import.
- **Nesting works:** `DJ Sync%%Spike Test.crate` became a subcrate.
- **Other crates survive.** An iTunes track in a crate the write didn't touch kept
  its place, key and play count, and the file came back byte-identical.
- **Serato exports while open,** seconds after a change. Snapshots stay fairly
  fresh without waiting for a quit.

## The format

Records are a 4-byte ASCII tag, a 4-byte big-endian length, then the payload.
`o…` tags nest. Text is UTF-16BE. Paths have no leading slash and are relative to
the drive.

Every record is kept byte for byte, including ones this code doesn't know.
`neworder.pref` is one `[begin record]`/`[end record]` pair around all the
`[crate]` lines; Serato accepted one pair per crate but normalised it.

## Safety checks

`serato::preflight` runs before every write. Anything it can't confirm is a
refusal, because the import replaces what it reads. The batch is set aside with
the reason, and the menu app offers Retry and Dismiss.

| Refused when | Why |
|---|---|
| Serato isn't major version 5 | Nothing else has been tested |
| `master.sqlite`, `root.sqlite` or `database V2` is missing | Serato hasn't set up its library |
| A `-wal` file was left behind | Force quit: the database isn't the whole story |
| `dbv2_status.autosync_disabled` is set | Serato wouldn't load the change |
| A crate track's space isn't a local one (`master.sqlite`) | Streaming tracks may not survive a re-import |
| A crate's exported file is older than Serato's database | A re-import would lose the difference |
| A table or column is missing | Unrecognised schema |

The space check is an allowlist: `LOCAL_SPACES` names what's safe, so a streaming
service Serato adds later is refused, not missed.

The file comparison only applies to files whose MD5 still matches what Serato
stored. A file that differs is a DJ Sync write Serato hasn't loaded yet, so two
downloads in a row while Serato stays closed don't trip it.

SQLite is read through `/usr/bin/sqlite3` as `immutable`, because a plain
read-only open can't read a WAL database once its log files are gone. Immutable
is safe here because this only runs while Serato is closed and the WAL check has
passed.

## What the DJ gets

- **Which app:** `settings.json` `dj_app` is `rekordbox`, `serato` or `both`, set
  from a picker on Macs with both. Unset, Rekordbox wins if it's here, else
  Serato, so existing Macs don't change.
- **`both`:** downloads go into both. Assistants browse and edit Rekordbox,
  because playlist ids belong to one library.
- **Backups:** `~/.dj-sync/serato-backups/serato-library.vX.Y.Z.tar`, a tar of the
  three kinds of file. It's deterministic, so the shared semver logic in
  `xml_versions.rs` works unchanged, and a change made in Serato becomes a MAJOR.
- **Restore** puts the files back and removes crates that weren't in the backup.
  Serato loads the result at its next launch.
- **Snapshot:** crates become playlists (`id` is the file stem), and track ids are
  a hash of the full path, so paths still never leave the Mac. A crate that only
  groups others counts as a folder.
- **External drives** have their own `_Serato_` folder. They're read for browsing
  but never written, and such a write fails with a clear message.

## What isn't proven

Release is blocked on these (`ai-agents-jff.8.5`, `.8.6`):

- **The Rust writer in front of a running Serato.** The live rounds used the spike
  script. The Rust writer produced the same files on a copy of the real library,
  and its parent crate came out the same size as Serato's re-export, but no
  running Serato has loaded its output yet.
- **Crate colours and cue points across a re-import.** Cues live in file tags, so
  they should survive, but that hasn't been tested.
- **Streaming tracks in a crate.** No account to test with, so the guard refuses
  those libraries outright. The check itself was proven by planting a Tidal row
  in a copy of the real `master.sqlite`.
- **Serato 4.0.x:** refused, untested.
- **Large libraries:** the test library had 413 tracks and one real crate.
