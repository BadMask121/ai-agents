# 02 — Data model

## The document

One JSON file at `${TODO_AI_DATA_DIR}/todos.json`. Loaded into memory on boot, rewritten
atomically on every mutation.

```jsonc
{
  "version": 1,

  "todos": [
    {
      "id": "V1StGXR8_Z5jdHi6B-myT",     // nanoid
      "title": "Lunch with Sam",
      "notes": "",
      "status": "open",                   // "open" | "done"
      "priority": "high",                 // "low" | "medium" | "high"
      "dueAt": "2026-08-11T12:00:00.000Z",// ISO-8601 instant (UTC) | null
      "dueHasTime": true,                 // false → all-day
      "tags": ["personal"],
      "recurrence": null,                 // RecurrenceRule | null
      "parentId": null,                   // → todos[].id, for subtasks
      "sortOrder": 1000,
      "createdAt": "2026-08-04T09:12:00.000Z",
      "updatedAt": "2026-08-04T09:12:00.000Z",
      "completedAt": null
    }
  ],

  "completions": [
    {
      "id": "…",
      "todoId": "…",
      "occurrenceDate": "2026-08-11",     // YYYY-MM-DD, local to the rule
      "completedAt": "2026-08-11T13:04:00.000Z"
    }
  ],

  "dayPlans": {
    "2026-08-11": {
      "blocks": [
        { "start": "09:00", "end": "10:30", "todoId": "…", "label": "Deep work: …" }
      ],
      "createdAt": "2026-08-11T08:00:00.000Z"
    }
  }
}
```

### Field notes

**`dueAt` is always a UTC instant, never a local wall-clock string.** The AI resolves
natural language against the client's `now` + IANA timezone and returns an instant. The
app never re-parses natural language, and never stores "next Tuesday".

**`dueHasTime` distinguishes a deadline from a date.** "Pay rent on the 1st" is all-day;
"lunch at 1pm" is not. Without this flag every all-day todo renders at midnight, which is
both wrong and ugly. All-day todos render as a date chip; timed ones get a time slot in
the week view.

**`sortOrder` is a float**, so reordering between two items is `(a + b) / 2` rather than
renumbering the list.

**`parentId` gives one level of nesting.** Subtask breakdown creates children; children
are not themselves broken down. Nothing enforces depth in the schema — the AI route simply
refuses to break down a todo that already has a `parentId`.

**`completedAt` is only meaningful for non-recurring todos.** For recurring ones the
history lives in `completions`.

## Recurrence

```ts
type RecurrenceRule = {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;          // every N periods; default 1
  byWeekday?: number[];      // 0=Sun … 6=Sat  (weekly only)
  byMonthDay?: number[];     // 1–31           (monthly only)
  until?: string;            // ISO date, inclusive
  count?: number;            // total occurrences
};
```

This is a deliberate subset of RFC 5545 RRULE. It covers what people actually say —
*"every day"*, *"every other Tuesday"*, *"weekdays at 9:30"*, *"the 1st of every month"*,
*"annually"* — without the parts nobody dictates (`BYSETPOS`, `BYYEARDAY`, `WKST`).

`until` and `count` are mutually exclusive; the schema rejects both being set.

### Semantics

**A recurring todo's `dueAt` is always its *current* occurrence.** There is exactly one
row per recurring task, no matter how many times it repeats.

Completing it:

1. appends a `completions` entry stamped with the occurrence date,
2. advances `dueAt` to `nextOccurrence(rule, dueAt)`,
3. leaves `status` as `"open"` — unless `until` has passed or `count` is exhausted, in
   which case it becomes `"done"`.

So a recurring todo never accumulates rows and never disappears from the list until the
rule genuinely ends.

### Virtual occurrences

The one-row model means the calendar would only ever show the *next* occurrence, which
makes a monthly bill look like it happens once. So the calendar view additionally expands
future occurrences within the visible window:

```ts
expandOccurrences(rule, from, to): string[]   // ISO instants
```

Those are returned tagged `{ virtual: true }`, rendered muted, and **not draggable** —
dragging one is meaningless, because there's no row to update. Rescheduling a repeat means
editing the rule.

This gives both properties: one row of truth, full visibility of the schedule.

## `recurrence.ts` — the two functions

```ts
nextOccurrence(rule: RecurrenceRule, after: string): string | null
expandOccurrences(rule: RecurrenceRule, from: string, to: string, anchor: string): string[]
```

Both are **pure** — no `Date.now()`, no I/O. The reference date is always an argument.
That's what makes the hard cases ordinary unit tests.

### The cases that must be tested

| Case | Input | Expectation |
|---|---|---|
| Month-end rollover | monthly, `byMonthDay: [31]`, from Jan 31 | Feb has no 31st — **clamp to Feb 28/29**, do not skip the month, do not roll into March |
| Leap year | yearly, anchored Feb 29 2028 | Falls back to Feb 28 in common years |
| Interval > 1 with weekdays | weekly, `interval: 2`, `byWeekday: [1,3]` | Mon+Wed of *every other* week — the interval applies to the week, not to each weekday |
| `count` exhaustion | `count: 3` | Third completion closes the todo; there is no fourth occurrence |
| `until` boundary | `until` = an occurrence date | Inclusive — that occurrence still happens |
| DST spring-forward | daily at 09:00 local, across the transition | Stays 09:00 *local*; the UTC instant shifts by an hour |
| DST fall-back | daily at 01:30 local, on the duplicated hour | Fires once, not twice |

The DST cases are the ones that bite. Because `dueAt` is stored as a UTC instant but the
rule means a *local* wall-clock time, advancing an occurrence is not "add 24 hours" — it's
"reconstruct the local wall-clock time on the next day, then convert back". Implement it
that way from the start; a naive `+86400000` is correct for ~363 days a year, which is
exactly long enough to ship before anyone notices.

## Schema evolution

`version` is an integer. `store.ts` runs a stepper on load:

```ts
const MIGRATIONS: Record<number, (doc: any) => any> = {
  1: (doc) => doc,          // current
  // 2: (doc) => { … },     // add here, bump CURRENT_VERSION
};
```

A document from the future (higher `version` than the binary knows) is a **hard boot
failure**, not a silent downgrade — refusing to start beats corrupting the file.

Take a copy of `todos.json` before the first run of any migration. It's a single-user app;
a `cp` is the whole backup strategy.
