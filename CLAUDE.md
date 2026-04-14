# Project Rules

## Beads (bd) — MANDATORY

This project uses **bd (beads)** for ALL task tracking. No exceptions.

**Start of every session:**
1. Run `bd ready` to see available work.
2. Run `bd prime` if you need the full workflow/command reference.
3. If the dolt server isn't running, start it before any bd command.

**For ANY code change or agreed-upon plan:**
- A `bd` issue MUST exist before code is written. If none exists, create one with `bd create "<title>" -p <priority>` and `--claim` it.
- Link dependencies with `bd dep add <child> <parent>` when work blocks or relates to other issues.
- Update status as you go: `bd update <id> --claim` when starting, `bd close <id>` when done.
- Do NOT use TodoWrite, TaskCreate, or markdown TODO lists for project work — bd is the single source of truth.
- Do NOT skip bd "just for a small change." Every change gets an issue.

**End of session:** follow the session completion workflow in `AGENTS.md` (file issues, run quality gates, `bd dolt push`, `git push`).

## Brainstorming — check docs first

Before brainstorming, designing, or proposing plans, read the relevant files under `docs/` (currently `docs/career-ops-vps/`). These capture project intent, constraints, and prior decisions. Do not propose approaches that contradict them without calling out the conflict explicitly.

When a brainstorm produces an agreed plan, immediately capture it as bd issues (epic + sub-tasks with `bd-<id>.<n>` hierarchy) before touching code.

## VPS access

- Host: `ssh root@95.217.185.93` (Hetzner, runs career-ops-ui via Coolify).
- `career-ops` checkout lives at `/home/career/work/career-ops`, owned by the `career` user — run git/file ops via `sudo -u career ...`, not as root (root triggers git's "dubious ownership" guard).
- `career-ops` remote `origin` points to our fork `https://github.com/BadMask121/career-ops.git` (HTTPS, public — no auth needed for fetch). The `career` user has no GitHub SSH key, so do not switch to `git@github.com:...` URLs without first installing a deploy key.
