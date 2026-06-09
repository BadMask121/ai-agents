# 00 — Overview

## The problem

You run a creative/events business and client booking happens over email. Every inquiry needs a
timely, on-brand reply that quotes the right package and a real open date; payments need to turn into
calendar holds; and leads should land in your marketing tool. Doing this by hand is slow and easy to
drop. booking-ops automates the busywork while keeping **you** in control of anything client-facing.

## What it does, end to end

1. **Connect** one or more Gmail/Calendar accounts from Telegram (`/connect`).
2. **Read** new client emails (polls every ~90s across all connected inboxes).
3. **Classify + draft** — Claude decides if it's a genuine booking lead, drafts a reply in your voice
   quoting your packages and only offering dates your calendar shows free, and extracts booking facts.
4. **Alert** you on Telegram with the client's message and the suggested reply, plus buttons.
5. **You decide** — Approve (sends the threaded reply via Gmail), Edit (revise then approve), Reject,
   or "Not a lead" (suppresses that sender). Nothing is sent without your tap.
6. **Lead sync** — genuine leads are upserted into Loops.so as contacts with a `booking_inquiry` event.
7. **Book** — when payment lands, tap "Deposit received" or "Paid in full"; the bot creates the
   Google Calendar event (asking you for the date/time if it doesn't already have them).

## Confirmed product decisions

| Decision | Choice |
|---|---|
| Email source | **Gmail** (multi-account), connected from Telegram via OAuth device flow. |
| Reply control | **Approve / edit / reject in Telegram** — human in the loop, nothing auto-sends. |
| Lead filter | **AI classifies everything**; only high-confidence leads alert + sync. A one-tap "Not a lead" suppresses a sender. |
| Availability | Bot checks **Google Calendar free/busy** before offering dates. |
| Payment → booking | **Manual confirm in Telegram**: deposit confirms the booking; "paid in full" is the single-payment path. No payment integration. |
| Pricing | Bot quotes **real prices** from a `config/packages.yml` you maintain. |
| Context | Imported once from a **ChatGPT export**, distilled into `context.md` (no live ChatGPT API exists). |
| Lead store | **Loops.so** (contact upsert + events). |

## What it is NOT (by design)

No Stripe/payment processing, no web dashboard, no inbound mail server, no public webhook, no
auto-send. These are deferred — see [10-roadmap.md](10-roadmap.md).
