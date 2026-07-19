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
│   ├── mail-mcp/        # Node MCP server — ChatGPT ⇄ privateemail mailbox (IMAP/SMTP)
│   ├── dj-sync/         # Rust bot — Spotify → Rekordbox prep via Telegram
│   ├── prole-site/     # Static landing page for Prole (deployed via Coolify)
│   ├── prole-promo/     # Remotion promo video for Prole
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
  **Rust** for `dj-sync`. (The Prole macOS app, also Rust + Tauri, now lives in
  its own repo: [github.com/BadMask121/prole](https://github.com/BadMask121/prole).)
- **Shared TS config:** every TS member extends `tsconfig.base.json`
  (ES2022, NodeNext, strict).

> **TS vs Rust members.** `career-ops-ui`, `booking-ops`, `shared`, and
> `sample-agent` are pnpm workspace members (have `package.json`).
> `dj-sync` is a **standalone Cargo project** (no `package.json`) — it is not
> part of the pnpm/turbo graph and is run directly with `cargo`.

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

### `apps/mail-mcp` — ChatGPT ⇄ privateemail mailbox (MCP server)

A remote **MCP server** (Streamable HTTP) that gives **ChatGPT** read/send/manage
access to a Namecheap **Private Email** (Open-Xchange) mailbox over standard
**IMAP/SMTP** — no web-UI scraping. ChatGPT connects it as a custom connector in
Developer Mode.

- **Stack:** TypeScript, `@modelcontextprotocol/sdk` (Streamable HTTP), `imapflow`,
  `nodemailer`, `mailparser`, Express, Zod. Unit-tested with Vitest.
- **Package:** `@ai-agents/mail-mcp`
- **Tools:** `list_folders`, `search_email`, `list_messages`, `read_email`,
  `get_attachment`, `send_email`, `move_email`, `delete_email`, `mark_email`,
  plus read-only `search`/`fetch` aliases for standard connector mode.
- **Run:**
  ```bash
  pnpm --filter @ai-agents/mail-mcp dev        # http://localhost:8080/<secret>/mcp
  pnpm --filter @ai-agents/mail-mcp typecheck
  pnpm --filter @ai-agents/mail-mcp test
  ```
- **Live:** <https://mail-mcp.jeffrey.build> (Coolify on Hetzner, TLS via Let's
  Encrypt). Auth is a long random secret path + TLS; env-var mailbox credentials.
- **Deploy:** Dockerfile (context = `apps/mail-mcp`). Auto-deploys on push to
  `apps/mail-mcp/**` (branch `mail-mcp`) via
  [`.github/workflows/deploy-mail-mcp.yml`](.github/workflows/deploy-mail-mcp.yml).
- **Docs:** [`docs/mail-mcp/`](docs/mail-mcp/) (product overview, tool reference,
  ChatGPT connect + deploy steps).

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

### Prole — "snip → paste anywhere" (moved to its own repo)

The Prole macOS app now lives in its own open-source repo:
**[github.com/BadMask121/prole](https://github.com/BadMask121/prole)** (MIT). This
monorepo keeps the two Prole-related pieces that ship from here:

- [`apps/prole-site/`](apps/prole-site/) — the landing page at
  [prole.jeffrey.build](https://prole.jeffrey.build), deployed via Coolify.
- [`apps/prole-promo/`](apps/prole-promo/) — the Remotion promo video.

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
| prole | [github.com/BadMask121/prole](https://github.com/BadMask121/prole) (own repo) |
| shared / sample-agent | (documented inline above) |
