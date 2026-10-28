# Changelog

All notable changes to the DJ Sync website. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.3] — 2026-10-28
### Pages
- **FAQ "How do I remove DJ Sync?"** now points to About → Uninstall DJ
  Sync…, says what stays (music, the Rekordbox library, backups in Music › DJ
  Sync Backups), and gives `~/.dj-sync/bin/dj-sync uninstall` for anyone who
  already dragged the app to the Bin.
- **Privacy:** uninstalling deletes the Mac's cloud data straight away, as
  well as after 90 days without use.

## [1.2.2] — 2026-10-28
### Release
- **The site follows the app's version.**
  - **Version:** `tools/seo.py` reads `apps/dj-sync/macos/VERSION` instead of
    a hard-coded string, so `softwareVersion` is now 1.2.1. It had been stuck
    at 1.2.0.
  - **`deploy.sh`:** stamps the pages, runs the tests, deploys, and checks
    that the live home page advertises the version.
  - **`apps/dj-sync/release.sh`:** runs it, so one release ships the app and
    the website together.
### Downloads
- **Download links name the release.** They point at `DJ-Sync-1.2.1.dmg`
  instead of `DJ-Sync-latest.dmg`, so the file you save carries its version.
  - **Where:** every Download button, the structured data's `downloadUrl` and
    `llms.txt`.
  - **Restamped every release** by `tools/seo.py`.
- **`/download/DJ-Sync-latest.dmg` redirects** (302) to the released version's
  file, so old links and the app's link save it versioned too.
  - **Version source:** the update feed (`djsync/appcast.json`).
  - **If the feed can't be read,** the old copy is served as before.
  - **Kept in R2:** apps that use the old downloads host fetch it there
    directly.
- **`deploy.sh` checks the version is released.** It refuses to deploy until
  `DJ-Sync-<version>.dmg` exists, since the pages link to it. Afterwards it
  checks the live download link and the redirect.
### Pages
- **Each connect guide has an illustration** (hand-drawn inline SVG, light/dark
  aware, same style as the install guide): Telegram shows QR pairing and the
  bot's Start button, Claude the Add custom connector dialog, iPhone the Share
  sheet and playlist picker, ChatGPT the custom connector form.
### SEO
- **HowTo steps no longer absorb illustration text.** `tools/seo.py` skips
  `figure` subtrees when building step bodies, and the install guide's
  regenerated JSON-LD is clean.

## [1.2.1] — 2026-10-28
### Pages
- **`/connect/iphone/` is now three steps.** Scan the QR code in DJ Sync →
  Assistants → Connect iPhone, tap Add Shortcut, then Share → DJ Sync from
  Spotify or YouTube.
  - **iCloud:** the page notes that the Mac must be signed into iCloud,
    because macOS signs the Shortcut.
  - **Building it by hand** moves under "Advanced: build it yourself". It now
    uses the `names` list and the `{text, playlist_name}` body, and shows the
    server's `message`.
### SEO
- **Every page has a unique, keyword-first title** (at most 55 characters)
  and **meta description** (at most 144). The head also gets `robots`
  (`noindex` on the 404 page), canonical URLs, Open Graph and Twitter
  `summary_large_image` tags.
- **Designed 1200×630 share cards** in `og/`: home, install, faq, the four
  connect guides, and a default for privacy, terms and 404.
- **Icons:** `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`,
  `icon-192.png`, `icon-512.png` and `site.webmanifest`, linked from every
  page.
- **JSON-LD:**
  - home: Organization, WebSite and a free SoftwareApplication
  - faq: FAQPage, built from the page's own questions and answers
  - install and the connect guides: HowTo, built from their own steps
  - every subpage: BreadcrumbList
- **Crawling:**
  - `robots.txt` welcomes search and AI crawlers, keeps API, install and
    download endpoints out, and points to the sitemap.
  - `sitemap.xml` gains `<lastmod>` and image entries.
  - `llms.txt` is new.
  - `_headers` gives cards and icons a one-week cache.

### Worker
- **Opening the Shortcut API in a browser** (`GET /api/downloads` or
  `/api/playlists` with `Accept: text/html` and no `Authorization`) now
  redirects (302) to `/connect/iphone/` instead of showing a JSON 401. The
  Shortcut and other API clients are unchanged.
- **New cloud route forwarded:** `/i/*`, the one-scan iPhone install page
  and file (connect-anywhere spec §2b).

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
