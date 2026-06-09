# 10 — Roadmap (deferred)

These were deliberately left out of the first version to keep setup minimal. None are required for the
core flow; each can be added without reworking the architecture.

| Idea | Notes |
|---|---|
| **Stripe auto-confirm** | Send a Stripe payment link; a Stripe webhook auto-books on `checkout.session.completed`, removing the manual Telegram tap. Needs a small public webhook endpoint — a deliberate departure from the current "no inbound port" design, so it'd run as a separate tiny service or a Next.js route. Manual confirm stays as the off-platform fallback. |
| **Web dashboard** | A read-only view of the pipeline (leads, quoted, booked) and per-client history. The data already lives in `clients/*.json`; this is presentation only. |
| **Multi-user** | Today it's single-operator (one `TELEGRAM_CHAT_ID`). Supporting a team means per-user auth + routing. |
| **Richer lead scoring** | The current gate is `isBookingLead && confidence ≥ 0.6`. Could add per-source rules, value estimation, or a learned threshold from your Approve/Not-a-lead history. |
| **Gmail push (Pub/Sub)** | Replace polling with Gmail push notifications for near-instant alerts. Adds a Pub/Sub topic + a webhook; polling is simpler and fine at this scale. |
| **Calendar-aware proposals** | Beyond free/busy, suggest specific open slots that fit the requested package duration. |
| **Reminder automations** | Balance-due reminders, day-before confirmations, post-event review requests — partly doable today via Loops automations off the existing events. |
| **Attachments / contracts** | Send a contract PDF or intake form with the quote; capture signed contracts back into the client record. |
| **Multi-timezone clients** | Per-client timezone is stored but not yet inferred from their email; could detect and convert proposed times. |
| **Cross-midnight events** | `buildEventTimes` rolls the date for long events, but very long multi-day bookings would benefit from explicit start/end dates in the facts. |

To pick one up: create a `bd` issue under the booking-ops epic and link it.
