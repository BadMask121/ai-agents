# 02 — Data model

All state is **file-based** under `BOOKING_OPS_WORKSPACE` (default `/workspace/booking-ops`), written
atomically (tempfile + rename). No database.

## Workspace layout

```
context.md                     distilled "about me / voice / pricing / FAQs" (read every draft)
config/packages.yml            your packages + prices (you maintain this)
google-accounts/<email>.json   per-account OAuth refresh token (perms 600)
settings.json                  { defaultCalendarAccount }
clients/<clientId>.json        one CRM record per client
actions/<actionId>.json        pending Telegram actions (button context)
suppressed.json                { emails: [...] }  — "not a lead" senders
conversation-state.json        per-chat awaiting-edit / awaiting-booking-facts state
processed-messages.tsv         dedup log of handled Gmail message ids
telegram-offset.txt            getUpdates offset cursor
logs/
```

## Client record (`crm/model.ts`)

`clientId = sha1(lower(email)).slice(0,16)` — the same address always maps to one record.

```ts
ClientRecord {
  id, email, name,
  status,                 // state machine below
  accountEmail,           // which Google account received the thread (replies send from it)
  gmailThreadId,
  thread: [{ role: "client"|"user", text, gmailMessageId?, ts }],  // the agent's memory
  bookingFacts: { eventType, eventDate, startTime, durationMinutes, endTime, timezone,
                  package, budget, location, depositAmount, balanceDue, notes },
  lastDraft, calendarEventId, loopsSynced,
  createdAt, updatedAt,
}
```

## Status state machine

```
new ──► quoted ──► awaiting-payment ──► deposit-paid ──► booked
                          │                   │
                          └──► paid-in-full ◄─┘
   (any) ──► lost / other
```

`crm/model.ts` exports a `TRANSITIONS` table and `assertTransition()` that throws on invalid moves —
the same guard pattern as career-ops-ui's `applySession.ts`. The inbound flow advances `new → quoted`
on approve; payment confirmation sets `deposit-paid` / `paid-in-full` authoritatively.

## Booking facts → calendar

`hasMinimumBookingFacts()` requires `eventDate` + `startTime` + (`durationMinutes` or `endTime`).
The payment flow (`flows/payment.ts → buildEventTimes`) turns these into RFC3339 `start`/`end` with an
explicit IANA `timeZone` (`bookingFacts.timezone` or `BOOKING_TIMEZONE`). Times are never naive.

## Dedup & idempotency

- **Dedup** (`crm/dedup.ts`): a message id is handled at most once — checked against
  `processed-messages.tsv` *and* the Gmail `booking-ops/seen` label (double guard). The query also
  filters `-from:me` so our own replies don't re-trigger.
- **Actions** (`crm/actions.ts`): button `callback_data` is only `verb:<shortId>` (Telegram caps it
  at 64 bytes); the full context lives in `actions/<id>.json`. Approve is a no-op if already `sent`.
- **Calendar**: a client with a `calendarEventId` is never re-booked (double-tap guard).

## Suppression (`crm/suppression.ts`)

Tapping "Not a lead" adds the sender to `suppressed.json`; future emails from them are dropped
silently, so the classifier self-corrects over time.
