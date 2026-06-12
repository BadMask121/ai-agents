# Prole — Rename + Landing Page & Distribution

> **Status:** Approved design · **Date:** 2026-06-12 · **Supersedes name:** Proletariat

Rename the Proletariat macOS app to **Prole**, and ship a static landing page (hosted on
the existing Hetzner + Coolify infra) from which users download a `.dmg` and install it.

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Rename scope | **Full** — directories, bundle identifier, crate, and all strings |
| Landing page + download host | **Hetzner + Coolify** (alongside career-ops-ui) |
| Code signing | **Ad-hoc** + on-page Gatekeeper instructions; notarization is fast-follow |
| Download format | **DMG** |
| Domain | **None yet** — use relative URLs; Coolify default URL serves the page |

## Part 1 — Rename Proletariat → Prole

Mechanical, repo-wide rename. The new bundle identifier (`com.prole.app`) means macOS treats
it as a brand-new app, so Screen Recording permission must be re-granted on first run — accepted.

### Surface area

| Area | Change |
| --- | --- |
| Directories | `git mv apps/proletariat apps/prole`; `git mv docs/proletariat docs/prole` |
| Crate | `src-tauri/Cargo.toml`: `name = "prole"`, lib `name = "prole_lib"` |
| Crate entrypoint | `src-tauri/src/main.rs`: `prole_lib::run()` |
| Tauri bundle | `tauri.conf.json`: `productName: "Prole"`, `identifier: "com.prole.app"` |
| JS package | `package.json`: `"name": "prole"` |
| User-facing strings | `lib.rs` ("Quit Prole", run-error msg); `windows.rs` window titles ("Prole", "Prole — Markup", "Prole — Settings", "Prole — Permission needed"); `permission.html` body text |
| Runtime detail | `capture.rs`: temp-file prefix `prole-{pid}.png` |
| Docs / QA | `docs/prole/*` (incl. the bd-epic reference), `apps/prole/QA.md`, READMEs |
| Tracking | Update bd issue titles `ai-agents-hd5`, `ai-agents-u5e`; update the `project_proletariat` memory file/slug + path |

### Verification

- Workspace globs still resolve: `pnpm-workspace.yaml` is `apps/*` (no edit needed); there is no
  root Cargo workspace (`src-tauri` is standalone).
- `cd apps/prole && pnpm test && pnpm test:rust` pass after the rename.
- `pnpm tauri build --bundles dmg` produces `Prole.dmg` with no stale "Proletariat" strings:
  `grep -ri proletariat apps/prole docs/prole` returns nothing (outside Cargo.lock history).

## Part 2 — Landing page + distribution

### Landing page — `apps/prole-site/`

A single static page. Plain HTML + CSS, no framework (a marketing one-pager doesn't warrant a
build toolchain). Served by nginx from a small `Dockerfile` that Coolify builds from git.

**Page sections**

1. **Hero** — name + one-liner ("Snip anything on screen → ask Claude"), primary
   **Download for macOS** button (`<a href="/download/Prole.dmg">`).
2. **How it works** — 3-step strip: trigger → draw rectangle + mark up + type your question →
   paste the composite image into Claude.
3. **Install** — the Gatekeeper workaround for an ad-hoc-signed app:
   - Open the `.dmg`, drag **Prole** to Applications.
   - First launch: **right-click → Open** (or run `xattr -dr com.apple.quarantine /Applications/Prole.app`).
   - On first capture, grant **Screen Recording** in System Settings → Privacy & Security.
4. **Footer** — version, link back to repo.

**Files**

```
apps/prole-site/
  index.html
  styles.css
  assets/            # icon, screenshots
  Dockerfile         # nginx:alpine, copies site to /usr/share/nginx/html, serves /download from mount
  nginx.conf         # static serving + correct MIME for .dmg, /download alias
  package.json       # minimal, so the apps/* workspace glob is satisfied
  README.md          # Coolify deploy + how /download is mounted
```

### Binary distribution

The DMG is a rebuilt binary and is **never committed to git**. Instead:

- A persistent directory on the VPS — `/data/prole-releases/` — is bind-mounted into the nginx
  container at the path nginx serves as `/download`.
- `apps/prole/scripts/release.sh`:
  1. `pnpm tauri build --bundles dmg` (ad-hoc signed; built locally so no Gatekeeper quarantine).
  2. `scp` the resulting `Prole.dmg` to `root@95.217.185.93:/data/prole-releases/Prole.dmg`.
  3. Print the resulting download URL.
- Download button uses the **relative** path `/download/Prole.dmg`, so it works under Coolify's
  default URL today and unchanged once a real domain is attached.

macOS builds stay **local** (no Mac CI needed), consistent with the existing
"locally built, no quarantine" approach in `ai-agents-hd5`. The landing page redeploys from git
independently of binary releases.

### Coolify wiring (documented, executed at deploy time)

- New Coolify application from the `apps/prole-site/` Dockerfile.
- Persistent storage / bind mount: host `/data/prole-releases` → container `/download` (read-only).
- No custom domain for now — Coolify's generated URL is the launch URL.

## Out of scope (fast-follow)

- Developer ID signing + notarization (`ai-agents-u5e`) → removes the Gatekeeper steps from the page.
- Auto-update feed, versioned/`latest` DMG naming, release notes.
- Custom domain + TLS once DNS is chosen.
- macOS CI build pipeline.

## Testing

- **Rename:** `pnpm test` + `pnpm test:rust` green; clean `grep` for old name; `tauri build` yields `Prole.dmg`.
- **Landing page:** `docker build` + `docker run` locally serves `index.html`; a placeholder file at
  the mount path is downloadable at `/download/Prole.dmg` with `Content-Type: application/x-apple-diskimage`.
- **Release script:** dry-run prints the correct `scp` target and URL; first real run uploads and the
  page's download button fetches the DMG.
