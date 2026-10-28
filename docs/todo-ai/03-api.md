# 03 — HTTP API

Same origin, cookie auth. Every body is validated with a zod schema from `schemas.ts`;
a validation failure is `400 { "error": "<message>" }`. `requireAuth` guards everything
under `/api` except `/api/auth/login`.

## Summary

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | `public/index.html` (static) |
| `GET` | `/healthz` | Liveness — unauthenticated |
| `POST` | `/api/auth/login` | Password → session cookie |
| `POST` | `/api/auth/logout` | Clear the cookie |
| `GET` | `/api/todos` | List, with filters and virtual occurrences |
| `POST` | `/api/todos` | Create |
| `PATCH` | `/api/todos/:id` | Partial update |
| `DELETE` | `/api/todos/:id` | Delete |
| `POST` | `/api/todos/:id/complete` | Recurrence-aware completion |
| `POST` | `/api/todos/:id/subtasks` | AI breakdown → **proposals**, not rows |
| `POST` | `/api/voice/transcribe` | Audio → transcript |
| `POST` | `/api/ai/parse` | Text → TodoDraft |
| `POST` | `/api/ai/plan` | Date → DayPlan |

---

## Auth

### `POST /api/auth/login`

```jsonc
// request
{ "password": "…" }
// 200 — sets todo_ai_session (httpOnly, sameSite=lax, secure in production)
{ "ok": true }
// 401
{ "error": "invalid password" }
```

Rate-limit this route (a fixed window is enough — it's one user). A single-password login
with no limiter is an open brute-force target the moment it's deployed.

### `POST /api/auth/logout`
`204`, cookie cleared.

---

## Todos

### `GET /api/todos`

| Query | Type | Meaning |
|---|---|---|
| `status` | `open` \| `done` \| `all` | Default `all` |
| `from`, `to` | ISO date | Window filter on `dueAt`. **When both are present, virtual recurring occurrences are included.** |
| `parentId` | id \| `null` | `null` returns only top-level todos |

```jsonc
// 200
{
  "todos": [
    { "id": "…", "title": "Lunch with Sam", "dueAt": "…", /* … */ },
    { "id": "…", "title": "Pay rent", "dueAt": "2026-09-01T…", "virtual": true }
  ]
}
```

`virtual: true` items are **not** persisted rows — they're expansions of a recurrence rule
inside the requested window. They carry the parent todo's `id`. Clients must not PATCH or
DELETE them; the calendar disables dragging for them.

### `POST /api/todos`

Body is a `TodoDraft` (see [04-ai-integration](04-ai-integration.md)). Server assigns
`id`, `sortOrder`, `createdAt`, `updatedAt`; `status` defaults to `open`.

```jsonc
// request
{ "title": "Buy milk", "priority": "low", "dueHasTime": false, "tags": [] }
// 201
{ "todo": { "id": "…", /* … */ } }
```

### `PATCH /api/todos/:id`

Any subset of the mutable fields. Server always refreshes `updatedAt`.
`404 { "error": "not found" }` for an unknown id.

Setting `status: "done"` directly bypasses recurrence handling — that's intentional, it's
how you kill a recurring todo outright. Use `/complete` for normal completion.

### `DELETE /api/todos/:id`

`204`. Deleting a parent **cascades to its subtasks** — otherwise they'd be orphaned rows
with a dangling `parentId`. The response body names the count so the UI can say
"deleted 1 todo and 4 subtasks":

```jsonc
// 200
{ "deleted": 1, "subtasksDeleted": 4 }
```

### `POST /api/todos/:id/complete`

No body. Behaviour depends on `recurrence`:

```jsonc
// non-recurring → 200
{ "todo": { "status": "done", "completedAt": "…" } }

// recurring, rule continues → 200
{ "todo": { "status": "open", "dueAt": "<next occurrence>" }, "advanced": true }

// recurring, until/count exhausted → 200
{ "todo": { "status": "done", "completedAt": "…" }, "advanced": false }
```

Idempotency: completing an already-`done` non-recurring todo is a no-op `200`, not an
error. Double-taps on a phone shouldn't 4xx.

---

## AI routes

All three can fail on the upstream vendor. Shared error contract:

| Status | Meaning | Client should |
|---|---|---|
| `422` | Model returned unparseable/`null` output. Body carries `raw`. | Fall back — save as a plain title |
| `429` | Upstream rate limit | Offer retry; say it's temporary |
| `503` | Upstream connection failure | Offer retry |
| `502` | Any other upstream API error | Show the message |

### `POST /api/ai/parse`

```jsonc
// request
{ "text": "lunch with Sam next Tuesday 1pm high priority",
  "timezone": "Europe/London" }
// 200
{ "draft": {
    "title": "Lunch with Sam",
    "notes": null,
    "priority": "high",
    "dueAt": "2026-08-11T12:00:00.000Z",
    "dueHasTime": true,
    "tags": [],
    "recurrence": null
} }
// 422
{ "error": "could not parse", "raw": "…model text…" }
```

`timezone` is **required** — an IANA name from
`Intl.DateTimeFormat().resolvedOptions().timeZone`. "Next Tuesday 1pm" is unresolvable
without it, and defaulting to the server's timezone silently produces wrong dates for a
travelling user.

This route **never writes**. It returns a draft for confirmation.

### `POST /api/todos/:id/subtasks`

```jsonc
// request — no body
// 200
{ "proposals": [
    { "title": "Register the domain", "priority": "high" },
    { "title": "Write landing copy",  "priority": "medium" }
] }
```

Returns *proposals*. The client shows the checklist; confirming it issues normal
`POST /api/todos` calls with `parentId` set. `409` if the todo already has a `parentId`
(no nested breakdown).

### `POST /api/ai/plan`

```jsonc
// request
{ "date": "2026-08-11", "timezone": "Europe/London" }
// 200
{ "plan": { "blocks": [
    { "start": "09:00", "end": "10:30", "todoId": "…", "label": "Deep work: draft the spec" }
] } }
```

Cached in `dayPlans[date]`. Re-requesting returns the cache; `?refresh=1` regenerates.
Blocks are local wall-clock `HH:MM` — they're a suggestion for a human reading a day, not
scheduled instants.

---

## Voice

### `POST /api/voice/transcribe`

Mounted with `express.raw({ type: ['audio/*'], limit: '10mb' })` — **not**
`express.json()`.

```
Content-Type: audio/webm;codecs=opus     ← whatever recorder.mimeType reported
Body: raw audio bytes
```

```jsonc
// 200
{ "transcript": "lunch with Sam next Tuesday one pm high priority" }
// 413
{ "error": "audio too large (limit 10mb)" }
// 415
{ "error": "unsupported content type" }
```

Returns the transcript and stops. It deliberately does **not** chain into `/api/ai/parse`
server-side: keeping them separate lets the user fix a misheard word before the parse runs,
and lets each route be tested on its own.

The size limit and `requireAuth` are both load-bearing here — Deepgram bills per minute of
audio, so this is the one route where an unauthenticated caller could run up a bill.

---

## Conventions

- **Errors** are always `{ "error": string }`, never a bare string or an HTML page. The
  Express error handler is registered last and coerces anything that escapes.
- **Timestamps** in and out are ISO-8601 UTC with milliseconds.
- **IDs** are nanoid; never assume ordering from them.
- **Unknown body fields** are stripped by zod, not rejected — a newer client against an
  older server degrades rather than 400s.
