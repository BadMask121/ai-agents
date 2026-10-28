# Changelog

All notable changes to the DJ Sync website. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-10-28
### Worker
- **New cloud routes forwarded** to dj-sync-cloud: `/telegram/*` (the shared
  bot's webhook) and `/api/playlists` (the iPhone Shortcut's playlist list).
  `/v2/admin/telegram/setup` already goes through the `/v2/` prefix.

### Pages
- **Setup guides for every way to connect:**
  - **New** `/connect/telegram/` (free, any phone: QR pairing, sending links,
    playlist buttons, commands).
  - **New** `/connect/iphone/` (free: a Share-sheet Shortcut that lists your
    playlists from `/api/playlists` and posts to `/api/downloads`).
  - **`/connect/chatgpt/`** now leads with **ChatGPT needs a paid plan**
    (Plus, Pro, Business, Enterprise or Edu) for custom connectors, and gains
    "After DJ Sync updates, refresh the connector".
  - **`/connect/claude/`** says the free plan includes one custom connector,
    and covers phone use.
- **Home:** a "Works with" section with Telegram (free), Claude (free), iPhone
  Shortcut (free) and ChatGPT (paid plan). The copy now names every channel.
- **Navigation:** the header and footer link all four guides. The header's
  guide links show from 900px; below that, home and the footer carry them.
- **FAQ:** "Which way should I connect?" and "Why doesn't ChatGPT see my
  playlists?", plus updated cost, offline and leaked-link answers.
- **Privacy:** what the Telegram bot stores (chat ID, username, first name,
  the chat → Mac mapping, pending picks for 24 hours, and which chat to
  notify), and that phone numbers are never stored.
- **Install:** the "connect" step lists all four options.
- `sitemap.xml` includes the two new pages.

## [1.1.0] — 2026-10-28
### Changed
- **The site moved to djsync.jeffrey.build,** which is now DJ Sync's one host.
  - `src/worker.mjs` (with `run_worker_first`) serves the pages.
  - `/download/<file>` comes from R2 (`dj-sync-downloads`, key `djsync/<file>`), with HEAD and byte ranges.
  - Cloud paths (`/health`, `/v2/*`, `/api/downloads*`, `/agent/*`, `…/mcp`) are passed to `dj-sync-cloud` over a service binding.
- **djsync.triplejmusic.art is routed here and 301s** to the same path on the new host.
- **Page links:** canonical/OG/sitemap URLs, the Download button and the connector examples use the new host.
### Added
- `test/worker.test.mjs` (`node --test apps/dj-sync-site/test/*.test.mjs`).

## [1.0.1] — 2026-10-28
### Added
- **Support contact jeff.emakpor@gmail.com** (spec §8). It appears in every
  page's "Need help?" line and as plain text in the Privacy (Questions) and
  Terms (Contact) pages.

## [1.0.0] — 2026-10-28

### Added
- **Pages:** home, install, connect ChatGPT, connect Claude, FAQ, privacy,
  terms and 404.
- **Install guide:** illustrated SVG mock-ups of the one-time "Open Anyway"
  step. They're our own drawings, not screenshots.
- **Design:** dark first, with light mode via `prefers-color-scheme`. Works
  on phones, with no horizontal overflow at 375px. Press feedback, hover
  only on fine pointers, and `prefers-reduced-motion` is respected.
- **No tracking:** no cookies, analytics or third-party scripts or fonts.
  The CSP is strict (`default-src 'none'`, self-hosted styles and the one
  script).
- **Hosting:**
  - the site on Cloudflare Workers static assets at
    `djsync.triplejmusic.art`
  - the R2 bucket `dj-sync-downloads` at `downloads.triplejmusic.art`
- **Support contact:** one constant (`SUPPORT_CONTACT`), hidden until the
  owner sets it.
