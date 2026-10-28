# Changelog

All notable changes to the DJ Sync website. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
