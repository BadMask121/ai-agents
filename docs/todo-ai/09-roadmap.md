# 09 — Roadmap

## v1 — what's being built

Tracked as bd epic **`ai-agents-z3w`**, ten sub-issues:

| bd | Work |
|---|---|
| `.1` | Scaffold — package.json, tsconfig, config, Express boot |
| `.2` | Schemas, recurrence engine, JSON store (+ Vitest) |
| `.3` | `/api/todos` CRUD + recurrence-aware complete |
| `.4` | Single-user auth (jose JWT cookie + requireAuth) |
| `.5` | Claude layer — `parseTodo` via structured outputs + `/api/ai/parse` |
| `.6` | Client core — quick-add with editable AI draft, list, styles |
| `.7` | Deepgram voice — `/api/voice/transcribe` + MediaRecorder client |
| `.8` | Calendar — month/week grid, drag-to-reschedule |
| `.9` | AI subtask breakdown + plan-my-day |
| `.10` | Dockerfile, README, `.env.example` |

Dependencies funnel through `.1`; after it closes, `.2` and `.4` open in parallel.
`bd ready` is authoritative.

## Deferred, with the upgrade path already known

These are deliberate v1 omissions, not oversights. Each is written down with its trigger
and its cost so the decision doesn't have to be re-litigated from scratch.

### Live streaming transcription

**Now:** batch — record, stop, upload, transcribe (~1s).
**Trigger:** the recording→transcript gap feels slow in daily use, or utterances get long
enough that no feedback is uncomfortable.
**Path:** Deepgram's live WebSocket API. The browser can't hold the key, so either proxy
the socket through the server or mint short-lived tokens (`POST /v1/auth/grant`, ~30s
TTL) and connect directly. Then reconcile interim vs final results client-side.
**Cost:** contained to `voice.js` + one route/socket handler. Real, but bounded.

### SQLite instead of the JSON file

**Now:** one JSON document, atomic writes, single writer.
**Trigger:** more than one writer (a second device, a background job), or the document
getting large enough that a full rewrite per mutation is noticeable — realistically
thousands of todos.
**Path:** `store.ts` is the only module that touches the filesystem, so this is one file.
Prefer `node:sqlite` (built in, stable from Node 24) over `better-sqlite3` to keep the
alpine base and avoid the missing-musl-prebuild problem.

### Google Calendar sync

**Explicitly out of scope for v1** — settled with the user: built-in view only.
**Path if it returns:** `apps/booking-ops/src/google/` already has the OAuth client,
free/busy query, and event creation, against the same Google project pattern. The work is
token storage and a sync loop, not integration from zero. Read-only overlay (show Google
events alongside todos, never write) is a much cheaper half-step than two-way sync and
covers most of the actual need: scheduling around existing commitments.

### Notifications and reminders

**Path:** Web Push needs a service worker, VAPID keys, and a server-side scheduler — the
first thing in this app that needs a background process rather than request/response.
Worth pricing properly before starting; it's the largest of the deferred items.

### Multi-user

**Path:** a real user table, per-user data scoping, and a session model beyond one
password. This is also the point where the no-framework client stops paying for itself —
concurrent editing and live state are what frameworks are actually for. Treat "multi-user"
and "adopt a framework" as one decision, not two.

### Offline / PWA

**Path:** service worker + a local queue that replays mutations on reconnect. Conflict
resolution is the hard part, and it's much harder against a JSON file than against SQLite
— so this one is gated behind the storage swap above.

## Ideas not committed to

Recorded so they're not lost, and not planned:

- **Natural-language search** — "what's overdue for work?" as a query, not a filter.
- **Weekly review** — Claude summarising what got done and what kept slipping.
- **Smart re-scheduling** — noticing a todo has been pushed four times and asking whether
  it's actually going to happen.
- **Email/Telegram capture** — forward a mail, get a todo. `booking-ops` already has both
  transports.
- **Effort estimates** — have the parser guess a duration so `planDay` can build tighter
  blocks. Cheap to add, and it would measurably improve the plan quality.

## Known risks

| Risk | Mitigation |
|---|---|
| **Parser invents due dates** — the most damaging failure mode; silently fills Today with things you never scheduled | Explicit prompt rule; "buy milk" is a permanent test case; the draft row means it's always visible before it's saved |
| **DST/month-end recurrence bugs** — surface weeks later, when a bill was never due | `recurrence.ts` is pure and over-tested; local wall-clock reconstruction rather than `+86400000` |
| **Deepgram model name drifts** (nova-2 → nova-3 → …) | Verify at implementation; a stale name is a runtime error, so it fails loudly on first use |
| **Deployed without TLS** → mic silently dead | Documented in [07](07-deployment.md); feature-detect and say so in the UI rather than failing as a null deref |
| **Unauthenticated transcribe route** → someone else's metered API | `requireAuth` + 10MB limit, both treated as load-bearing |
| **Docs drift from code** | When the build lands, correct these files rather than leaving them aspirational — the status banner in [README](README.md) comes off at the same time |
