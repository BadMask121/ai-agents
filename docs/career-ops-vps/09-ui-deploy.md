# 09 — Deploy the UI via Coolify

This walks you through deploying the `career-ops-ui` Next.js app from the `ai-agents` monorepo to your existing Coolify instance, bind-mounted to the career-ops workspace so it can read/write your data files and drive the agent.

## Prerequisites

- Steps 01–08 are done. career-ops is installed at `/home/career/work/career-ops` on the VPS and the scheduled scan is running.
- You have a public domain (or subdomain) pointing at the VPS. Coolify will issue Let's Encrypt TLS automatically.
- The repo is pushed to `github.com/BadMask121/ai-agents` (or wherever you host it) and the `packages/career-ops-ui/` directory is committed.
- **Coolify's reverse proxy is installed and running.** Coolify ships without a proxy active — ports 80 and 443 are closed until you install one. See [10-deploy-checklist.md § Phase 0](10-deploy-checklist.md#phase-0--install-coolifys-reverse-proxy-one-time) for the one-time setup (pick Traefik). Verify with `curl -sI http://<vps-ip>/` — you should get an HTTP response (probably 404 for an unrouted host), not `Connection refused`.

## Where to access Coolify

Coolify's own dashboard runs on port 8000, not 80. Open it at:

```
http://95.217.185.93:8000
```

After you attach a domain to the Coolify app in Phase 5 below, Traefik will handle HTTPS for the career-ops UI on that domain. The Coolify admin dashboard stays on `:8000` unless you separately assign it a domain (optional — see Coolify docs).

## Step 1 — Prepare secrets locally

Generate a random session secret and a bcrypt hash of your login password. Run these on your Mac:

```bash
# 64-char session secret
openssl rand -hex 32

# bcrypt hash of your chosen password — pick a strong one
cd packages/career-ops-ui
node scripts/hash-password.mjs 'your-login-password-here'
```

Copy both values somewhere safe (password manager). You'll paste them into Coolify in step 4.

## Step 2 — Create the Coolify application

1. Open your Coolify dashboard at <http://95.217.185.93:8000> (the port matters — nothing responds on 80 until Traefik is installed).
2. **+ New** → **Application** → **Public Repository** (or private, with a deploy key).
3. Repository URL: `https://github.com/BadMask121/ai-agents`
4. Branch: `main`
5. Build pack: **Dockerfile**
6. Dockerfile location: `packages/career-ops-ui/Dockerfile`
7. **Build context: the monorepo root (leave as `.` — do NOT set it to `packages/career-ops-ui`).** The Dockerfile needs `pnpm-lock.yaml` and `turbo.json` at the root to work.
8. Ports exposes: `3000`

Click **Save** but don't deploy yet.

## Step 3 — Configure the bind mount

This is the most important step. The UI container needs read/write access to `/home/career/work/career-ops` on the host so it can manipulate `cv.md`, `data/pipeline.md`, etc., and invoke `claude` against that workspace.

In the Coolify app's **Storages** (or **Volumes**) tab:

- **Mount type:** Bind mount (not a named Docker volume)
- **Source (host path):** `/home/career/work/career-ops`
- **Destination (container path):** `/workspace/career-ops`
- **Read-only:** no

If Coolify's UI doesn't expose a bind-mount toggle for this app type, use a custom `docker-compose.yml` override — add it in the app's **Docker Compose** section:

```yaml
services:
  app:
    volumes:
      - /home/career/work/career-ops:/workspace/career-ops
```

## Step 4 — Environment variables

In the Coolify app's **Environment Variables** tab, add:

| Key | Value | Build-time? | Secret? |
|---|---|---|---|
| `AUTH_SECRET` | (from `openssl rand -hex 32`) | — | ✓ |
| `AUTH_PASSWORD_HASH` | (from `hash-password.mjs`) | — | ✓ |
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` (your key) | — | ✓ |
| `CAREER_OPS_WORKSPACE` | `/workspace/career-ops` | — | — |
| `NODE_ENV` | `production` | — | — |

## Step 5 — Configure the domain

In **Domains** add your domain (e.g. `career.your-domain.com`). Enable **Force HTTPS** and **Generate SSL certificate**. Coolify uses Caddy/Traefik to terminate TLS via Let's Encrypt automatically.

Point your DNS A record at the VPS public IP `95.217.185.93` before deploying, so the ACME HTTP-01 challenge can complete.

## Step 6 — Deploy

Click **Deploy**. Coolify will:

1. Clone the repo
2. Build the Docker image using `packages/career-ops-ui/Dockerfile` with the monorepo as context
3. Start the container on an internal network
4. Wire up Traefik/Caddy to route your domain to `:3000` with TLS

First build takes ~5 minutes because it installs pandoc, Playwright Chromium, and the claude-code CLI. Subsequent builds are faster thanks to layer caching.

Watch the build log in the Coolify UI. If it fails, see the troubleshooting section below.

## Step 7 — First-run checks

Once the deploy is green:

1. Open `https://career.your-domain.com` in your browser.
2. You should see the login page.
3. Log in with the password you hashed in step 1.
4. **Home** should show stats (pending / processed / blocked) read from `data/pipeline.md`. If they're all zero, the scheduled scan hasn't run yet or hasn't found any jobs matching your `portals.yml`.
5. **Resume** → upload your actual resume (docx/pdf). It should convert to markdown and save to `cv.md`.
6. **Pipeline** → paste a real JD URL, click **Add**, then **Approve**. You should see Claude Code's output stream into the log box under the card. That confirms the subprocess + SSE path works.
7. **Settings → Profile / Portals / Narrative** — each should load the existing file and let you save edits.

## Step 8 — Verify the scheduled scan still works with the bind mount

The container and the host both write to the same files, so ordering matters a little. Confirm the systemd scan timer still runs cleanly:

```bash
ssh career@95.217.185.93
systemctl list-timers career-scan.timer
sudo systemctl start career-scan.service
tail -f ~/work/career-ops/logs/scan-$(date +%F).log
```

If you want to trigger the scan from the UI instead of cron, use the `/api/actions` endpoint with `{"mode":"scan"}` — but this spends Claude tokens via `claude -p "/career-ops scan"`. The cron version calls `node scan.mjs` directly (zero tokens). Keep both for now.

## Troubleshooting

### Build fails on `pnpm install`

**Cause:** Dockerfile build context is wrong. Coolify built with the `packages/career-ops-ui/` directory as context, so `pnpm-lock.yaml` and `turbo.json` aren't visible.

**Fix:** In the Coolify app settings, set **Build context** to the repo root (`.`), leave the Dockerfile path as `packages/career-ops-ui/Dockerfile`.

### Build fails with `Cannot find module 'sharp'` or similar

**Cause:** pnpm build scripts for native modules were skipped.

**Fix:** Add a `.npmrc` at the repo root with `enable-pre-post-scripts=true`, or rebuild — Next.js doesn't actually need sharp for this app (we have no `next/image` usage).

### Container starts but browser shows `Error: AUTH_SECRET must be set`

**Cause:** Environment variable missing or shorter than 32 chars.

**Fix:** Set `AUTH_SECRET` to the output of `openssl rand -hex 32` in the Coolify env vars.

### Login works but the app is empty everywhere

**Cause:** Bind mount isn't in place or points to the wrong host path.

**Fix:** `docker exec -it <container> ls /workspace/career-ops` should show `cv.md`, `config/`, `portals.yml`, etc. If it's empty, the bind mount didn't apply. Re-check Coolify's volume config.

### Upload fails with "pandoc: command not found"

**Cause:** You're running an old image that didn't have pandoc baked in.

**Fix:** Rebuild from latest — the Dockerfile installs pandoc at the runtime stage.

### Approving a job hangs forever

**Cause:** The `claude` binary either isn't in the container's PATH or can't authenticate.

**Fix:**
```bash
docker exec -it <container> claude --version
docker exec -it <container> env | grep ANTHROPIC_API_KEY
```

The binary is installed at `/usr/local/bin/claude` by `npm install -g` in the Dockerfile. The env var must be set in Coolify.

### File writes from the UI aren't visible to `claude` running on the host

**Cause:** The container and the host `career` user have different UIDs. The container writes files as UID 1000 (the `node` user inside node:20-bookworm-slim), and on the host `career` is also UID 1000 — so by default they match. But if your VPS has a different UID for `career`, ownership drifts.

**Check:**
```bash
ssh career@95.217.185.93 id -u
# should print 1000
```

If it's not 1000, adjust the Dockerfile's `USER` line to match, or switch the container to run as root and chown on boot (less secure).

## Updating the UI

Push changes to `main` on GitHub → Coolify has a webhook and auto-deploys. Or click **Redeploy** in the UI for a manual trigger.

For local development without deploying, run:

```bash
cd packages/career-ops-ui
cp .env.example .env.local
# fill in AUTH_SECRET, AUTH_PASSWORD_HASH, ANTHROPIC_API_KEY, and
# set CAREER_OPS_WORKSPACE to a real workspace directory (can be a local
# clone of career-ops for testing)
pnpm dev
```

The dev server runs on <http://localhost:3000> with the same file-based I/O.
