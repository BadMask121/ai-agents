# 30 — Rekordbox browser (design)

**Status:** drafted 2026-04-30, awaiting user review.
**Pivot from:** Spotify→Rekordbox sync (parked due to Spotify Web API restrictions on new dev apps — see `03-stack-decisions.md` for the original sync direction).

## Goal

From Telegram on my phone, browse my Rekordbox library:

- See all playlists, preserving the **folder hierarchy** I've set up in Rekordbox.
- Open any playlist and see its tracks.
- For each track, show: **file name, track name, artist, BPM, key.**

That's it. No cover art. No search in Phase 1. No sync direction in Phase 1.

## Non-goals

- No SQLCipher decryption of `master.db` (avoids reverse-engineering Pioneer's key scheme; brittle across versions).
- No Spotify integration (parked but not deleted — modules stay in source tree).
- No web UI. Telegram is still the only interface (per `03-stack-decisions.md`).
- No write-back into Rekordbox. Read-only.
- No cover art rendering.
- No fuzzy search (Phase 2).

## Data source: Rekordbox XML auto-export

Rekordbox has a first-party feature: **Preferences → Advanced → Database → "rekordbox xml"** with an *Auto-Export* toggle. When enabled, Rekordbox writes a `rekordbox.xml` file at a configurable path on every collection change.

**Why this beats decrypting `master.db`:**

- Pioneer-supported, stable across Rekordbox versions.
- Always fresh — Rekordbox re-writes on changes.
- No SQLCipher key derivation, no encryption headaches.
- Plain XML; trivial to parse.
- Contains everything we need: full track metadata + playlist tree (including folders).

**Setup the user does once:**

1. Open Rekordbox → Preferences → Advanced → Database → "rekordbox xml" section.
2. Set the export path (recommend `~/Music/rekordbox.xml`).
3. Toggle **Auto-export** ON.
4. Save preferences. Rekordbox writes the file on next collection change (or immediately on save, depending on version).
5. Add `xml_path = "/Users/jeffreysmith/Music/rekordbox.xml"` to `~/.dj-sync/config.toml` (new field).

If at any point Pioneer breaks the auto-export feature, the fallback is **manual export** via File → Export Collection → in xml format. The bot doesn't care which path produced the file.

## XML schema (relevant subset)

```xml
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="1234">
    <TRACK TrackID="42" Name="Back Outside" Artist="BNXN" Album="..."
           AverageBpm="124.00" Tonality="Am" Location="file://localhost/Users/.../01_back_outside.mp3"
           ... />
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="..."> <!-- Type=0 means folder -->
      <NODE Type="0" Name="House Sets">
        <NODE Type="1" Name="Saturday Night" Entries="42"> <!-- Type=1 means playlist -->
          <TRACK Key="42"/>
          ...
        </NODE>
      </NODE>
      <NODE Type="1" Name="Wedding Reception" Entries="...">...</NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
```

`Type="0"` = folder, `Type="1"` = playlist. Playlists hold `<TRACK Key="...">` references that point at `<TRACK TrackID="...">` in the collection.

## New module: `src/rekordbox_xml.rs`

```rust
pub struct RekordboxLib {
    tracks: HashMap<TrackId, Track>,
    root: PlaylistNode,
    loaded_from: PathBuf,
    loaded_at: SystemTime,
}

pub struct Track {
    pub file_name: String,   // basename of Location
    pub name: String,        // <TRACK Name=>
    pub artist: String,      // <TRACK Artist=>
    pub bpm: Option<f32>,    // AverageBpm
    pub key: Option<String>, // Tonality (e.g. "Am", "8B" Camelot)
    pub path: PathBuf,       // decoded file:// URL
}

pub enum PlaylistNode {
    Folder { name: String, children: Vec<PlaylistNode> },
    Playlist { name: String, tracks: Vec<TrackId> },
}

impl RekordboxLib {
    pub fn load(xml_path: &Path) -> anyhow::Result<Self> { ... }
    pub fn reload_if_changed(&mut self) -> anyhow::Result<bool> { ... } // mtime check
    pub fn flatten_for_listing(&self) -> Vec<ListingEntry> { ... }      // numbered
    pub fn playlist_by_number(&self, n: usize) -> Option<&PlaylistNode> { ... }
    pub fn playlist_by_name(&self, name: &str) -> Option<&PlaylistNode> { ... }
    pub fn track(&self, id: TrackId) -> Option<&Track> { ... }
}
```

**Parser:** `quick-xml` with the `serialize` feature, deserialize into `serde`-derived structs that mirror the XML.

**Reload strategy:** on every command, check `xml_path.metadata()?.modified()`. If newer than `loaded_at`, reload. Cheap (one stat call per command). No file-watcher needed.

## New bot commands

| Command | Behavior |
|---|---|
| `/playlists` | tree-flattened, globally numbered list. Folders shown with trailing `/` and indented children. |
| `/playlist <n>` | tracks in playlist number `n`. Long lists chunked across messages. |
| `/playlist <name>` | same, but case-insensitive name match. |
| `/lib` | quick stats: track count, playlist count, last reload time. |

The existing `/sync`, `/scan`, `/missing` commands stay in `Command` but `/sync` returns "Spotify sync paused — see issue X." `/scan` and `/missing` continue to work as-is for the local library indexer (still useful for the parked sync direction's revival).

### Output format — `/playlists`

```
PLAYLISTS

House Sets/
  1. Saturday Night
  2. Boiler Room Mix
Techno/
  Underground/
    3. Berghain Vibes
  4. Detroit Roots
5. Wedding Reception
6. Cooldown

→ /playlist <number>
```

Globally numbered so `/playlist 3` works regardless of folder depth. Folders shown with `/` suffix and indented children. Two-space indent per level.

### Output format — `/playlist <n>`

```
🎧 Saturday Night — 42 tracks

1. 01_back_outside.mp3
   BNXN — Back Outside
   124 BPM · Am

2. 02_essence.mp3
   Wizkid feat. Tems — Essence
   108 BPM · F#m
   ...
```

- File name (basename), then artist — title, then `BPM · key` on its own line.
- Three lines per track. Blank line between tracks.
- Telegram caps at 4096 chars per message. Chunk at ~3500 to be safe; the bot sends multiple messages with a "(part N/M)" marker.

### Output format — `/lib`

```
1,234 tracks · 56 playlists · 12 folders
xml: ~/Music/rekordbox.xml
loaded 3 min ago
```

## Wiring into the existing bot

`src/bot.rs`:
- Add `Playlists`, `Playlist(String)`, `Lib` variants to the `Command` enum.
- Add corresponding `JobKind` variants.
- The `executor::run` loop dispatches to new handlers in `src/rekordbox_xml.rs`.
- Pass an `Arc<Mutex<RekordboxLib>>` into the executor (parallel to the existing `Arc<Mutex<LibraryIndex>>`).

`src/main.rs`:
- Load `RekordboxLib` on startup; warn but don't fail if `xml_path` is missing (so the bot still works for testing the library-stub path).

`src/config.rs`:
- New optional field: `rekordbox.xml_path: Option<PathBuf>`. If `None`, the new commands return "rekordbox.xml not configured — see docs/dj-sync/30-rekordbox-browser-design.md".

## Module diagram (after this lands)

```
bot.rs ──▶ rekordbox_xml.rs ──▶ parses ~/Music/rekordbox.xml
   │
   ├─▶ library.rs       (still indexes local audio files, unchanged)
   ├─▶ matcher.rs       (parked path, still compiles)
   ├─▶ rekordbox.rs     (parked path: AutoImport writer, still compiles)
   └─▶ spotify.rs       (parked path, still compiles)
```

The Spotify modules continue to compile and live in source. They're just not reachable from any command. Reviving them is a one-line dispatch change in `bot.rs` if Spotify ever fixes new-app access or the user gets quota-extension approval.

## Testing

- **Unit:** parser test against a hand-crafted minimal `rekordbox.xml` fixture in `tests/fixtures/`. Cover: nested folders, empty playlist, missing BPM/key, unicode track names.
- **Integration:** `tests/rekordbox_xml_test.rs` walks fixture → flattens → asserts numbering and renders.
- No live Rekordbox dependency in CI. Real XML is only exercised at runtime.

## Phases

| Phase | Scope | Estimate |
|---|---|---|
| **1** | XML parser, `/playlists`, `/playlist <n|name>`, `/lib`, mtime reload | ~3h |
| **2** *(deferred)* | `/track <query>` fuzzy search across all tracks | ~1h |
| **3** *(deferred)* | If Pioneer drops auto-export, port pyrekordbox key derivation to read `master.db` directly | ~1d |

This spec covers Phase 1 only. Phases 2 and 3 are noted for the roadmap but not in scope here.

## Risks & open questions

- **Rekordbox 7's XML schema:** I described the v6 schema above (which has been stable since v5). v7 is reportedly compatible — I'll verify against the user's actual export when we have one. If a tag has changed, parser tweaks are quick.
- **`Tonality` format:** Rekordbox lets you display key as classical notation (`Am`, `F#m`) or Camelot (`8B`, `4A`). Whichever the user has configured is what shows up in the XML. The bot just passes it through.
- **Numbering stability:** if the user reorders playlists in Rekordbox, the numbers in `/playlists` change. Acceptable — they re-issue `/playlists` to get a fresh numbering. Name-based lookup (`/playlist Saturday Night`) provides the stable alternative.
- **Library size:** for 10k+ track libraries, the XML can be ~10–30 MB. Parsing it on every reload is fine (~100ms with quick-xml). If users complain, we cache a parsed snapshot.

## Out of scope (explicit)

- Editing playlists from the bot.
- Streaming track previews.
- Calling Rekordbox to load tracks onto a deck.
- Cover art.
- Fuzzy search (Phase 2).
- USB sync (parked).
