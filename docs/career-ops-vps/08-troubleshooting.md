# 08 — Troubleshooting

Things that will eventually go wrong, and how to recover.

## Playwright / Chromium

**`browserType.launch: Host system is missing dependencies`**
```bash
cd ~/work/career-ops
npx playwright install --with-deps chromium
```
If that still fails, install the libs from [01-vps-bootstrap.md](01-vps-bootstrap.md) by hand.

**Out of memory when generating PDF**
Chromium is hungry. If your VPS has < 2 GB RAM, add swap:
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Claude Code

**Auth token expired**
```bash
claude
# re-do the browser login flow
```

**API rate limit**
The scheduled scan hits the API hard. If you are on the API key plan and hitting limits, either:
- Move to a Pro/Max sub
- Reduce scan frequency in `career-scan.timer`
- Trim `portals.yml` to fewer companies

**Slash command not recognized inside claude**
The `/career-ops` commands are loaded from the project's `.claude/commands/` directory, so you must launch `claude` from inside `~/work/career-ops`. The systemd unit handles this via `WorkingDirectory=`. For interactive sessions, always:
```bash
cd ~/work/career-ops && claude
```

## Tailscale

**Phone can't reach the VPS**
1. Tailscale toggle on on phone
2. `tailscale status` on the VPS — is it `online`?
3. `sudo systemctl restart tailscaled` on the VPS

**Locked out after removing the public SSH rule**
Use the Hetzner web console (the screen icon next to your server in the Hetzner Cloud UI) to log in, then:
```bash
sudo ufw allow 22/tcp
sudo ufw reload
```
Re-investigate why Tailscale SSH stopped working before locking it down again.

## ttyd

**Service won't start**
```bash
sudo journalctl -u career-ttyd -n 100 --no-pager
```
Common causes:
- Tailscale interface not up yet — add `Requires=tailscaled.service` to the unit's `[Unit]` section
- Wrong path to ttyd binary — `which ttyd` and update `ExecStart`

**Terminal renders but typing does nothing**
You forgot the `-W` flag. Edit the unit, `daemon-reload`, `restart`.

**Basic auth not prompting**
Some browsers cache credentials aggressively. Try a private/incognito window first.

## tmux

**"sessions should be nested with care, unset $TMUX"**
You are already inside a tmux session. Either detach (`Ctrl-b d`) before launching ttyd manually, or just use the existing session.

**Lost work after disconnect**
Make sure the systemd unit's `ExecStart` uses `tmux new -A -s career` (the `-A` is critical — it attaches to an existing session instead of failing).

## Scheduled scan

**Timer fires but log is empty**
- Check `systemctl status career-scan.service` for the last run's exit code
- Confirm the `claude` binary path in `ExecStart` is correct (`which claude`)
- Confirm `WorkingDirectory` is the career-ops repo root
- Confirm auth: if API key, that `Environment=ANTHROPIC_API_KEY=...` is set; if subscription, that `~/.claude/` is readable by the `career` user

**Scan runs but finds nothing**
- `portals.yml` schema may be wrong — diff against `templates/portals.example.yml`
- Some companies stopped using their listed ATS — verify a sample URL by hand

## career-ops itself

**`npm run doctor` fails**
Read its actual output. Common issues:
- Playwright not installed → `npx playwright install --with-deps chromium`
- Missing config files → revisit [03-resume-and-config.md](03-resume-and-config.md)
- Go binary not on PATH → `. ~/.bashrc` or re-do the Go install in [01](01-vps-bootstrap.md)

**Generated CV looks wrong**
The CV template lives in the repo (likely under `templates/`). career-ops uses Space Grotesk + DM Sans by default. Look at the HTML template and adjust before regenerating with `/career-ops pdf`.

**Tracker file got corrupted**
Restore from your nightly backup:
```bash
cd ~/work/career-ops
tar xzf ~/backups/career-ops-YYYY-MM-DD.tgz --strip-components=3 home/career/work/career-ops/data
```
(Adjust paths to match your backup layout.)

## Updates

**Pulling upstream changes**
```bash
cd ~/work/career-ops
git fetch
git status
git pull
npm install
npm run doctor
```
If upstream changes break your config, your last working `cv.md`, `profile.yml`, `portals.yml`, and `data/` are in the nightly backup.

## Where to look first when something is wrong

1. `sudo journalctl -u career-ttyd -n 50 --no-pager`
2. `sudo journalctl -u career-scan -n 50 --no-pager`
3. `~/work/career-ops/logs/scan.log`
4. `tailscale status`
5. `systemctl status career-ttyd career-scan.timer`
