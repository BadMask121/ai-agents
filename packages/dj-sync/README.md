# dj-sync

Telegram-driven Spotify → Rekordbox prep pipeline. See `docs/dj-sync/` for design.

## First run

```bash
cd packages/dj-sync
cp .env.example .env            # fill in tokens
mkdir -p ~/.dj-sync
cp config.example.toml ~/.dj-sync/config.toml   # edit paths
cargo run
```

## Deps

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `DJ_SYNC_ALLOWED_USER_IDS` — comma-separated Telegram user IDs (your own); empty allows all
- `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` — from developer.spotify.com
- `ANTHROPIC_API_KEY` — optional, enables AI-rung matcher fallback and free-text NLU

`~/.dj-sync/config.toml`:
- `library.roots` — where audio files live (recursively scanned)
- `rekordbox.autoimport_dir` — Rekordbox AutoImport folder (must exist)
- `usb.mount` — optional USB drive path (skipped if unset)

## Tests

```bash
cargo test
```

Tests cover URL parsing and the matching ladder (ISRC priority, fuzzy, miss). The bot/Spotify/Rekordbox layers are integration paths exercised at runtime.
