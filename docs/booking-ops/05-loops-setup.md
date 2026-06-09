# 05 — Loops.so setup

Loops is the **lead store**: every genuine booking inquiry becomes a contact, and key moments fire
events you can hook automations to. It's a best-effort side-channel — if Loops is down or rate-limited,
drafting and sending still work; the client is flagged `loopsSynced: false` and retried next poll.

## API key

1. In Loops → **Settings → API** → create an API key.
2. Set `LOOPS_API_KEY` in the worker environment.

(Free tier is generous for a solo business; you only need a paid plan if your contact list grows large.)

## What booking-ops sends

Uses the official **`loops`** npm SDK (`new LoopsClient(LOOPS_API_KEY)`), wrapped in
`src/loops/client.ts` so every call is best-effort and never throws.

**Contact upsert** — `loops.updateContact({ email, properties })` (idempotent on email), on the first
genuine lead. `firstName` / `source` / `userGroup` are sent as contact properties:

```js
loops.updateContact({
  email: "client@x.com",
  properties: { firstName: "Jane", source: "email-inbound", userGroup: "leads" },
});
```

**Events** — `loops.sendEvent({ email, eventName, eventProperties })`:

| Event | Fires when |
|---|---|
| `booking_inquiry` | A new genuine lead is detected. |
| `quote_sent` | You approve and send a reply. |
| `deposit_paid` | You confirm a deposit (booking created). |
| `booking_confirmed` | You confirm paid-in-full. |

## In Loops

- Define a **contact property** `source` and a **user group** `leads` if you want to segment.
- Create **automations** (welcome sequence, follow-up nudges, review requests) triggered by the events
  above. None of this is required for booking-ops to function — it's upside.

> Rate limit is ~10 req/s per team; booking-ops stays well under it and treats any failure as
> non-fatal.
