# career-ops on Hetzner VPS — Personal Job Agent

A step-by-step deployment guide for running [santifer/career-ops](https://github.com/santifer/career-ops) on a Hetzner Cloud VPS (CPX22 or larger), accessed from your phone, with scheduled global job scans and an approval workflow.

**Target host:** Hetzner CPX22 (2 vCPU / 4 GB RAM / 80 GB SSD), Ubuntu 22.04 or 24.04, Helsinki or any region. Coolify may already be installed — that is fine. We install career-ops alongside Coolify, directly on the host as a non-root user. Coolify keeps running untouched.

## What this gives you

- Daily automated scan of company career boards (Greenhouse / Lever / Ashby)
- Per-job AI evaluation against your resume
- Tailored CV + cover letter generation as PDF
- Approval flow on your phone — you decide which jobs to apply to
- Persistent, resumable session you reach via a browser PWA on your phone

## Reality check (read first)

**career-ops is a CLI + terminal UI, not a polished mobile app.** The slick "approve/skip" mobile UI you may have seen in screenshots was custom-built by that user — it is not in the public repo. You will be looking at a Bubble Tea TUI through a terminal on your phone. Calibrate expectations.

**The Anthropic Claude mobile app cannot connect to your VPS.** It is a chat client for claude.ai. `claude.ai/code` runs in Anthropic-hosted ephemeral sandboxes that cannot reach your Hetzner box. So "open the Claude app, type /career-ops" is not a path that exists.

**The realistic mobile path:** Tailscale mesh VPN + `ttyd` web terminal + tmux on the VPS. You add the ttyd URL to your phone home screen as a PWA. Tap the icon → you are dropped straight into a persistent Claude Code session running on your VPS. That is as "mobile app"-like as this stack gets today.

**career-ops never auto-submits applications.** It is an authoring and triage tool. You still open the company portal in a normal browser and click submit yourself.

## Prerequisites

- Hetzner Cloud VPS, CPX22 or larger (Ubuntu 22.04 or 24.04 LTS, ≥ 2 GB RAM for Chromium — CPX22 has 4 GB which is plenty)
- Anthropic API key OR Claude Pro/Max subscription
- Your resume (any format — we will convert to markdown)
- A free Tailscale account
- ~2 hours for first-time setup

### If Coolify is already installed

The CPX22 image often ships with Coolify pre-installed (hostname like `coolify-ubuntu-4gb-hel1-1`). Do NOT try to deploy career-ops through Coolify — career-ops is a stateful CLI tool, not a containerized web service, and the fit is bad. We install it directly on the host under a dedicated `career` user. Coolify continues to run, untouched, alongside it.

Three things to be aware of when Coolify is present:
- Port 80, 443, 8000, and 6001/6002 are typically taken by Coolify's reverse proxy and dashboard. Avoid them.
- Docker is already installed (Coolify uses it heavily). You don't need to install Docker again, but we won't use it for career-ops either.
- The default firewall posture is whatever Coolify set. We add Tailscale on top so career-ops is reachable only over the mesh, not via any Coolify-exposed port.

## Guide order

Follow these in sequence. Each file is short and focused.

1. [01-vps-bootstrap.md](01-vps-bootstrap.md) — base OS, user, Node, Go, Playwright deps
2. [02-claude-code-and-career-ops.md](02-claude-code-and-career-ops.md) — install Claude Code CLI and clone career-ops
3. [03-resume-and-config.md](03-resume-and-config.md) — convert resume to markdown, populate profile.yml and portals.yml
4. [04-mobile-access.md](04-mobile-access.md) — Tailscale + ttyd + PWA on your phone
5. [05-scheduled-scanning.md](05-scheduled-scanning.md) — systemd timer for daily portal scans
6. [06-daily-flow.md](06-daily-flow.md) — what you actually do every morning
7. [07-verification.md](07-verification.md) — end-to-end checklist before relying on it
8. [08-troubleshooting.md](08-troubleshooting.md) — common gotchas

## Worldwide jobs caveat

The career-ops scanner is per-company, not geo-search. There is no LinkedIn-style "remote, worldwide" filter. To target jobs globally, you curate `portals.yml` by hand with companies that hire remote-worldwide and use a supported ATS (Greenhouse / Lever / Ashby). Seed sources: weworkremotely, remoteok, YC jobs, Greenhouse public board index, Lever customer list. Plan ~1 hour for v1 of the list.
