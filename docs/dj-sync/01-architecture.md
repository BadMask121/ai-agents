# 01 — Architecture

dj-sync has three lanes that should never blur into each other:

| Lane | Component | Responsibility |
|---|---|---|
| Interface | Telegram bot | input + status reply only |
| Interface | MCP / HTTP lane (`http.rs`, `mcp.rs`) | ChatGPT tool calls + iOS Shortcut, input + job status only |
| Execution | `dj-sync` Rust core | metadata fetch, matching, file ops |
| Performance | Rekordbox | BPM / key / grid analysis, USB export |

Keeping these separate is the single most important design decision. The bot never touches files. The core never replies to chat. Rekordbox never sees Telegram.

## Process model

One Rust binary with two **optional lanes**, run concurrently by `main.rs`
(`tokio::join!`). A shared SIGINT/SIGTERM watch shuts both down:

- **Telegram lane.** Starts when `TELEGRAM_BOT_TOKEN` is set. It's described below.
- **HTTP lane.** Starts when `[mcp] enabled = true`: an axum server on
  `127.0.0.1:8000` behind a Cloudflare Tunnel. It owns the **download queue**,
  where a single worker runs spotdl / yt-dlp and is the only writer of
  `~/Music/rekordbox_import.xml`. See [40-chatgpt-mcp-design.md](40-chatgpt-mcp-design.md).

The Telegram lane has two threads of work:

- **Bot loop** (teloxide) — long-polls Telegram, parses commands, hands work to the core via an async channel. Replies with status updates.
- **Core executor** — owns the Spotify client, the local library index, and the Rekordbox import path. Single in-flight job at a time (a serial queue — DJ prep is not a high-concurrency problem).

No database in v1. State that needs to survive a restart (Spotify token cache, library index, last-seen Telegram update_id) lives in flat files under `~/.dj-sync/`.

## Module layout (Rust crate)

```
apps/dj-sync/
├── Cargo.toml
├── src/
│   ├── main.rs           # binary entrypoint, wires bot + core
│   ├── bot.rs            # teloxide handlers, command enum, auth gate
│   ├── parser.rs         # extract { action, url } from a message
│   ├── nlu.rs            # optional Claude fallback for free-form text
│   ├── spotify.rs        # auth + playlist/track metadata fetch
│   ├── library.rs        # local file index (artist/title/ISRC → path)
│   ├── matcher.rs        # ISRC → fuzzy → AI ladder
│   ├── rekordbox.rs      # AutoImport folder writes
│   ├── usb.rs            # optional USB drive sync
│   ├── config.rs         # env + ~/.dj-sync/config.toml loader ([mcp], [download] too)
│   ├── rekordbox_xml.rs  # read-only parser for Rekordbox's own XML export (browser)
│   ├── http.rs           # HTTP lane: /health, /<secret>/mcp, /api/downloads
│   ├── mcp.rs            # MCP JSON-RPC dispatch + the two tools
│   ├── jobs.rs           # download queue + single worker
│   ├── downloader.rs     # spotdl / yt-dlp child processes
│   └── import_xml.rs     # writable rekordbox_import.xml (non-destructive upsert)
└── tests/
    └── matcher_test.rs   # golden test for the matching ladder
```

Every module above is a leaf — no module imports a sibling except via small, named types in `lib.rs`. This is what keeps the lanes from blurring.

## Data shapes (the only ones that matter)

```rust
struct SpotifyTrack {
    isrc: Option<String>,      // primary match key
    artist: String,
    title: String,
    album: String,
    duration_ms: u32,
    spotify_id: String,        // for buy-list deep links
}

struct LocalTrack {
    path: PathBuf,
    isrc: Option<String>,      // from ID3 TSRC / Vorbis ISRC
    artist: String,
    title: String,
    duration_ms: Option<u32>,
}

enum MatchResult {
    Hit { local: LocalTrack, confidence: Confidence },
    Miss { spotify: SpotifyTrack, reason: MissReason },
}

enum Confidence { Isrc, FuzzyHigh, FuzzyLow, AiAssisted }
enum MissReason  { NotInLibrary, AmbiguousFuzzy, AiUncertain }
```

The matcher returns `Vec<MatchResult>`; everything downstream (Rekordbox writer, buy-list builder, status reporter) reads that single type. No other module invents its own track type.

## Matching ladder

Each track walks the ladder until one rung lands a hit:

1. **ISRC exact** — Spotify gives us an ISRC; we check the local index. Deterministic, near-zero false positives.
2. **Fuzzy (artist + title)** — normalized Levenshtein on `artist|title` against the index, accept above a threshold (~0.92). Catches the common case where local files are tagged before ISRCs were standard.
3. **AI fallback** — Claude Haiku is given the Spotify track and the top-5 fuzzy candidates and asked to pick or decline. Bounded: only runs on tracks the first two rungs already failed, capped at N per playlist (default 20) to keep cost predictable.

Anything that falls off the ladder becomes a `Miss { reason: NotInLibrary }` and shows up in the buy-list.

## Storage on disk

```
~/.dj-sync/
├── config.toml           # paths, thresholds, feature flags
├── .env                  # secrets (loaded before ./.env, so launchd works)
├── spotify-token.json    # refresh token cache
├── library.index.bin     # serialized library index (rebuilt on /scan)
├── state.json            # last_update_id, last_run_at
└── logs/
    └── dj-sync.log       # rolling
```

Rekordbox's AutoImport folder is configured separately inside Rekordbox itself; dj-sync just writes files into the path you point it at via `config.toml`.

## What the bot can and cannot see

The bot only sees:
- the user's Telegram ID (gate),
- the message text,
- the parsed command and its result summary.

The bot does NOT see:
- file paths on disk,
- Spotify access tokens,
- the Anthropic API key.

These live in the core process's env / config and never cross into a Telegram message body. If a future feature wants to expose a path, that's a deliberate change — not an accident.

## Failure model

- **Spotify 5xx / token expiry** — retry with backoff, surface "spotify hiccup, try again" to the bot if it persists past 30s.
- **Library index stale** — `/scan` rebuilds it; bot can also auto-trigger a rescan if a sync produces > 50% misses, since that usually means new music wasn't indexed.
- **Rekordbox not running** — files still land in AutoImport; Rekordbox picks them up when it next launches. dj-sync does not try to control Rekordbox.
- **USB not mounted** — USB sync step is skipped with a warning in the reply; the matched-tracks-in-Rekordbox outcome still succeeds.

The system is designed so a partial failure still leaves the user with something useful (matched tracks in Rekordbox even if USB is missing; a buy-list even if the matcher gave up early).
