# 07 — The drafting agent

`src/agent/draft.ts` turns one inbound email into a structured result via the Anthropic SDK.

## Output (structured, validated)

Uses `messages.parse()` + `zodOutputFormat` (schema in `src/agent/schema.ts`), so the model is
constrained to valid JSON — no brittle parsing:

```ts
{
  classification: "new_inquiry" | "follow_up" | "payment" | "other",
  isBookingLead: boolean,
  confidence: number,            // 0–1
  draftReply: string,            // in your voice
  proposedSlots: string[],
  extractedFacts: { eventType, eventDate, startTime, durationMinutes, endTime,
                    timezone, package, budget, location, depositAmount, balanceDue, notes }
}
```

The inbound flow alerts you only when `isBookingLead && confidence ≥ 0.6`; everything else is handled
silently (marked seen, no Telegram noise). Extracted facts are merged into the client record.

## What the prompt contains

- **System (static, cached)** — role + your `context.md` + `config/packages.yml`. The agent is told to
  quote real prices from the packages section, only offer dates listed as free in the availability
  block, match your voice, and be conservative about what counts as a lead.
- **User (volatile)** — this client's thread history (memory), the new email, the timezone, and the
  **availability** the flow computed from your calendar (`flows/availability.ts` → free/busy).

## `config/packages.yml`

You maintain this; the agent quotes from it. Suggested shape:

```yaml
packages:
  - name: Half-day photography
    price: "£650"
    deposit: "£200"
    includes: "Up to 4 hours, 60 edited images, online gallery"
    typical_duration_minutes: 240
  - name: Wedding film
    price: "from £1,800"
    deposit: "30%"
    includes: "Full-day coverage, 5–7 min highlight film"
booking_rules: |
  Deposit secures the date. Balance due 2 weeks before the event. Travel beyond 30 miles billed at cost.
```

It's free-form YAML — the agent reads it as text, so write it for a human.

## Prompt caching

The system prefix (`context.md` + packages, often 5–15k tokens) is marked
`cache_control: { type: "ephemeral" }` and placed first; the per-email content goes last, uncached.
During a burst of inquiries the static prefix is a cache hit (5-min TTL), so most calls pay the cheap
cached-read rate. Keep `context.md`/`packages.yml` byte-stable to preserve the cache; edits invalidate
it (the next call re-writes it — expected).

## Model & cost

Default `BOOKING_MODEL=claude-haiku-4-5-20251001` — replies are short and voice-driven, so Haiku is
plenty and cheap. Switch to a stronger model via the env var if you want richer drafts.

Rough cost (Haiku, ~9k cached prefix + ~2k volatile in, ~600 out): **~$0.006 warm / ~$0.014 cold** per
email → **~$2–6/month** for a typical 10–30 emails/day inbox, plus a **one-time ~$3–5** for the ChatGPT
distillation. Google + Telegram + Loops (free tiers) and the shared VPS add ~$0. See the plan's cost
analysis for the full table.

> Haiku doesn't accept `thinking`/`effort` params — `draft.ts` deliberately omits them. If you switch
> `BOOKING_MODEL` to an Opus/Sonnet tier you can add those, but it isn't necessary for drafting.
