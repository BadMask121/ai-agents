# todo-ai — voice-driven AI todo app

**Status:** 📐 designed, not yet built · **App:** `apps/todo-ai/` (does not exist yet) ·
**Epic:** bd `ai-agents-z3w`

> These documents describe a system that has **not been implemented**. They are the spec
> the build works from, not a description of running code. Anything stated in the present
> tense ("the server returns…") describes intended behaviour. When the code lands, correct
> whatever diverged rather than leaving the docs aspirational.

A single-user todo app whose input path is AI-native. You say or type
*"lunch with Sam next Tuesday 1pm, high priority"* and it becomes a structured todo —
title, resolved due instant, priority, tags, repeat rule — not a string you have to
re-read later.

Four AI capabilities, all in scope:

1. **Natural language → structured todo** (the core; powers both voice and typed quick-add)
2. **Daily planning** — order open todos into time blocks
3. **Subtask breakdown** — turn a vague todo into a concrete checklist
4. **Recurring-task parsing** — "every Monday", "1st of the month" → a repeat rule

Plus a built-in calendar over due dates with drag-to-reschedule.

## Documents

| # | Document | What's in it |
|---|---|---|
| 00 | [Overview](00-overview.md) | What it is, the decisions and their reasoning, what's out of scope |
| 01 | [Architecture](01-architecture.md) | Components, request flows, why the server exists at all |
| 02 | [Data model](02-data-model.md) | The JSON document, recurrence semantics, the virtual-occurrence trick |
| 03 | [HTTP API](03-api.md) | Every route, request/response shape, status codes |
| 04 | [AI integration](04-ai-integration.md) | Structured outputs, prompt construction, effort tuning, failure modes |
| 05 | [Voice & Deepgram](05-voice-deepgram.md) | Capture → upload → transcribe pipeline and its gotchas |
| 06 | [Frontend](06-frontend.md) | The no-build client: module layout, rendering, state |
| 07 | [Deployment](07-deployment.md) | Docker, environment, the TLS requirement |
| 08 | [Development](08-development.md) | Local setup, testing strategy, quality gates |
| 09 | [Roadmap](09-roadmap.md) | Deferred work and the known upgrade paths |

## Quick orientation

```
browser (plain HTML/CSS/ES modules, no build step)
   │  fetch /api/*
   ▼
Express + TypeScript server  ──────►  Deepgram   (audio → transcript)
   │                          ──────►  Claude     (transcript → structured todo)
   ▼
todos.json  (atomic writes, single writer)
```

The server exists for exactly three reasons: it holds the Anthropic key, it holds the
Deepgram key, and it owns the data file. Everything else is in the browser.

## Related

- Plan of record: `~/.claude/plans/i-want-to-build-abundant-lamport.md`
- Sibling app this is modelled on: [`apps/mail-mcp`](../mail-mcp/README.md) — same
  Express + `tsc` + Vitest + self-contained-Dockerfile shape.
