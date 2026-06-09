# 03 — Stack decisions

Locked-in choices and why. If you want to change one of these, this is the doc to amend first.

## Rust over Node / Python / Go

- **Rust** for the core because the work is file-heavy, latency-sensitive, and lives next to a 100k-track library on disk. Tag parsing (`lofty`), fuzzy matching (`strsim`), and HTTP (`reqwest`) are all mature. Single static binary on macOS — no runtime to manage.
- **Not Node** — you already run a TS workspace (`career-ops-ui`). Sharing the workspace would tempt sharing types and that drags Telegram into the JS deps. The whole point is isolation.
- **Not Python** — fine for prototyping, but library indexing over tens of thousands of files wants compiled speed and a real type system.
- **Not Go** — also fine, but `teloxide` is the single nicest Telegram-bot library across all three ecosystems and it's Rust.

## teloxide for the bot

- Mature, async, dialogue-state machine built in.
- Long-polling out of the box; no webhook / TLS / public hostname needed for v1.
- Idiomatic command parsing via `#[derive(BotCommands)]` — `/sync`, `/scan`, `/missing` become a typed enum.
- Trivial to bolt on a "free text" handler that defers to the NLU module when the message doesn't match a `/command`.

## Claude is OPTIONAL, never load-bearing

The matching ladder works without any LLM. AI assist is a **third-rung fallback** with a per-playlist budget cap. The NLU parser is **only** invoked when the message doesn't parse as a `/command`.

This is a hard rule because:
- The first two rungs (ISRC + fuzzy) catch ~95% of well-tagged libraries; paying an LLM tax on every track is wasteful.
- Latency: ISRC match is microseconds, an LLM call is hundreds of ms. A 50-track playlist staying under a second matters for the "paste and forget" UX.
- Reliability: the system must keep working when the Anthropic API is down or the user's key is missing.

Concretely:
- `ANTHROPIC_API_KEY` unset → AI rung is skipped, NLU is disabled, free-text messages get a "use /sync URL" hint.
- `ANTHROPIC_API_KEY` set → AI rung runs on misses up to the configured budget; NLU parses free-text into commands.

## Haiku, not Sonnet, for the AI rung

The AI rung's job is "given a Spotify track and 5 candidate local files, pick one or decline." That's a small, structured classification task — Haiku is plenty, ~10x cheaper, and faster. Reserve Sonnet/Opus for tasks where reasoning quality moves the needle. This one doesn't.

The NLU parser is also Haiku for the same reason: parsing "sync this please" → `{action: sync}` is not a hard problem.

## No database in v1

Every piece of persistent state fits in 4 flat files (see `01-architecture.md`). A SQLite would be premature — the access patterns are "load on boot, write on shutdown," not "query." Add one when there's a feature that actually needs it (history view, playlist diff over time).

## Long-poll, not webhooks

- Webhooks need a public HTTPS endpoint with a real cert. That means either a tunnel (`ngrok`, `cloudflared`) or a VPS hop. Both are extra moving parts.
- Long-polling works behind any NAT, any firewall, any coffee-shop wifi. The bot just makes outbound HTTPS requests to Telegram.
- Latency cost is ~0–2s per message — invisible for a job that takes 10–60s end-to-end.

Revisit this only if a future feature needs sub-second user→bot reaction time, which DJ prep does not.

## Single-tenant by design

- Bot enforces a hardcoded allow-list of Telegram user IDs (typically just yours).
- No "share this playlist with a friend" feature. If that becomes interesting, fork the binary — don't add multi-tenant code paths to the v1.
- This keeps the security surface tiny: there is no "permission" concept to get wrong.

## macOS-first, Linux-secondary

- Rekordbox runs on macOS and Windows, not Linux. The tool needs to deposit files into Rekordbox's AutoImport folder, which means it needs to run where Rekordbox runs (or at least where that folder is writable, e.g., a shared volume).
- The Rust core itself is portable; only the Rekordbox path and the USB-detection bits are platform-specific.
- We will write macOS first, leave Windows shims as `cfg(target_os = "windows")` stubs that bail with a "not yet" message, and not pretend Linux is a goal.

## Workspace placement: `apps/dj-sync/`

Sibling to `apps/career-ops-ui/` and `apps/sample-agent/`. The `pnpm-workspace.yaml` does not pull Rust crates into the JS install graph, so this is free real estate. The Rust crate brings its own `Cargo.toml` and `target/`; nothing to wire into `turbo.json`.

If we later want a TS-side helper (e.g., a tray icon app), it lives in `apps/dj-sync-ui/` and stays a thin wrapper that shells out to the Rust binary.

## Things explicitly NOT chosen

- **Tauri / Electron desktop app** — we have Telegram, that IS the UI. A desktop window is a second surface to maintain for no clear win.
- **A queue / worker like Sidekiq** — one job at a time, in-process channel, done.
- **OAuth for Spotify** — the Web API's Client Credentials flow is enough for public playlist reads. User OAuth would add a callback server and a token-refresh flow that earns nothing for v1. (Add it the day we want to read a private "Liked Songs" library.)
- **Beatport API integration** — Beatport's API is partner-only; there is no public path. Buy-list stays as deep links the user opens manually.
