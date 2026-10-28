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

**End of session:** follow the session completion workflow in `AGENTS.md` (file issues, run quality gates, `git push`). bd is local-only (no Dolt remote, by choice): skip `bd dolt push`.

## Brainstorming — check docs first

Before brainstorming, designing, or proposing plans, read the relevant files under `docs/` (currently `docs/career-ops-vps/`). These capture project intent, constraints, and prior decisions. Do not propose approaches that contradict them without calling out the conflict explicitly.

When a brainstorm produces an agreed plan, immediately capture it as bd issues (epic + sub-tasks with `bd-<id>.<n>` hierarchy) before touching code.

## Hosting

- No VPS. The Hetzner box (Coolify, career-ops-ui) was deleted on 2026-10-28; its data is backed up locally in `~/hetzner-backup-2026-10-28`.
- Every public host is a Cloudflare Worker on the `jeffrey.build` zone, each with its own Worker (and R2 bucket where needed): `jeffrey.build` + `www` (portfolio repo), `mail-mcp` (`apps/mail-mcp`), `prole` (prole repo `site/`), `voxsplit` (voxsplit repo). Deploy with `wrangler deploy` from each project.
