# dj-sync-site

The public DJ Sync website: <https://djsync.jeffrey.build>.

Spec: `docs/superpowers/specs/2026-10-28-dj-sync-public-distribution-design.md` §4.

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
  - **Cloud endpoints:** `/health`, `/v2/*`, `/api/downloads*`, `/agent/*`,
    and any path ending in `/mcp` go to the `dj-sync-cloud` Worker over a
    service binding.
  - **Old host:** `djsync.triplejmusic.art` (the launch host) is routed here
    and answers with a 301 to the same path.
  - **Old downloads domain:** `downloads.triplejmusic.art` (the bucket's
    original custom domain) keeps serving, for apps that predate the move.
  - **Tests:** `node --test test/*.test.mjs`. No dependencies.

```
public/
  index.html                home
  install/                  install guide, including the one-time "Open Anyway" step
  connect/chatgpt/          adding DJ Sync to ChatGPT (custom MCP server)
  connect/claude/           adding DJ Sync to Claude (custom connector)
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

## Support contact

The support contact is set in one place: `SUPPORT_CONTACT` in
`public/assets/site.js`. It's `null` until the owner picks a contact (spec §8).
While it's `null`, the footer only tells DJs to use **About → Copy
diagnostics**.

## Deploy

```bash
cd apps/dj-sync-site
npx wrangler@4.154.0 deploy      # or ../dj-sync-cloud/node_modules/.bin/wrangler deploy
```

The first deploy also creates the custom domain (DNS record and certificate).

## Check

```bash
for p in / /install/ /connect/chatgpt/ /connect/claude/ /faq/ /privacy/ /terms/; do
  curl -s -o /dev/null -w "%{http_code} %{content_type} $p\n" "https://djsync.jeffrey.build$p"
done
```
