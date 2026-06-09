# booking-ops

A personal **client-booking AI agent** for a creative/events business. It reads incoming client
emails from your Gmail, drafts replies in your voice (quoting your packages and real availability),
and alerts you on **Telegram** where you **approve / edit / reject** before anything is sent. It keeps
a lightweight per-client CRM, pushes leads into **Loops.so**, and — when you confirm a deposit or full
payment in Telegram — creates the booking on your **Google Calendar**.

> Full design, setup and operations docs live in [`docs/booking-ops/`](../../docs/booking-ops/).
> Read them in numbered order, starting with `README.md` → `00-overview.md`.

## The stack (minimal)

- **Gmail + Google Calendar** — connected per-account from Telegram via `/connect` (OAuth device flow).
- **Telegram bot** — your control surface (approve replies, confirm payments, manage accounts).
- **Loops.so** — lead store (every booking inquiry becomes a contact + event).
- **Anthropic SDK** — drafts replies (Haiku by default; prompt-cached context).
- No Stripe, no web dashboard, no inbound mail server, no public webhook.

## Layout

```
src/
  index.ts      worker entry: Telegram long-poll + Gmail poll loops
  config.ts     zod-validated env
  paths.ts      workspace paths (off BOOKING_OPS_WORKSPACE)
  lib/          atomicWrite, log, jsonBlock
  google/       device-flow /connect, per-account tokens, gmail, calendar
  loops/        Loops.so lead upsert + events
  telegram/     bot client, update loop, alerts, commands, edit flow
  agent/        drafting (classify + reply + booking facts), prompt caching
  crm/          client records, state machine, dedup, suppression, actions
  flows/        inbound → draft → approve → send; payment → calendar
  distill.ts    one-off: ChatGPT export → context.md
  auth.ts       optional local OAuth fallback
```

## Develop

```bash
pnpm --filter @ai-agents/booking-ops typecheck
pnpm --filter @ai-agents/booking-ops build
BOOKING_OPS_WORKSPACE=./workspace pnpm --filter @ai-agents/booking-ops start
```

See `.env.example` for required environment variables.
