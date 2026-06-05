# ai-agents

A monorepo of personal AI agents and tools. Each member is an independent
product that uses Claude (and other services) to automate a slice of real work
— job applications, booking/email, DJ library prep, and on-screen Q&A.

## Repository layout

```
ai-agents/
├── apps/
│   ├── career-ops-ui/   # Next.js web UI — AI job-application pipeline
│   ├── booking-ops/     # Node worker — AI email/booking agent (Telegram-driven)
│   ├── dj-sync/         # Rust bot — Spotify → Rekordbox prep via Telegram
│   ├── proletariat/     # Rust + Tauri — native macOS "snip → ask Claude" app
│   ├── shared/          # TS library — shared agent types/utils (@ai-agents/shared)
│   └── sample-agent/    # TS example — minimal agent using @ai-agents/shared
├── docs/                # Per-project documentation (see each member below)
├── package.json         # workspace root (pnpm + Turborepo)
├── pnpm-workspace.yaml   # workspace globs: apps/*
├── turbo.json           # build / typecheck / start pipeline
├── tsconfig.base.json   # shared TypeScript config
├── AGENTS.md            # session/agent workflow (bd, quality gates, push)
└── CLAUDE.md            # project rules for AI assistants
```

## Tooling

- **Package manager:** pnpm 10 (workspaces). All TypeScript members live under
  `apps/*` and share a single lockfile.
- **Task runner:** [Turborepo](https://turbo.build) — `turbo run <task>` fans a
  task across members (with caching + topological ordering via `^build`).
- **Languages:** TypeScript (Node 20+) for the web/worker apps and shared libs;
  **Rust** for `dj-sync` and `proletariat`.
- **Shared TS config:** every TS member extends `tsconfig.base.json`
  (ES2022, NodeNext, strict).

> **TS vs Rust members.** `career-ops-ui`, `booking-ops`, `shared`, and
> `sample-agent` are pnpm workspace members (have `package.json`).
> `proletariat` is also a pnpm member (Tauri frontend) **and** contains a Cargo
> project in `src-tauri/`. `dj-sync` is a **standalone Cargo project** (no
> `package.json`) — it is not part of the pnpm/turbo graph and is run directly
> with `cargo`.

## Root commands

Run from the repo root; these operate across all TypeScript members via Turbo:

```bash
pnpm install          # install all workspace deps
pnpm build            # turbo run build      (tsc / next build / vite build)
pnpm typecheck        # turbo run typecheck  (tsc --noEmit)
pnpm start            # turbo run start
pnpm clean            # remove node_modules, dist, .turbo
```

Target a single member with a filter, e.g.:

```bash
pnpm --filter @ai-agents/booking-ops build
pnpm --filter @ai-agents/career-ops-ui dev
```

---

## Members

### `apps/career-ops-ui` — AI job-application pipeline (web)

A Next.js 16 / React 19 web app that drives an AI job-search pipeline: discover
postings, score fit, prepare and iterate application answers (Claude via MCP +
Playwright), and track a pipeline. JWT auth.

- **Stack:** Next.js, React, TypeScript, Tailwind CSS 4, Zod, jose/bcrypt.
- **Package:** `@ai-agents/career-ops-ui`
- **Run:**
  ```bash
  pnpm --filter @ai-agents/career-ops-ui dev      # http://localhost:3000
  pnpm --filter @ai-agents/career-ops-ui build
  pnpm --filter @ai-agents/career-ops-ui start     # -H 0.0.0.0 -p 3000
  ```
- **Entry points:** `src/app/` (routes: `/discover`, `/apply`, `/resume`,
  `/pipeline`, `/settings`, `/api/*`), `src/agents/`, `src/lib/`.
- **Deploy:** Docker → Hetzner VPS (Coolify); see docs.
- **Docs:** [`docs/career-ops-vps/`](docs/career-ops-vps/) (VPS bootstrap,
  Claude Code setup, mobile access, scheduled scanning, deploy checklist).

### `apps/booking-ops` — AI booking/email agent (worker)

A long-running Node worker for a creative/events business: reads incoming Gmail,
drafts replies in your voice using real Calendar availability, asks for approval
over Telegram, upserts leads to Loops.so, and creates Calendar events on payment
confirmation. No web UI — Telegram is the control surface.

- **Stack:** TypeScript, Anthropic SDK (prompt caching), googleapis (Gmail/
  Calendar, device-flow OAuth), Loops.so, Zod.
- **Package:** `@ai-agents/booking-ops` (depends on `@ai-agents/shared`).
- **Run:**
  ```bash
  pnpm --filter @ai-agents/booking-ops build
  pnpm --filter @ai-agents/booking-ops start      # node dist/index.js
  pnpm --filter @ai-agents/booking-ops auth        # one-off OAuth server
  ```
- **Entry points:** `src/index.ts` (worker loop), `src/google/`, `src/telegram/`,
  `src/agent/`, `src/flows/`, `src/crm/`, `src/loops/`.
- **Deploy:** Docker (build context = repo root); outbound-only, no exposed port.
- **Docs:** [`docs/booking-ops/`](docs/booking-ops/) (overview, architecture,
  data model, Google/Telegram setup, Loops, roadmap).

### `apps/dj-sync` — Spotify → Rekordbox prep (Rust bot)

A Telegram bot that takes Spotify/song links, matches them against your local
music library (ISRC → fuzzy → optional AI), builds Rekordbox autoimport XML, and
can sync to USB.

- **Stack:** Rust 2021, tokio, teloxide (Telegram), reqwest, lofty, quick-xml,
  optional Anthropic SDK for match fallback.
- **Standalone Cargo project** (not in the pnpm workspace).
- **Run (from `apps/dj-sync/`):**
  ```bash
  cargo run                 # start the bot
  cargo test                # matcher / URL-parsing tests
  cargo build --release
  ```
- **Entry point:** `src/main.rs`; key modules `matcher.rs`, `library.rs`,
  `spotify.rs`, `rekordbox.rs`, `bot.rs`.
- **Config:** `.env` (Telegram/Spotify/Anthropic) + `~/.dj-sync/config.toml`
  (library roots, Rekordbox dir, USB mount).
- **Docs:** [`docs/dj-sync/`](docs/dj-sync/) (architecture, flow, stack
  decisions, Rekordbox design).

### `apps/proletariat` — "snip → ask Claude" (Rust + Tauri, macOS)

A native macOS menu-bar app: capture a screen region (`screencapture`), mark it
up (rectangle / arrow / pen / on-image text), and copy the annotated image to
the clipboard to paste into the Claude desktop app. Floating capture button +
global hotkey.

- **Stack:** Rust + Tauri v2, `clipboard-rs`, `image`; TypeScript + Vite + Vitest
  frontend. Cargo project lives in `src-tauri/` (toolchain pinned to 1.90).
- **Package:** `proletariat` (pnpm member for the frontend).
- **Run (from `apps/proletariat/`):**
  ```bash
  pnpm install
  pnpm tauri dev            # build + launch the app (menu-bar; no main window)
  pnpm test                 # frontend unit tests (vitest)
  pnpm test:rust            # cargo test (capture + clipboard)
  ```
  First capture needs macOS **Screen Recording** permission.
- **Docs:** [`docs/proletariat/`](docs/proletariat/) (README, architecture,
  stack decisions, roadmap, implementation plan) and `apps/proletariat/QA.md`.

### `apps/shared` — shared agent types (`@ai-agents/shared`)

A small TypeScript library of common agent types and helpers — `AgentRole`,
`ChatMessage`, `AgentRunInput`, and `createRunId()`. Consumed by `booking-ops`
and `sample-agent` via `workspace:*`.

- **Run:** `pnpm --filter @ai-agents/shared build`
- **Entry point:** `src/index.ts`.

### `apps/sample-agent` — minimal example (`@ai-agents/sample-agent`)

A reference agent showing how a member consumes `@ai-agents/shared`. Use it as a
template for new TS agents.

- **Run:** `pnpm --filter @ai-agents/sample-agent build && pnpm --filter @ai-agents/sample-agent start`
- **Entry point:** `src/index.ts`.

---

## Conventions

- **Task tracking:** this repo uses **bd (beads)** as the single source of truth
  for work. Run `bd ready` to see available work; every code change gets a `bd`
  issue. See [`CLAUDE.md`](CLAUDE.md).
- **Documentation:** project docs live under `docs/<project>/` as numbered
  guides. Read the relevant docs before changing a project.
- **Session workflow:** see [`AGENTS.md`](AGENTS.md) for the end-of-session
  workflow (file issues, quality gates, `bd dolt push`, `git push`).

## Documentation index

| Project | Docs |
| --- | --- |
| career-ops-ui | [`docs/career-ops-vps/`](docs/career-ops-vps/) |
| booking-ops | [`docs/booking-ops/`](docs/booking-ops/) |
| dj-sync | [`docs/dj-sync/`](docs/dj-sync/) |
| proletariat | [`docs/proletariat/`](docs/proletariat/) |
| shared / sample-agent | (documented inline above) |
