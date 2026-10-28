# dj-sync

Spotify / YouTube → Rekordbox prep for a DJ laptop. One Rust binary with two
optional lanes:

- **Telegram bot.** It matches Spotify playlists against your local library
  (ISRC → fuzzy → AI) and browses your Rekordbox XML. It starts when
  `TELEGRAM_BOT_TOKEN` is set.
- **ChatGPT MCP download lane.** An MCP server that ChatGPT calls with Spotify or
  YouTube links. It downloads them with spotdl / yt-dlp into `~/Music/DJ_Downloads`
  and adds them to `~/Music/rekordbox_import.xml` for Rekordbox's *rekordbox xml*
  pane. It starts when `[mcp] enabled = true` is set. An optional bearer REST
  route serves an iOS Share Sheet shortcut.

See [`docs/dj-sync/`](../../docs/dj-sync/) for the design. The MCP lane is covered
in [`40-chatgpt-mcp-design.md`](../../docs/dj-sync/40-chatgpt-mcp-design.md) and
[`41-chatgpt-mcp-setup.md`](../../docs/dj-sync/41-chatgpt-mcp-setup.md). The second
doc covers spotdl, Cloudflare Tunnel, launchd, Rekordbox and ChatGPT step by step.

## First run

```bash
cd apps/dj-sync
mkdir -p ~/.dj-sync
cp .env.example ~/.dj-sync/.env                  # fill in what you use; chmod 600
cp config.example.toml ~/.dj-sync/config.toml    # edit paths
cargo run
```

`~/.dj-sync/.env` is loaded first, then `./.env`, so the binary also works
when it's started from launchd.

## Config

- **`~/.dj-sync/.env`**
  - `TELEGRAM_BOT_TOKEN`, `DJ_SYNC_ALLOWED_USER_IDS`: bot lane (empty = off).
  - `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`: bot lane. spotdl uses them
    only with `spotdl_use_official_api = true`.
  - `ANTHROPIC_API_KEY`: optional AI matcher rung and NLU.
  - `MCP_SECRET_PATH`: required for the MCP lane. ChatGPT connects to
    `https://<host>/<MCP_SECRET_PATH>/mcp`.
  - `SHORTCUT_API_KEY`: optional; turns on `POST /api/downloads` for the iOS
    Shortcut.
- **`~/.dj-sync/config.toml`**
  - `library.roots`: where the matcher looks for audio. Add
    `~/Music/DJ_Downloads` so `/sync` sees downloaded tracks.
  - `rekordbox.autoimport_dir`, `rekordbox.xml_path`: used by the bot.
  - `usb.mount`: optional USB sync for the bot.
  - `[mcp]` and `[download]`: the download lane. Every key has a default; see
    `config.example.toml`.

## Layout

```
src/
├── main.rs           # loads .env + config, runs the bot and HTTP lanes, SIGINT/SIGTERM shutdown
├── lib.rs            # shared types, Rekordbox Location encode/decode, unique_name
├── bot.rs …          # Telegram lane (bot, matcher, library, spotify, rekordbox, usb, nlu)
├── rekordbox_xml.rs  # read-only parser for Rekordbox's own XML export (bot browser)
├── http.rs           # axum: /health, /<secret>/mcp, /api/downloads
├── mcp.rs            # JSON-RPC dispatch + the two MCP tools
├── jobs.rs           # download queue: single worker, staging → DJ_Downloads → XML
├── downloader.rs     # spotdl / yt-dlp child processes (argv only, timeout, output tail)
├── parser.rs         # link parsing, incl. the download allowlist / canonicaliser
└── import_xml.rs     # writable rekordbox_import.xml model (non-destructive upsert)
deploy/
├── com.triplejmusic.dj-sync.plist       # LaunchAgent template
├── cloudflared-config.example.yml       # tunnel ingress → 127.0.0.1:8000
└── send-to-rekordbox-shortcut.md        # iOS Shortcut recipe
```

## Tests

```bash
cargo test
cargo clippy --all-targets
cargo fmt --check
# Opt-in: check every Location in a real Rekordbox export round-trips byte-for-byte
DJ_SYNC_REAL_XML=~/path/to/rekordbox.xml cargo test --test location_roundtrip -- --ignored
```

What the tests cover:

- **Unit tests**: URL parsing and the download allowlist, the matching ladder,
  XML read and write, Location encoding, and config.
- **Downloader**: argv building, plus child-process timeouts and errors.
- **Job queue**: driven by a fake fetcher and a fixture MP3.
- **MCP dispatch**.
- **Router tests**: the HTTP routes, the secret path, the Origin guard and bearer auth.

The live Telegram, Spotify and spotdl / yt-dlp paths only run at runtime.
