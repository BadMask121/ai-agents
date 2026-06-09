# 06 — ChatGPT context import

The drafting agent writes in **your voice** and answers using **your business facts**. Two files feed
that: `config/packages.yml` (you write it — see [07](07-agent-drafting.md)) and `context.md` (your
"about me / voice / pricing / FAQs", optionally seeded from a ChatGPT export).

> There is **no live ChatGPT memory API**. This is a one-time, refreshable import: you export your
> ChatGPT data and the bot distills it into `context.md`.

## Export from ChatGPT

1. ChatGPT → **Settings → Data controls → Export data**.
2. You'll get an email with a zip. Download and unzip it.
3. Find **`conversations.json`** inside.

## Distill it into `context.md`

```bash
pnpm --filter @ai-agents/booking-ops build
BOOKING_OPS_WORKSPACE=./workspace \
  ANTHROPIC_API_KEY=sk-ant-... \
  node apps/booking-ops/dist/distill.js path/to/conversations.json
```

This runs a **map-reduce** (`src/distill.ts`): it linearizes every conversation, chunks them under a
token budget, extracts business/voice notes per chunk, then merges everything into one `context.md`
with sections: *About me / Business & services / Voice & tone / Pricing & packages / Availability &
booking rules / FAQs*. It uses your `BOOKING_MODEL` (Haiku by default) — cheap, since it's extraction.

## Put `context.md` where the worker reads it

`distill.js` writes to `$BOOKING_OPS_WORKSPACE/context.md`. If you distilled locally but the worker
runs in a container, copy the file into the worker's volume:

```bash
scp ./workspace/context.md root@<host>:/path/to/booking-ops-volume/context.md
# or, into a Coolify named volume:
docker cp ./workspace/context.md <container>:/workspace/booking-ops/context.md
```

## Refreshing

Re-export from ChatGPT and re-run `distill.js` whenever you want to update the voice/context. It
overwrites `context.md`. You can also just hand-edit `context.md` directly — it's plain markdown.

## Prefer to skip the export?

`context.md` is optional. You can write it by hand (a few paragraphs about your business, tone, and
common answers) and rely mostly on `config/packages.yml` for pricing. The agent works with either.

> Large exports: `distill.js` reads the whole `conversations.json` into memory. For very large
> exports this can be heavy; if it struggles, trim the file or split it and run twice, merging the
> resulting `context.md` by hand.
