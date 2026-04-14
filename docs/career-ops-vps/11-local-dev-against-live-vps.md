# 11 — Local dev against the live VPS (no redeploy loop)

Goal: edit `career-ops-ui` and see changes in your browser within milliseconds, against the **real** VPS workspace, `claude` CLI, Playwright, and bind-mounted data — without pushing to GitHub and waiting for Coolify to rebuild on every iteration.

## The core idea

`career-ops-ui` is filesystem-coupled to `/home/career/work/career-ops` and shells out to `claude` + Playwright. Those dependencies only exist on the VPS. So instead of trying to recreate them on your Mac, **the VPS is the primary editing surface**: code lives there, `next dev` runs there, you edit it from your Mac via Cursor Remote-SSH and view it via an SSH tunnel.

Result: one setup that works for UI polish, agent work, SSE streams, Playwright automation — everything. Prod and dev read the same workspace, so there is no "works on my laptop" drift.

## Prerequisites

- Steps 01–09 completed — VPS is up, Coolify is deploying `career-ops-ui` to production on your domain.
- SSH access to the VPS as the `career` user, passwordless (key-based).
- Cursor or VS Code on your Mac.

## Step 1 — Add your Mac's SSH key to the `career` user

The `career` user owns `/home/career/work/career-ops`. Connecting as `career` (not `root`) means any files your dev server writes have matching ownership with the scheduled scanner and Coolify's bind mount — no permission drift.

On your Mac, grab your public key:

```bash
cat ~/.ssh/id_ed25519.pub  # or id_rsa.pub
```

On the VPS as root, append it to the `career` user's authorized keys:

```bash
ssh root@95.217.185.93
sudo -u career mkdir -p /home/career/.ssh
sudo -u career tee -a /home/career/.ssh/authorized_keys < <(echo '<paste-your-pubkey-here>')
sudo chmod 700 /home/career/.ssh
sudo chmod 600 /home/career/.ssh/authorized_keys
```

Verify from your Mac:

```bash
ssh career@95.217.185.93 'whoami && id'
# career
# uid=1000(career) gid=1000(career) ...
```

## Step 2 — Set up a GitHub deploy key on the VPS

`ai-agents` is a private repo, so the `career` user needs its own SSH key registered as a GitHub deploy key to `git pull` and `git push`.

Generate the key on the VPS:

```bash
ssh career@95.217.185.93 'ssh-keygen -t ed25519 -f ~/.ssh/github-ai-agents -N "" -C "career@vps deploy key for ai-agents" && cat ~/.ssh/github-ai-agents.pub'
```

Copy the printed public key, then go to **<https://github.com/BadMask121/ai-agents/settings/keys/new>**:

- **Title:** `vps-career`
- **Key:** paste
- **Allow write access:** ✅ (you'll be pushing from the VPS)
- Click **Add key**

Configure SSH on the VPS to use the key for github.com and switch the remote to SSH:

```bash
ssh career@95.217.185.93 '
  printf "\nHost github.com\n  IdentityFile ~/.ssh/github-ai-agents\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n" >> ~/.ssh/config
  chmod 600 ~/.ssh/config
  ssh -o BatchMode=yes -T git@github.com  # should say "Hi BadMask121/ai-agents! ..."
'
```

## Step 3 — Clone `ai-agents` on the VPS

```bash
ssh career@95.217.185.93
cd ~
git clone git@github.com:BadMask121/ai-agents.git
cd ai-agents
```

Make sure node + pnpm are available. The VPS has nvm-managed node from `02-claude-code-and-career-ops.md`, but nvm is only sourced for interactive shells — non-interactive SSH commands won't see `node` until you source it explicitly:

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20
corepack enable
corepack prepare --activate
pnpm install
```

## Step 4 — Create `.env.local` for dev

The fastest way: extract the live env vars from the running Coolify container so dev uses the same secrets as prod.

```bash
ssh root@95.217.185.93 '
  CID=$(docker ps --format "{{.ID}} {{.Names}}" | grep utvvmofv | head -1 | awk "{print \$1}")
  docker exec "$CID" env \
    | grep -E "^(AUTH_SECRET|AUTH_PASSWORD_HASH|ANTHROPIC_API_KEY|CAREER_OPS_WORKSPACE)=" \
    > /tmp/career-env.tmp
  chown career:career /tmp/career-env.tmp
  chmod 600 /tmp/career-env.tmp
  mv /tmp/career-env.tmp /home/career/ai-agents/packages/career-ops-ui/.env.local
'
```

Then fix `CAREER_OPS_WORKSPACE` — inside the container it's `/workspace/career-ops`, but dev runs on the **host** so it needs the host path:

```bash
ssh career@95.217.185.93 'sed -i "s|^CAREER_OPS_WORKSPACE=.*|CAREER_OPS_WORKSPACE=/home/career/work/career-ops|" /home/career/ai-agents/packages/career-ops-ui/.env.local'
```

Replace `utvvmofv` with the actual Coolify container name prefix if it changes (find it with `docker ps`).

> **Warning.** `CAREER_OPS_WORKSPACE` points at live data. If you're iterating on destructive operations (delete, rewrite `pipeline.md`, etc.) and don't trust your code yet, point it at a copy instead: `cp -a /home/career/work/career-ops /home/career/work/career-ops.dev` and update the env var.

## Step 5 — Run the dev server

You have two options. Pick whichever matches what you're doing.

### Option A — `pnpm dev:vps` (one-command, from your Mac)

A helper script in `packages/career-ops-ui/package.json` opens an SSH tunnel and starts the dev server in a single foreground process:

```bash
cd packages/career-ops-ui
pnpm dev:vps
```

That:
1. SSHs into `career@95.217.185.93`
2. Forwards your Mac's `localhost:3000` → VPS `:3000`
3. Kills any leftover `career-dev` tmux session so port 3000 is clean
4. Sources nvm, `cd`s into the package, runs `pnpm dev` in the foreground
5. Streams Next.js logs back to your Mac terminal

Open <http://localhost:3000> in your Mac browser. Hit `Ctrl-C` to stop the dev server *and* tear down the tunnel in one go.

Use this when you want to **start the dev server quickly from your Mac** without opening Cursor's remote window.

### Option B — Cursor Remote-SSH (primary editor)

This is the way for actual development. Edits, file navigation, terminal, source control, AI completions — all running on the VPS, controlled from your Mac.

1. Open Cursor → `Cmd+Shift+P` → **Remote-SSH: Connect to Host...** → **Add New SSH Host** → `ssh career@95.217.185.93` → save to `~/.ssh/config`.
2. Connect. New window opens; status bar bottom-left turns green and says `SSH: 95.217.185.93`.
3. **File → Open Folder** → `/home/career/ai-agents`.
4. Open the integrated terminal (it opens *on the VPS*, not your Mac), then:
   ```bash
   cd packages/career-ops-ui && pnpm dev
   ```
5. Cursor auto-detects port 3000 and forwards it to `localhost:3000` on your Mac. Open in your browser.

Edits in the editor land directly on the VPS filesystem → Turbopack picks them up natively → HMR fires → browser updates. No sync layer, no rsync, no diff drift.

## Step 6 — Verify the full stack works

Run through the same first-run checks as the Coolify deploy (see `09-ui-deploy.md` § Step 7):

1. Log in (same password as prod, since the env is shared).
2. Home view shows real pipeline stats.
3. Pipeline → approve a test JD → watch Claude's output stream into the log box. This confirms the `claude` CLI subprocess and SSE path work from dev.
4. A view that triggers Playwright (prepareApplication agent) should launch headless Chromium on the VPS. If it fails: `pnpm exec playwright install chromium`.

If any of those fail in dev but work in prod, the dev clone is missing a dependency Coolify's Dockerfile installs. Compare against `packages/career-ops-ui/Dockerfile` — usually it's `pandoc`, Playwright browsers, or the globally-installed `claude` CLI.

## Daily git flow (VPS-as-primary)

Once the VPS is your editing surface, treat it as the source of truth:

```bash
# In the Cursor Remote-SSH terminal (or plain SSH)
cd ~/ai-agents
git status
git add <files>
git commit -m "..."
git push
```

To bring your Mac local clone back in sync afterwards:

```bash
# On your Mac
git fetch origin
git pull --ff-only origin main
```

The Mac copy is now a read-only mirror you can browse offline or grep through. Don't edit it unless you're explicitly switching the primary editing surface back to the Mac.

If you ever do edit on the Mac and need to ship from there, use the same loop in reverse: commit + push from Mac, then `ssh career@... 'cd ~/ai-agents && git pull'`.

## Port conflicts with prod

Coolify's prod container also listens on `3000`, but **inside its own network namespace** — it does not collide with `next dev` running on the host. Verify:

```bash
ssh career@95.217.185.93 'ss -tln | grep :3000'
```

You should see one listener on `*:3000` (your dev server). Traefik still routes your public domain to the Coolify container unchanged.

If you prefer a different port:

```bash
pnpm dev -- -p 3001
```

Cursor will forward `3001` instead.

## Troubleshooting

### Cursor Remote-SSH says "Could not establish connection"

Plain `ssh career@95.217.185.93` from a Mac terminal must work first. If that fails, the problem is your SSH key/config, not Cursor. If plain SSH works but Remote-SSH doesn't, delete `~/.cursor/extensions/anysphere.remote-ssh-*` (or the VS Code equivalent) and reinstall.

### `pnpm dev` fails with `EADDRINUSE :::3000`

Something is bound to 3000 on the VPS host. Find and clean up:

```bash
ss -tlnp | grep 3000
tmux kill-session -t career-dev 2>/dev/null
pkill -f "next dev"
```

### Hot reload doesn't fire on save

Turbopack on bind-mounted or NFS-like filesystems sometimes misses file events. The VPS local filesystem is native ext4, so this should not happen — but if it does, add `WATCHPACK_POLLING=true` to `.env.local`.

### Dev server reads files but writes silently fail

You connected as a user that doesn't own `/home/career/work/career-ops`. Reconnect as `career` (see Step 1) — the entire workflow assumes the `career` user.

### Claude subprocess works in prod but not dev

`claude` is installed for the `career` user via nvm at `~/.nvm/versions/node/v20.x/bin/claude`. If `which claude` returns nothing in your shell, source nvm:

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20
which claude
```

Adding the nvm sourcing to `~/.bashrc` outside the interactive-only block will fix it for non-interactive SSH commands too.

### Playwright launches Chromium but it can't find a browser

```bash
cd ~/ai-agents/packages/career-ops-ui
pnpm exec playwright install chromium
```

One-time per clone.

### Mac browser shows "connection refused" on `localhost:3000`

The SSH tunnel dropped (or the dev server stopped). For `pnpm dev:vps`: just rerun it. For Cursor Remote-SSH: open the **Ports** tab at the bottom of the window — if 3000 isn't listed, click **Forward a Port** and add it. If it's listed but red, reload the window (`Cmd+Shift+P` → **Remote: Reload Window**).

### `git pull` on the VPS asks for credentials

The deploy key isn't being used. Check:

```bash
ssh career@95.217.185.93 'cat ~/.ssh/config; git -C ~/ai-agents remote -v'
```

Remote should be `git@github.com:BadMask121/ai-agents.git` (SSH, not HTTPS). The `~/.ssh/config` should have the `Host github.com` block from Step 2.

## When to use this vs. Coolify deploy

| Scenario | Use |
|---|---|
| UI polish, layout iteration, copy changes | Remote-SSH dev |
| New agent, new API route, new SSE stream | Remote-SSH dev |
| Anything touching `claude`, Playwright, or workspace writes | Remote-SSH dev |
| Final smoke test before announcing a change | Coolify deploy |
| Testing the Dockerfile itself | Coolify deploy |
| Changes to `package.json` dependencies | Coolify deploy (round-trip) |

Rule of thumb: TypeScript/React changes → test in dev first. Dockerfile, env-var wiring, or dependency changes → round-trip through Coolify to know it really works.

## Optional — Tailscale on top

Tailscale is not required, but adding it gives you:

- Slightly lower SSH latency (private LAN routing, no public-IP RTT)
- Mac → VPS without the public IP being involved
- Phone access to the same forwarded dev server when you're on the tailnet

If you want it: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --ssh` on the VPS, install the Tailscale Mac app, then point your SSH config at the tailnet hostname instead of the public IP. Everything else in this doc stays the same.
