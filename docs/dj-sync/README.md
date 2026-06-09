# dj-sync — Telegram-driven Spotify → Rekordbox pipeline

A personal DJ-prep agent. You paste a Spotify playlist URL into a Telegram chat from your phone; a Rust service running on your laptop (or VPS) fetches metadata, matches each track against your local music library, drops matches into Rekordbox's AutoImport folder, and (optionally) syncs the resulting crate to a USB drive ready for a CDJ.

**Target host:** your DJ laptop (macOS) where Rekordbox already runs. A small Rust binary stays resident; Telegram is the only inbound surface. No always-on server required for v1.

## What this gives you

- Paste-from-anywhere ingestion — Spotify playlist URL → Telegram → ready-to-play crate
- Deterministic Rust core (no fragile scrapers, no audio downloading)
- Local-library matching by ISRC first, fuzzy artist/title second, AI fallback last
- Missing-track buy-list returned to chat, so you know what to grab on Beatport / Bandcamp
- Rekordbox AutoImport handles BPM / key / beatgrid analysis automatically
- Optional USB sync step so you can walk out the door with a prepared drive
- Optional Claude NLU layer for natural-language commands ("sync this", "what's missing from my house set")

## Reality check (read first)

**dj-sync does not download audio from Spotify.** Spotify's terms forbid it and the Web API only exposes metadata (titles, artists, ISRCs, durations). The matching engine assumes you already own — or are willing to buy — the audio files. The output of a sync is "matched against your library + a shopping list for the rest." If you expected a one-shot Spotify-to-USB ripper, this is not that tool.

**Rekordbox is the analysis layer.** dj-sync does not compute BPM, key, or beatgrids. It drops files into Rekordbox's configured AutoImport folder; Rekordbox handles analysis on its own schedule the next time it runs. You still own the performance-side workflow (cue points, hot cues, memory cues) inside Rekordbox itself.

**The Telegram bot is single-tenant.** It is locked to your own Telegram user ID at the bot level — anyone else who finds the bot handle gets ignored. Do not share the bot username in public.

**No auto-purchase.** The missing-track list is a list. You buy tracks yourself.

## Prerequisites

- macOS laptop with Rekordbox 6 or 7 installed and an AutoImport folder configured
- A local music library (folder of `.mp3` / `.flac` / `.aac` / `.wav` / `.aiff`) tagged well enough that artist + title + ISRC are mostly correct
- Rust toolchain (`rustup`, stable channel)
- Spotify developer app (free) — Client ID + Client Secret for the Web API
- Telegram account + a bot created via @BotFather (free)
- Anthropic API key (optional, only if you want the natural-language command parser)
- ~2 hours for first-time setup

### If you want phone access from outside your home network

The Telegram bot itself is reachable from anywhere — Telegram's servers relay messages to your laptop, no inbound port needed. Tailscale is only required if you also want the bot to read from a NAS or a different machine on your home network. For a single-laptop setup, skip Tailscale.

## Guide order

Follow these in sequence. Each file is short and focused.

1. [01-architecture.md](01-architecture.md) — the components and how they fit together
2. [02-flow.md](02-flow.md) — message-level + network-level flow diagrams
3. [03-stack-decisions.md](03-stack-decisions.md) — why Rust + teloxide, where AI does and does not belong
4. [04-spotify-integration.md](04-spotify-integration.md) — _(deferred)_ developer app, scopes, ISRC fetch
5. [05-matching-engine.md](05-matching-engine.md) — _(deferred)_ ISRC → fuzzy → AI fallback ladder
6. [06-rekordbox-pipeline.md](06-rekordbox-pipeline.md) — _(deferred)_ AutoImport folder, analysis, USB sync
7. [07-bot-commands.md](07-bot-commands.md) — _(deferred)_ `/sync`, `/scan`, NLU parser
8. [20-roadmap.md](20-roadmap.md) — _(deferred)_ designed-but-not-yet-built features

Files marked _(deferred)_ are placeholders — the architecture is locked in `01` / `02` / `03`; the per-component docs land as we build each module.

## Where the code will live

`apps/dj-sync/` (workspace package, Rust). Sibling to existing `apps/career-ops-ui/` and `apps/sample-agent/`. The `pnpm` workspace ignores Rust crates, so this stays out of the JS dependency graph.

## Out of scope

- Spotify audio extraction (forbidden, not negotiable)
- Beatport / Bandcamp auto-purchase (no public API allows it; manual)
- Real-time DJ control (this is a prep tool, not a performance tool)
- Multi-user / shared playlists (single-tenant by design)
- Web UI (Telegram is the entire interface — adding a UI doubles the surface area for no real-world gain)
