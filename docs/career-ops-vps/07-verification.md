# 07 — End-to-End Verification

Run through this checklist before relying on the agent. Don't skip — the cost of finding a broken link in the chain at 7am Monday is much higher than spending 20 minutes here.

## Runtime checks

- [ ] `node -v` shows v20.x or higher
- [ ] `go version` shows 1.22 or higher
- [ ] `claude --version` works
- [ ] `tailscale status` lists the VPS as `online`

## career-ops install

- [ ] `cd ~/work/career-ops && npm run doctor` exits clean
- [ ] `claude` starts an interactive session and authenticates
- [ ] `cv.md` exists at the repo root and is human-readable markdown
- [ ] `config/profile.yml` is populated with your real info
- [ ] `config/portals.yml` is populated with at least 5 real company boards
- [ ] `./dashboard/career-dashboard` launches and renders the TUI

## Mobile access

- [ ] Phone has Tailscale installed and signed in to the same account
- [ ] Phone shows `career-vps` in the Tailscale device list
- [ ] Phone browser reaches `http://<tailscale-ip>:7681`
- [ ] Basic-auth login works
- [ ] Terminal renders, you can type commands
- [ ] PWA icon installed on phone home screen, opens straight into tmux
- [ ] tmux session persists after closing and reopening the PWA
- [ ] `systemctl status career-ttyd` shows active (running)

## Scheduled scanning

- [ ] `systemctl list-timers | grep career-scan` shows a next-fire time
- [ ] Manual run: `sudo systemctl start career-scan.service`
- [ ] After ~1 minute: `cat ~/work/career-ops/logs/scan.log` shows scan output, no errors
- [ ] Re-run the dashboard and confirm new jobs appear

## End-to-end real run

- [ ] In an interactive `claude` session, run `/career-ops <real_jd_url>` against an actual job posting
- [ ] PDF appears under `output/`
- [ ] `scp` the PDF to your laptop and open it — content is sensible, formatted correctly, no template placeholders
- [ ] Tracker entry exists for the job

## Hardening (after Tailscale SSH is verified)

- [ ] `sudo ufw delete allow 22/tcp` to remove public SSH exposure
- [ ] `sudo ufw status` confirms only Tailscale traffic is allowed
- [ ] You can still ssh in via `ssh career@career-vps` over Tailscale

## Backups

- [ ] Nightly backup configured. Example crontab entry (run `crontab -e` as `career`):
  ```
  0 3 * * * tar czf /home/career/backups/career-ops-$(date +\%F).tgz /home/career/work/career-ops/data /home/career/work/career-ops/reports /home/career/work/career-ops/output /home/career/work/career-ops/cv.md /home/career/work/career-ops/config 2>/dev/null
  ```
- [ ] `mkdir -p ~/backups` before the first run
- [ ] Optional: rsync `~/backups/` offsite (S3, Backblaze, your laptop)

## When all boxes are checked

You have a working personal job agent. Move on to [08-troubleshooting.md](08-troubleshooting.md) for the things that will go wrong over time.
