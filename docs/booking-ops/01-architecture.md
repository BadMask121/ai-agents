# 01 — Architecture

## Shape: one resident worker

booking-ops is a **single long-running Node process** (`dist/index.js`), not a web app. It runs three
things concurrently:

- **Telegram loop** (`src/telegram/loop.ts`) — long-polls `getUpdates`, handling commands and
  inline-button callbacks. Long-polling is outbound-only — no Telegram webhook to host.
- **Gmail poll** (`src/flows/inbound.ts`, scheduled in `src/index.ts`) — every
  `GMAIL_POLL_SECONDS` it scans every connected inbox for new mail.
- **OAuth callback server** (`src/oauthServer.ts`) — a small HTTP server on `OAUTH_PORT` serving
  `/oauth/callback` (+ `/healthz`). This is the one public endpoint: Google redirects here after you
  authorize an account from the `/connect` link, and the bot saves the token + DMs you "Connected".
  (Google forbids Gmail/Calendar scopes via the device flow, so the web redirect flow is required.)

A button press has to be *received* somewhere; the long-poller handles that with no Telegram webhook.
The only inbound surface is the OAuth callback, needed because Google must redirect a browser back to
the bot after consent.

## Lanes (who talks to whom)

```
        Gmail ──poll──► inbound flow ──► draft agent (Anthropic) ──► Telegram alert
                              │                                          │
                              └──► Loops (lead upsert + event)           ▼
                                                                  you tap a button
                                                                          │
   approve ──► Gmail send (threaded)      deposit/paid ──► Calendar event (+ Loops event)
```

- The **draft agent** only classifies and writes text — it never sends mail or touches the calendar.
- **Sending** mail and **creating** calendar events happen only after your explicit Telegram tap.
- **Loops** is a non-critical side-effect: a Loops outage never blocks drafting or sending.

## Key modules (`apps/booking-ops/src/`)

| Area | Files | Role |
|---|---|---|
| Bootstrap | `index.ts`, `config.ts`, `paths.ts` | Worker entry, env validation, workspace paths. |
| Google | `google/{deviceAuth,accounts,oauthClient,gmail,calendar}.ts` | `/connect` device flow, per-account tokens, Gmail read/send/label, Calendar free/busy + insert. |
| Agent | `agent/{schema,prompts,draft,extractFacts}.ts` | Structured drafting (prompt-cached) + booking-fact extraction. |
| CRM | `crm/{model,store,dedup,actions,suppression}.ts` | Client records + state machine, message dedup, pending Telegram actions, not-a-lead list. |
| Loops | `loops/client.ts` | Lead upsert + events (best-effort). |
| Telegram | `telegram/{client,loop,alerts,conversation,commands}.ts` | Bot API, dispatcher, alert UI, edit/facts state, slash commands. |
| Flows | `flows/{inbound,approve,payment,availability,handlers}.ts` | The two end-to-end flows + the `ActionHandlers` wiring. |

## Two data flows

**A. Inbound → draft → approve → send** (`flows/inbound.ts` → `flows/approve.ts`)
1. Poll unread → skip if already processed (dedup log + Gmail `booking-ops/seen` label) or sender suppressed.
2. Fetch + parse; load/create the client record (the thread is the agent's memory).
3. Draft with calendar availability + your packages; record the message + extracted facts.
4. Lead-gate: only `isBookingLead && confidence ≥ 0.6` alerts and syncs to Loops.
5. Create a pending action, alert Telegram with buttons.
6. **Approve** → threaded MIME send via Gmail, advance status, mark the alert "Sent". **Edit** →
   force-reply → revised draft → re-confirm → send. **Reject** → dismiss. **Not a lead** → suppress sender.

**B. Payment → calendar** (`flows/payment.ts`)
1. Tap **Deposit received** / **Paid in full** for a client.
2. If booking facts are complete → create the Calendar event on the default account.
3. If facts are missing → force-reply asks for date/time/duration → extracted → event created.
4. Advance status (`deposit-paid` / `paid-in-full`), store `calendarEventId` (double-tap guard),
   fire a Loops event, reply with the event link.

## Decisions & rationale

| Choice | Why |
|---|---|
| Telegram long-poll (no Telegram webhook) | Receives commands + button callbacks with no inbound Telegram surface. |
| Anthropic SDK (not the claude CLI) | Pure text→JSON task; lets us prompt-cache the static context. |
| OAuth **web-callback** flow (`/connect` → phone) | Google forbids Gmail/Calendar scopes via the device flow, so the web redirect flow is required; costs one public callback endpoint (+ domain/TLS). Loopback `auth:local` is the no-public-URL fallback. |
| File-based storage | Mirrors the repo's career-ops-ui pattern; no DB to run. |
| Loops as best-effort | Marketing mirror must never block the reply path. |
