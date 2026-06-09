# booking-ops

A personal **client-booking AI agent** for a creative/events business (photo / video / DJ). It reads
incoming client emails from Gmail, drafts replies in your voice (quoting your real packages and
checking your calendar for availability), and alerts you on **Telegram** where you **approve / edit /
reject** before anything is sent. It keeps a lightweight per-client CRM, pushes leads into
**Loops.so**, and — when you confirm a deposit or full payment in Telegram — creates the booking on
your **Google Calendar**.

Implementation lives in [`apps/booking-ops/`](../../apps/booking-ops/).

## The stack (minimal)

- **Gmail + Google Calendar** — connected per-account from Telegram via `/connect` (OAuth device flow).
- **Telegram bot** — your only control surface (approve replies, confirm payments, manage accounts).
- **Loops.so** — lead store (every booking inquiry becomes a contact + event).
- **Anthropic SDK** — drafts replies (Haiku by default; the static context is prompt-cached).
- No Stripe, no web dashboard, no inbound mail server. The only public surface is a single OAuth
  callback (`/oauth/callback`) used by the Telegram `/connect` flow; Telegram itself long-polls.

## Read these in order

| # | File | What it covers |
|---|------|----------------|
| — | [00-overview.md](00-overview.md) | What it does end-to-end and the confirmed product decisions. |
| 1 | [01-architecture.md](01-architecture.md) | Resident-worker design, the lanes, and the data flows. |
| 2 | [02-data-model.md](02-data-model.md) | CRM record, status state machine, booking facts, dedup, suppression. |
| 3 | [03-google-setup.md](03-google-setup.md) | Google Cloud project, APIs, OAuth device client, scopes. |
| 4 | [04-telegram-setup.md](04-telegram-setup.md) | BotFather, chat id, commands, the `/connect` device flow. |
| 5 | [05-loops-setup.md](05-loops-setup.md) | Loops API key, contact properties, events. |
| 6 | [06-chatgpt-context.md](06-chatgpt-context.md) | Export ChatGPT, run `distill`, and how `context.md` works. |
| 7 | [07-agent-drafting.md](07-agent-drafting.md) | Classification, pricing, availability, prompt caching, cost. |
| 8 | [08-deployment.md](08-deployment.md) | Dockerfile, Coolify service, the systemd alternative. |
| 9 | [09-operations.md](09-operations.md) | Day-to-day use, re-auth, logs, troubleshooting. |
| 10 | [10-roadmap.md](10-roadmap.md) | What's deliberately deferred. |

## Quickstart (TL;DR)

1. Create a Google Cloud OAuth "Limited Input device" client → `03`.
2. Create a Telegram bot, get your chat id → `04`.
3. Create a Loops API key → `05`.
4. Deploy the worker (Coolify, no port, a volume) → `08`.
5. DM the bot `/connect` for each Gmail account; `/setcalendar` to pick the booking calendar → `04`.
6. Fill `config/packages.yml`; optionally seed `context.md` from a ChatGPT export → `06`, `07`.
7. Email yourself a test inquiry and approve the draft from Telegram → `09`.
