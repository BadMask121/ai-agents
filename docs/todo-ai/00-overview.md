# 00 — Overview

## The problem

Every todo app makes you do data entry. You have a thought — *"I need to have lunch with
Sam next Tuesday at one, and it's important"* — and the app makes you type a title, open a
date picker, find next Tuesday, set a time, pick a priority. The friction is the reason
todo apps go stale.

todo-ai inverts that: you say the sentence, and the app does the parsing. The AI is not a
feature bolted onto a todo list; it *is* the input path.

## What it does

| Capability | Input | Output |
|---|---|---|
| Voice capture | Spoken utterance | Transcript (Deepgram) |
| NL → structured todo | "lunch with Sam next Tuesday 1pm, high priority" | `{title, dueAt, dueHasTime, priority, tags, recurrence}` |
| Recurring parsing | "pay rent on the 1st of every month" | `{freq: monthly, byMonthDay: [1]}` |
| Subtask breakdown | "launch the site" | A proposed checklist of concrete steps |
| Day planning | A date | Time blocks over that day's open todos |
| Calendar | — | Month/week grid over due dates, drag to reschedule |

## Decisions, and why

### No framework, no bundler, no build step on the client

The first design draft was Next.js. It was rejected as too heavy for what this is, and
that's the right call — a single-user todo list does not need React's reconciler, a
bundler, or a server-rendering framework. The browser gets hand-written HTML, CSS, and ES
modules loaded with `<script type="module">`. **The files on disk are the files the
browser runs.** No source maps to chase, no transpile step to debug through.

The cost is real and worth naming: no JSX, no component library, manual DOM updates. For
a UI this size that's a fair trade. It stops being fair somewhere around "multiple users
with live collaborative state" — see [09-roadmap](09-roadmap.md).

### But there *is* a server

Three things cannot live in a browser:

1. **The Anthropic API key.** Shipping it to the client publishes it.
2. **The Deepgram API key.** Same.
3. **Persistence.** `localStorage` is per-browser, unsynced, and silently evictable.

So: a small Express app in TypeScript, modelled directly on `apps/mail-mcp` — the repo's
existing plain-Node member. Same five npm scripts, same `tsc` → `dist/`, same Vitest, same
self-contained Dockerfile shape. TypeScript on the server buys the `typecheck` quality
gate and matches every other Node member in the monorepo; the *client* is the part that
stays plain JS.

### JSON file, not SQLite

Storage is one JSON document, written atomically (temp file + `rename`), behind a single
module that serializes all writes.

SQLite was the first instinct and it's the wrong tool here:

- `better-sqlite3` is a native module with **no musl prebuild** — it breaks on the
  `node:22-alpine` base that `mail-mcp` uses, and fixing it means either switching to a
  glibc base or adding `python3 make g++` to the image.
- `node:sqlite` needs `--experimental-sqlite` before Node 24.
- A single-user todo list is *kilobytes*. There is no query load to optimise.

The whole document loads into memory on boot and is rewritten on mutation. `store.ts` is
the only code that touches the filesystem, so if this app ever outgrows the approach,
swapping in SQLite is one file, not a refactor.

### Deepgram, not the browser's Web Speech API

Web Speech was the original pick — free, and audio never leaves the device. It was
replaced at the user's direction, and the reasons hold up:

- **Firefox has no support.** Web Speech would have meant a permanently degraded browser.
- **Accuracy.** Deepgram's models are materially better on names, times, and jargon —
  precisely the content of a todo ("Sam", "1pm", "standup").
- **Consistency.** Web Speech behaves differently in Chrome vs Safari; `MediaRecorder` +
  a server API behaves the same everywhere.

The cost is a paid vendor and a round trip. Both are small: a 5-second clip is a fraction
of a cent, and the added latency is roughly a second. See
[05-voice-deepgram](05-voice-deepgram.md).

### Batch transcription, not live streaming

Record → stop → upload → transcribe, rather than a live WebSocket with interim words.

A quick-add utterance is 3–5 seconds. Batch costs one HTTP route. Live streaming needs
either a WebSocket proxy through our server or short-lived Deepgram tokens
(`POST /v1/auth/grant`), plus interim-result reconciliation on the client. That is a lot
of machinery for a second of perceived latency on a 5-second recording.

The mitigation is UI, not architecture: an explicit recording indicator with elapsed time,
then a *transcribing* state, then *parsing*. The user always knows what's happening. If
live interim words turn out to matter, the change is contained to `voice.js` plus one
route — it's an upgrade path, not a rewrite.

### AI output is always a draft

**No AI result is ever written silently.** `/api/ai/parse` returns a draft; the client
renders it as an editable chip row — title, date, priority, tags, repeat — with a Save
button. Subtask breakdown shows the proposed checklist before inserting anything.

This is the single most important product decision in the app. A parser that is right 95%
of the time and writes silently is worse than one that is right 90% of the time and always
shows its work, because the first one quietly corrupts your todo list and the second one
never does.

### Claude with structured outputs, not prompt-and-parse

Every AI call uses `client.messages.parse()` with `zodOutputFormat(...)` in
`output_config.format`. The model returns schema-validated JSON. We do not prompt for
"reply with JSON only" and we do not hand-roll tool-use for extraction. See
[04-ai-integration](04-ai-integration.md).

## Out of scope

Named explicitly so the boundary doesn't drift:

- **Google Calendar sync** — settled: built-in calendar view only, no OAuth
- Multi-user accounts, sharing, or collaboration
- Mobile or native apps
- Notifications and reminders
- Offline / PWA support
- Live streaming transcription (batch only)
- Speaker diarization, multi-language detection
- Any client-side build step, bundler, or framework
