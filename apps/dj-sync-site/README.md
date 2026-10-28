# dj-sync-site

The public DJ Sync website: <https://djsync.jeffrey.build>.

Spec: `docs/superpowers/specs/2026-10-28-dj-sync-public-distribution-design.md` §4, and the connect-anywhere addendum (`2026-10-28-dj-sync-connect-anywhere-design.md` §5) for the guides.

## What it is

- **Static files only**: plain HTML and CSS, plus one tiny script. There's no
  framework, no build step, no cookies and no analytics, and no third-party
  scripts or fonts.
- **Hosting**: a Cloudflare Worker with static assets (`wrangler.jsonc`,
  `src/worker.mjs`) on `djsync.jeffrey.build`, DJ Sync's one public host. This
  stands in for "Cloudflare Pages" in the spec: equivalent, free, and deployable
  from the CLI.
  - **Pages:** static files in `public/`.
  - **Downloads:** `/download/<file>` comes from the R2 bucket
    `dj-sync-downloads` (key `djsync/<file>`, uploaded by
    `apps/dj-sync/release.sh`), with HEAD and byte ranges.
  - **Cloud endpoints:** `/health`, `/v2/*`, `/api/downloads*`,
    `/api/playlists`, `/agent/*`, `/telegram/*`, `/i/*` (the one-scan iPhone
    install) and any path ending in `/mcp` go to the `dj-sync-cloud` Worker
    over a service binding. A browser opening `/api/downloads` or
    `/api/playlists` (HTML, no `Authorization`) is sent to
    `/connect/iphone/` instead.
  - **Old host:** `djsync.triplejmusic.art` (the launch host) is routed here
    and answers with a 301 to the same path.
  - **Old downloads domain:** `downloads.triplejmusic.art` (the bucket's
    original custom domain) keeps serving, for apps that predate the move.
  - **Tests:** `node --test test/*.test.mjs`. No dependencies.

```
public/
  index.html                home
  install/                  install guide, including the one-time "Open Anyway" step
  connect/telegram/         pairing the shared DJ Sync Telegram bot (free, any phone)
  connect/claude/           adding DJ Sync to Claude (custom connector; one free)
  connect/iphone/           building the iPhone Share-sheet Shortcut (free)
  connect/chatgpt/          adding DJ Sync to ChatGPT (custom MCP connector; paid plan)
  faq/  privacy/  terms/
  404.html
  assets/site.css           design tokens; dark first, light via prefers-color-scheme
  assets/site.js            renders the support contact (see below)
  assets/icon.svg
  _headers                  CSP and security headers
  robots.txt  sitemap.xml
```

Each page carries its own copy of the header and footer. If you change the
nav or footer, change it in every page.

## SEO and sharing

- **Generated head.** Each page's `<head>` holds a block written by a script.
  That block covers the title, description, robots, canonical, icons and
  manifest, Open Graph and Twitter tags, and JSON-LD. The JSON-LD includes
  `FAQPage` and `HowTo`, built from the page's own text, so it always matches
  what's shown.
  - **When you change a page's title, description, FAQ or steps,** run the
    generator again so the structured data stays true.
  - **The generator isn't in the repo.** It lived in the release scratch
    space; its rules are in this section.
- **Share cards** live in `public/og/<page>.png` (1200×630, under 250 KB
  each), rendered from HTML with headless Chrome.
  - **Cards:** home, install, faq, connect-chatgpt, connect-claude,
    connect-telegram, connect-iphone, and `default` for privacy, terms and
    404.
  - **After changing a card, bump the file name or wait a week:** cards are
    cached for a week (`_headers`).
- **Icons:** `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`
  (full-bleed, since iOS rounds it), `icon-192.png`, `icon-512.png` and
  `site.webmanifest`.
- **Crawling:**
  - `robots.txt` allows everyone, including AI crawlers. It disallows
    `/api/`, `/v2/`, `/i/`, `/telegram/` and `/download/`, which aren't
    pages.
  - `sitemap.xml` lists every indexable page, with `<lastmod>` and the card
    image.
  - `llms.txt` is a plain summary for AI assistants.
- **Not done here:** verifying the site in Google Search Console or Bing
  Webmaster Tools and submitting the sitemap. That needs the owner's Google
  or Microsoft account. The DNS TXT method is easiest, since the zone is on
  Cloudflare.

## Support contact

The support contact is set in one place: `SUPPORT_CONTACT` in
`public/assets/site.js`. It's `null` until the owner picks a contact (spec §8).
While it's `null`, the footer only tells DJs to use **About → Copy
diagnostics**.

## Deploy

```bash
apps/dj-sync-site/deploy.sh
```

`deploy.sh` does four things:
1. Stamps every page with the app's version. `tools/seo.py` reads
   `apps/dj-sync/macos/VERSION`.
2. Runs the tests.
3. Deploys with `../dj-sync-cloud/node_modules/.bin/wrangler`.
4. Checks that the live home page advertises that version.

`apps/dj-sync/release.sh` runs it after every release. It stamps and commits
the pages before the build, so the release tag has them. A bare
`wrangler deploy` works too, but skips the stamping and the check. The first
deploy also creates the custom domain (DNS record and certificate).

## Check

```bash
for p in / /install/ /connect/chatgpt/ /connect/claude/ /faq/ /privacy/ /terms/; do
  curl -s -o /dev/null -w "%{http_code} %{content_type} $p\n" "https://djsync.jeffrey.build$p"
done
```
