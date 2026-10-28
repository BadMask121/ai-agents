# 04 — AI integration (Claude)

Everything AI lives in `src/claude.ts`: one shared client, three exported functions,
one pattern.

## The pattern

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic();   // resolves ANTHROPIC_API_KEY or an `ant auth login`
                                  // profile — never hardcode a key

const res = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 2048,
  system: PARSE_SYSTEM,                        // stable, zero interpolation
  output_config: {
    effort: "low",
    format: zodOutputFormat(TodoDraftSchema),
  },
  messages: [
    { role: "user", content: `Now: ${nowIso} (${timezone})\n\n${text}` },
  ],
});

if (!res.parsed_output) throw new UnparseableError(textOf(res));
return res.parsed_output;                       // already schema-validated
```

**Structured outputs, not prompt-and-parse.** We do not ask the model to "reply with JSON
only", we do not regex the response, and we do not hand-roll tool-use for extraction. The
schema is enforced at the API layer, so `parsed_output` either matches `TodoDraftSchema` or
is null.

### Model

`claude-opus-5` on every route. Effort — not model choice — is the latency and cost lever:

| Function | Effort | Why |
|---|---|---|
| `parseTodo` | `low` | Sits behind the mic. Extraction from one sentence is not hard; latency is what the user feels. |
| `breakdown` | `medium` | Needs some judgement about what the real steps are. |
| `planDay` | `high` | The genuinely hard one — ordering work against fixed commitments. |

Leave `thinking` unset. It's on by default on Opus 5, and explicitly disabling it is the
setting that causes tool calls to leak into visible response text.

### `now` and `timezone` go in the *user* turn

Not the system prompt. Two reasons, both load-bearing:

1. **Cache.** Prompt caching is a prefix match. Interpolating a timestamp into `system`
   changes the prefix on every single request, so nothing ever caches.
2. **Correctness.** They're per-request data, not instructions.

Both are mandatory. "Next Tuesday 1pm" is unresolvable without a reference instant and a
zone, and defaulting to the server's zone quietly produces wrong dates the moment the user
travels. The client sends
`Intl.DateTimeFormat().resolvedOptions().timeZone` with every parse.

The model resolves `dueAt` to an ISO instant. **The app never re-parses natural language**
— there is no chrono/dateparser fallback, and adding one would create two sources of truth
that disagree in exactly the confusing cases.

---

## Schemas

```ts
const RecurrenceRuleSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
  until: z.string().nullable().optional(),
  count: z.number().int().min(1).nullable().optional(),
});

const TodoDraftSchema = z.object({
  title: z.string().min(1),
  notes: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high']),
  dueAt: z.string().nullable(),      // ISO instant, already resolved
  dueHasTime: z.boolean(),
  tags: z.array(z.string()),
  recurrence: RecurrenceRuleSchema.nullable(),
});
```

> **Pin the right zod major.** Check what `@anthropic-ai/sdk/helpers/zod` accepts in the
> installed SDK version *before* writing schemas. The repo is split — `mail-mcp` is on zod
> 3, `booking-ops` on zod 4 — so there is no house answer to inherit, and a mismatch
> surfaces as a confusing type error inside the helper rather than a clear one at the call
> site.

Structured outputs support a **subset** of JSON Schema. Notably unsupported: recursive
schemas, numeric constraints (`min`/`max` on numbers), string length constraints. The
Python and TypeScript SDKs strip these and validate client-side instead — which means
`z.number().min(1)` above is enforced by zod after the fact, not by the model. Don't rely
on the model to respect a numeric bound; validate and clamp.

---

## Prompts

The system prompt is a constant. It carries the rules; the user turn carries the data.

```
You convert a short natural-language note into a structured todo.

- Resolve every relative date against the supplied "Now" and timezone. Return
  dueAt as an ISO-8601 UTC instant.
- If the note names no date at all, dueAt is null. Do not invent one.
- dueHasTime is false when the note gives a day but no clock time.
- Set recurrence only when the note describes something that repeats.
- title is the task, not the whole sentence. Strip date and priority words
  from it.
- priority defaults to "medium" unless the note signals otherwise.
- tags only for explicit categories the note names. Do not infer.
```

Two instructions there earn their place from observed failure modes:

- **"If the note names no date at all, dueAt is null. Do not invent one."** Without it,
  "buy milk" reliably acquires a due date of today. That is the single most damaging
  hallucination in this app — it silently fills your Today list with things you never
  scheduled.
- **"title is the task, not the whole sentence."** Without it you get titles like
  "lunch with Sam next Tuesday 1pm high priority", which defeats the point.

Keep the prompt this short. Opus 5 follows instructions closely; a longer, more emphatic
prompt makes it over-apply rules, and the failure mode flips from under-tagging to
tagging everything.

---

## Error handling

```ts
try { … } catch (err) {
  if (err instanceof Anthropic.RateLimitError)      → 429  retryable
  if (err instanceof Anthropic.APIConnectionError)  → 503  retryable
  if (err instanceof Anthropic.APIError)            → 502  show message
  throw
}
```

Catch a chain, most specific first — not one broad `APIError`. The distinction matters to
the UI: 429 and 503 mean "try again in a moment", 502 means "something is actually wrong".

`res.parsed_output` is **nullable**. When it's null, return `422` with the raw model text
so the client can fall back to saving the input as a plain title. A failed parse must never
mean a lost thought — the user said something, and something gets saved.

---

## The draft contract

**No AI function writes to the store.** `claude.ts` has no import of `store.ts`; it
cannot. Every function returns a value that the client must confirm:

| Route | Returns | Confirmed by |
|---|---|---|
| `/api/ai/parse` | `TodoDraft` | Editable chip row + Save |
| `/api/todos/:id/subtasks` | `proposals[]` | Checklist review, then normal POSTs |
| `/api/ai/plan` | `DayPlan` | Displayed; cached, but nothing is scheduled |

This is structural, not conventional. A parser that's right 95% of the time and writes
silently corrupts the list in ways you find out about weeks later; one that always shows
its work never does.

---

## Testing the parse path

The failure mode here is *plausible wrongness* — a returned date that looks fine and is a
week off. Check each of these against the current date every time the prompt changes:

| Input | Must produce |
|---|---|
| "lunch with Sam next Tuesday 1pm, high priority" | The correct Tuesday, `dueHasTime: true`, `priority: "high"`, title without the date words |
| "pay rent on the 1st of every month" | `freq: "monthly"`, `byMonthDay: [1]`, `dueHasTime: false` |
| "standup every weekday at 9:30" | `freq: "weekly"`, `byWeekday: [1,2,3,4,5]`, `dueHasTime: true` |
| "buy milk" | `dueAt: null`, `recurrence: null` — **no invented date** |
| "call the dentist tomorrow" | Tomorrow relative to the *supplied* now, not the server's |

Run the last one with a `timezone` far from the server's (e.g. `Pacific/Auckland`) — it's
the one that catches a server-timezone leak.

These are integration checks against the live API, so they don't belong in the Vitest
suite; they're the manual gate in [08-development](08-development.md).
