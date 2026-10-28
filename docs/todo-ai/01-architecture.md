# 01 — Architecture

## Components

```
┌─────────────────────────────────────────────────────────────┐
│ Browser — public/                                           │
│                                                             │
│  index.html      one page, three panes (Today/Calendar/Plan)│
│  styles.css      CSS custom properties, grid                │
│  js/app.js       boot, pane switching                       │
│  js/api.js       fetch() wrapper over /api/*                │
│  js/quickadd.js  input + mic + editable draft row           │
│  js/voice.js     getUserMedia → MediaRecorder → upload      │
│  js/todos.js     list render, complete, edit, delete        │
│  js/calendar.js  month/week grid, drag-to-reschedule        │
│  js/plan.js      plan-my-day pane                           │
└───────────────────────────┬─────────────────────────────────┘
                            │ fetch, same origin, cookie auth
┌───────────────────────────▼─────────────────────────────────┐
│ Server — apps/todo-ai/src/  (Express + TypeScript)          │
│                                                             │
│  index.ts       boot: load store → start server             │
│  server.ts      routes, static mount, error handler         │
│  config.ts      env parse + validate + freeze               │
│  auth.ts        bcrypt compare, jose JWT, requireAuth       │
│  schemas.ts     zod schemas — the shared contract           │
│  store.ts       the ONLY filesystem writer                  │
│  recurrence.ts  pure date math (no I/O, fully tested)       │
│  claude.ts      parseTodo · breakdown · planDay             │
│  deepgram.ts    transcribe(buffer, mimeType)                │
└─────┬───────────────────┬──────────────────┬────────────────┘
      │                   │                  │
      ▼                   ▼                  ▼
  todos.json        api.deepgram.com    api.anthropic.com
  (atomic write)     (prerecorded)       (messages.parse)
```

## Module boundaries

The layering rule is one line: **`recurrence.ts` and `schemas.ts` are pure, `store.ts`
owns I/O, `claude.ts` and `deepgram.ts` own the network, `server.ts` owns HTTP.** Nothing
reaches across.

| Module | Depends on | Never touches |
|---|---|---|
| `schemas.ts` | zod | anything else — it's the bottom of the graph |
| `recurrence.ts` | `schemas.ts` (types only) | fs, network, `Date.now()` in pure helpers |
| `store.ts` | `schemas.ts`, `recurrence.ts`, `node:fs` | HTTP, AI vendors |
| `claude.ts` | `schemas.ts`, `@anthropic-ai/sdk` | the store — it returns drafts, it does not save |
| `deepgram.ts` | `@deepgram/sdk` | the store, Claude |
| `server.ts` | all of the above | fs directly |

`claude.ts` not touching `store.ts` is deliberate and load-bearing: it's what makes
"AI output is always a draft" a structural property rather than a convention someone can
forget. The AI layer *cannot* write to the database, because it has no reference to it.

`recurrence.ts` taking no clock is what makes it testable — every function takes the
reference date as an argument rather than calling `Date.now()` internally, so DST and
month-end cases are ordinary unit tests instead of time-mocking exercises.

## Request flows

### Voice quick-add — the full path

```
 1. user taps mic
 2. voice.js:  getUserMedia({audio:true}) → new MediaRecorder(stream)
 3. user taps stop (or silence auto-stop fires)
 4. voice.js:  Blob(chunks) → POST /api/voice/transcribe
                              Content-Type: recorder.mimeType   ← not hardcoded
 5. server:    express.raw() → deepgram.transcribe(buf, mime)
 6. server:    → { transcript: "lunch with Sam next Tuesday 1pm high priority" }
 7. quickadd:  transcript lands in the input, EDITABLE
 8. quickadd:  POST /api/ai/parse { text, timezone }
 9. server:    claude.parseTodo() → zod-validated TodoDraft
10. quickadd:  render draft as editable chips — title │ Tue 11 Aug 1pm │ high │ …
11. user taps Save
12. quickadd:  POST /api/todos → store.create() → atomic write
13. todos.js:  re-render list
```

Steps 7 and 10 are the two human checkpoints. Neither is skippable — a misheard word gets
fixed at 7, a mis-parsed date gets fixed at 10.

### Typed quick-add

Identical from step 8. Voice is an *input method* for the same pipeline, not a parallel
one — which is why `voice.js` knows nothing about todos and `quickadd.js` knows nothing
about audio.

### Completing a recurring todo

```
POST /api/todos/:id/complete
  │
  ├─ recurrence == null ─────► status = "done", completedAt = now
  │
  └─ recurrence != null ─────► append completions[] entry for the current occurrence
                               dueAt = nextOccurrence(rule, dueAt)
                               if until/count exhausted → status = "done"
                               else → stays "open" at the new date
```

The todo row is never duplicated. See [02-data-model](02-data-model.md).

### Calendar render

```
GET /api/todos?from=2026-08-01&to=2026-08-31
  │
  ├─ real todos whose dueAt falls in the window
  └─ virtual occurrences: for each recurring todo,
     expandOccurrences(rule, from, to) minus the one already at dueAt
     → tagged { virtual: true }, rendered muted, drag disabled
```

## Why single-writer storage matters

`store.ts` serializes every mutation behind one promise chain and writes with
temp-file + `rename`. Two properties fall out:

- **No interleaved writes.** Two concurrent `PATCH`es cannot produce a half-merged
  document, because the second one waits.
- **No torn files.** `rename` is atomic on POSIX, so a crash mid-write leaves either the
  old complete file or the new complete file — never a truncated one.

This is the entire reason a JSON file is defensible here. Naive
`fs.writeFile(JSON.stringify(doc))` on every request would have both failure modes.

## What's deliberately absent

- **No ORM, no migration CLI.** A `version` field in the document plus a stepper function
  covers schema evolution for a single-user app.
- **No client-side router.** Three panes toggled by class, `?pane=calendar` in the query
  string if deep-linking is ever wanted.
- **No state management library.** The client holds an array of todos and re-renders the
  affected pane. At this scale that's faster than any diffing layer.
- **No WebSocket.** Single user, single tab; the client refetches after mutations.
