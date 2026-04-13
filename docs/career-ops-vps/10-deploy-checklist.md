# 10 — Deploy Checklist (action list for you)

A condensed, action-oriented checklist to get the career-ops UI live on Coolify. Use alongside [09-ui-deploy.md](09-ui-deploy.md), which has the full walkthrough and troubleshooting.

> **Secrets for the first deploy are in the chat, not this file.** Never commit actual secrets to git — paste them directly into Coolify's env vars UI.

---

## Phase 0 — Install Coolify's reverse proxy (one-time)

Coolify ships without a reverse proxy running by default, so ports 80/443 are closed until you install one. Do this once before your first app deploy.

- [ ] Log in to Coolify at **<http://95.217.185.93:8000>**
- [ ] Left sidebar → **Servers** → click `localhost`
- [ ] Open the **Proxy** tab
- [ ] Select **Traefik** (Coolify's default — don't pick Caddy unless you have a specific reason)
- [ ] Click **Install / Start Proxy**
- [ ] Wait ~20s, then confirm: from your Mac run
  ```bash
  curl -sI http://95.217.185.93/ | head -1
  ```
  You should get back `HTTP/1.1 404 page not found` (that's Traefik responding with "no route for this host" — expected until you attach a domain). If you get `Connection refused`, the proxy didn't start; check the **Proxy** tab for logs.

Once Traefik is running, proceed to Phase 1.

---

## Phase 1 — Before you touch Coolify's application UI

- [ ] **Rotate the Anthropic API key**
  You pasted the old key in chat during setup — treat it as exposed.
  1. Open <https://console.anthropic.com/settings/keys>
  2. Revoke the old key (`sk-ant-api03-70GSTsPAfuvRV2UolPzKiafr5iVgdDO4z2SoWW_Za-pVmY...`)
  3. Create a new one, copy it, keep it in a password manager

- [ ] **Pick a subdomain**
  e.g. `career.yourdomain.com`. Whatever you pick, add a DNS **A record** → `95.217.185.93` *now*, so propagation has time to finish before Let's Encrypt tries to issue a cert.

- [ ] **Save the UI secrets to your password manager**
  From the chat message that accompanies this doc, save:
  - UI login password (plaintext — this is what you type to log in)
  - `AUTH_SECRET` (env var)
  - `AUTH_PASSWORD_HASH` (env var — bcrypt of the plaintext password)

---

## Phase 2 — Coolify application setup

Open your Coolify dashboard at **<http://95.217.185.93:8000>** — the `:8000` is required, Coolify's dashboard is not on port 80. **+ New → Application → Public Repository**.

- [ ] **Repository:** `https://github.com/BadMask121/ai-agents`
- [ ] **Branch:** `main`
- [ ] **Build pack:** `Dockerfile`
- [ ] **Dockerfile path:** `packages/career-ops-ui/Dockerfile`
- [ ] **Base directory / Build context:** `.` (the monorepo root — leave blank or set to `.`)
  - ⚠️ Critical: if you set this to `packages/career-ops-ui`, the build will fail because `pnpm-lock.yaml` and `turbo.json` won't be visible.
- [ ] **Ports Exposes:** `3000`

Click **Save** (don't deploy yet — we need to add secrets and the volume first).

---

## Phase 3 — Storage (bind mount)

The UI container needs access to the career-ops workspace on the host.

In the app's **Storages** tab → **+ Add**:

- [ ] **Source Path (host):** `/home/career/work/career-ops`
- [ ] **Destination Path (container):** `/workspace/career-ops`
- [ ] **File System Mount** (bind mount, not a named volume)
- [ ] **Read Only:** off

If Coolify's Storages tab doesn't offer bind mounts for this app type, use the **Docker Compose** override under the app settings and paste:

```yaml
services:
  app:
    volumes:
      - /home/career/work/career-ops:/workspace/career-ops
```

---

## Phase 4 — Environment variables

In the app's **Environment Variables** tab, add:

| Key | Where it comes from | Mark as secret |
|---|---|---|
| `AUTH_SECRET` | chat message (64 hex chars) | ✓ |
| `AUTH_PASSWORD_HASH` | chat message (starts with `$2a$12$`) | ✓ |
| `ANTHROPIC_API_KEY` | **your rotated key**, not the old one | ✓ |
| `CAREER_OPS_WORKSPACE` | `/workspace/career-ops` | — |
| `NODE_ENV` | `production` | — |

⚠️ When pasting `AUTH_PASSWORD_HASH`, make sure Coolify treats `$2a$12$...` as a literal value. If the UI supports "build variable" vs "runtime" toggles, pick **runtime only** — we never need it at build time.

---

## Phase 5 — Domain + TLS

- [ ] Open the app's **Domains** tab
- [ ] Add `https://<your-subdomain>.<your-domain>`
- [ ] Enable **Force HTTPS**
- [ ] Enable **Generate SSL certificate** (Let's Encrypt via Coolify's built-in ACME)
- [ ] Verify the DNS A record from Phase 1 has propagated: `dig +short <your-subdomain>.<your-domain>` should return `95.217.185.93`

---

## Phase 6 — Deploy

- [ ] Click **Deploy**
- [ ] Watch the build log in the Coolify UI. First build takes ~5 min (installs pandoc + Chromium + claude-code CLI).
- [ ] Once the deploy turns green, open `https://<your-subdomain>.<your-domain>` in your browser.
- [ ] Log in with the **plaintext password** from the chat message.

---

## Phase 7 — First-run verification

After login:

- [ ] **Home** loads and shows pipeline stats (3 cards: pending / processed / blocked)
- [ ] **Resume → Upload resume** → pick your real `.docx` or `.pdf` → it converts and shows the markdown in the textarea. Click **Save**.
- [ ] **Settings → Profile** → loads `config/profile.yml` in the editor. Edit your name, target roles, comp range. Save.
- [ ] **Settings → Portals** → loads `portals.yml`. Customize with the companies you actually care about. Save.
- [ ] **Settings → Narrative** → loads `modes/_profile.md`. Fill in your archetypes / narrative. Save.
- [ ] **Pipeline** → paste a real job URL → click **Add** → click **Approve** on the card. You should see Claude Code's streaming output in the log box beneath the card. When it finishes, the card moves to "processed".
- [ ] Check on the VPS: `ls ~/work/career-ops/reports/` and `ls ~/work/career-ops/output/` — you should see a new report and PDF for that job.

---

## Phase 8 — Clean up the exposed key

- [ ] On the VPS, replace the Anthropic API key you set earlier with the rotated one:
  ```bash
  ssh career@95.217.185.93
  sed -i 's#^export ANTHROPIC_API_KEY=.*#export ANTHROPIC_API_KEY=<new-key>#' ~/.bashrc
  sed -i 's#^export ANTHROPIC_API_KEY=.*#export ANTHROPIC_API_KEY=<new-key>#' ~/.profile
  printf 'ANTHROPIC_API_KEY=%s\n' '<new-key>' > ~/.career-ops-env
  chmod 600 ~/.career-ops-env
  ```
- [ ] Confirm the scheduled scan still works: `sudo systemctl start career-scan.service && tail ~/work/career-ops/logs/scan-$(date +%F).log`
- [ ] Delete this chat message from your history if possible (the exposed key is here), or rotate again for paranoia's sake.

---

## If anything goes wrong

See [09-ui-deploy.md § Troubleshooting](09-ui-deploy.md#troubleshooting).

Quick checks:

```bash
# on the VPS
docker ps | grep career-ops-ui
docker logs <container> --tail 100
docker exec -it <container> ls /workspace/career-ops
docker exec -it <container> env | grep -E '(AUTH|ANTHROPIC|CAREER)'
docker exec -it <container> claude --version
```

---

## When you're done

Come back and tell me:
- ✅ "it works" — I'll help you curate `portals.yml` for worldwide remote jobs, and we can tune the UI based on what you find clunky in real use.
- ❌ "build failed" or "login broken" — paste the Coolify build log or the container logs and I'll debug.
