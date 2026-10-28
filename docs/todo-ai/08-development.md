# 08 — Development

## Setup

```bash
cd /Users/jeffreysmith/Desktop/WORK/Project.nosync/ai-agents
pnpm install                                   # after apps/todo-ai/package.json exists

cp apps/todo-ai/.env.example apps/todo-ai/.env # then fill in the two API keys
pnpm --filter @ai-agents/todo-ai dev           # tsx watch → http://localhost:8080
```

Locally you can leave `AUTH_PASSWORD_HASH` unset — the server logs a warning and serves
open. That's fine on `localhost` and unacceptable anywhere else; see
[07-deployment](07-deployment.md).

## Scripts

Same five as `apps/mail-mcp`:

| Script | Command |
|---|---|
| `dev` | `tsx watch src/index.ts` |
| `build` | `tsc -p tsconfig.json` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` |
| `start` | `node dist/index.js` |
| `test` | `vitest run` |

Client changes need no build — edit `public/**` and reload.

## Quality gates

All must pass before a bd issue is closed:

```bash
pnpm --filter @ai-agents/todo-ai test
pnpm --filter @ai-agents/todo-ai typecheck
pnpm --filter @ai-agents/todo-ai build
```

`turbo run typecheck` and `turbo run build` from the root pick the app up automatically
once it's a workspace member.

## Testing strategy

The split is deliberate: **test the pure logic exhaustively, test the I/O boundaries
lightly, don't test the vendors at all.**

### Unit — Vitest, no network, no clock

| File | Covers |
|---|---|
| `recurrence.test.ts` | The whole table in [02-data-model](02-data-model.md) |
| `schemas.test.ts` | Valid/invalid drafts; `until` + `count` mutual exclusion; unknown-field stripping |
| `store.test.ts` | Create/update/delete/complete; cascade on parent delete; concurrent-write serialization; migration stepper |

`recurrence.ts` takes the reference date as an argument and never calls `Date.now()`, so
DST and month-end are ordinary tests rather than time-mocking exercises. **This is the
module to over-test** — it's the only genuinely tricky logic in the app, and its bugs are
the kind you notice a month later when a bill was never due.

For `store.test.ts`, point `TODO_AI_DATA_DIR` at a temp dir per test. The concurrency case
is worth writing explicitly: fire N overlapping updates and assert the final document
contains all N, proving the promise chain serializes rather than last-write-wins.

### Not unit-tested

- **`claude.ts` / `deepgram.ts`** — mocking an SDK to assert you called it correctly tests
  the mock. Verified manually against the live APIs (below).
- **Client JS** — no test runner in the browser by choice. Verified in-browser.

## Manual verification

### API, after bd `.3`

```bash
curl -sX POST localhost:8080/api/todos -H 'content-type: application/json' \
  -d '{"title":"buy milk","priority":"low","dueHasTime":false,"tags":[]}' | jq
curl -s 'localhost:8080/api/todos?status=open' | jq
curl -sX POST localhost:8080/api/todos/<id>/complete | jq
```

### AI parse, after bd `.5`

This is where silent wrongness hides — a date that looks fine and is a week off. Re-run
the whole table whenever the prompt changes:

```bash
curl -sX POST localhost:8080/api/ai/parse -H 'content-type: application/json' \
  -d '{"text":"lunch with Sam next Tuesday 1pm high priority","timezone":"Europe/London"}' | jq
```

| Input | Must produce |
|---|---|
| "lunch with Sam next Tuesday 1pm, high priority" | Correct Tuesday, `dueHasTime: true`, `priority: "high"`, title without date words |
| "pay rent on the 1st of every month" | `freq: "monthly"`, `byMonthDay: [1]` |
| "standup every weekday at 9:30" | `freq: "weekly"`, `byWeekday: [1,2,3,4,5]` |
| "buy milk" | `dueAt: null` — **no invented date** |
| "call the dentist tomorrow" with `timezone: Pacific/Auckland` | Tomorrow in Auckland, not on the server |

The last one catches a server-timezone leak, which is otherwise invisible from a machine
in the same zone as its server.

### Transcription, after bd `.7`

Testable without a browser, so do it before touching `voice.js`:

```bash
curl -sX POST localhost:8080/api/voice/transcribe \
  -H 'content-type: audio/webm' --data-binary @sample.webm | jq
```

Record `sample.webm` once from the browser console and keep it as a fixture. Also check:
oversized body → `413`; JSON content-type → `415`; silent clip → `{transcript: ""}`
handled as "didn't catch that".

### Browser

Launch with the `run` skill. Confirm in order:

1. Mic permission prompt appears
2. Recording indicator shows elapsed seconds; the mic light **clears** on stop
3. Transcript lands in the input and is editable
4. Draft chips are editable before saving
5. Save creates the row; it appears in the right Today section
6. The todo appears on the correct calendar day
7. Dragging to another day persists **across reload**
8. Completing a recurring todo advances it instead of closing it
9. Virtual occurrences are visibly muted and reject drags

Repeat 1–5 in **Safari** — it emits `audio/mp4` instead of WebM and is the entire reason
the `Content-Type` passthrough exists. Chrome alone will not catch that regression.

## Working with bd

Per `CLAUDE.md`, bd is the only task tracker — no TodoWrite, no markdown checklists.

```bash
bd ready                          # what's unblocked
bd show ai-agents-z3w             # the epic
bd update ai-agents-z3w.1 --claim # starting
bd close ai-agents-z3w.1          # done, gates passed
```

The dependency graph funnels everything through `.1` (scaffold). After it closes, `.2`
(store/recurrence) and `.4` (auth) both open and can proceed in parallel.

**Session close** (from `AGENTS.md`) — work is not complete until `git push` succeeds:

```bash
git pull --rebase && bd dolt push && git push && git status
```

## Gotchas worth knowing before you hit them

- **`bd` needs the dolt server.** If a command errors, the server likely isn't up; it
  auto-starts but may pick a new port.
- **`.js` extensions are required** in client-side ES module specifiers. Browsers don't do
  Node-style resolution.
- **`express.raw` before the handler, not `express.json`**, on the transcribe route — a
  JSON parser there yields a confusing empty body rather than an error.
- **`preventDefault()` in `dragover`** or `drop` never fires. Native HTML5 DnD's most
  reliable time-waster.
- **Never `innerHTML` with todo text.** It came from a microphone via two APIs.
  `textContent` everywhere.
- **Check the zod major** that `@anthropic-ai/sdk/helpers/zod` accepts before writing
  schemas — the repo is split between zod 3 and zod 4.
