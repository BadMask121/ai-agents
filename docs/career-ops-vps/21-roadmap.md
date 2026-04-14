# career-ops-ui roadmap — deferred features

This file tracks features that have been designed and agreed on but deferred
so the team can keep momentum on the core overhaul phases in
`20-ui-overhaul-plan.md`. Anything here is ready to be picked up in its own
branch + bd issue without another round of brainstorming.

---

## Structured portals management UI

**Status:** designed, deferred (2026-04-14). Plan file at
`~/.claude/plans/prancy-wibbling-neumann.md`.

### Why it exists

Today `/settings/portals` mounts the generic `ConfigEditor` — a raw YAML
textarea. Adding a new company to the daily scan means hand-editing 2-space
indented YAML, remembering the exact field names (`name`, `careers_url`,
`enabled`, optional `api`/`scan_method`/`scan_query`/`notes`), and not
breaking any of the 75 comments that annotate the file. The practical
consequence: the user doesn't add new companies very often, the scan stays
stuck on whatever was in the file at first setup, and Discover's feed is
narrower than it should be.

The goal is a paste-a-URL-hit-Add flow that figures out the name + ATS from
the careers URL (Greenhouse / Ashby / Lever detected, everything else
fallback) and appends a single entry to `tracked_companies:` without
touching any other bytes of the file.

### Core design constraints

1. **Preserve comments.** `portals.yml` has 75 meaningful comments
   (section headers, `[CUSTOMIZE]` hints, schema docs). `js-yaml`
   round-trips destroy them. The chosen approach is
   **parse-to-read, surgical string-edit to write** — touch only the lines
   of the one entry being added/toggled/removed.

2. **Atomic writes against a live cron.** `career-scan.timer` reads
   `portals.yml` at 07:00 UTC daily. Writes must use tempfile + rename on
   the same filesystem so the cron never reads a half-written file.

3. **Dedupe on add.** Reject duplicates by `name` (case-insensitive) OR by
   `careers_url` (trailing-slash normalized). Return 409 with the
   conflicting entry so the UI can offer "already tracked — enable it?"

4. **Raw YAML fallback stays.** `title_filter` and `search_queries` remain
   editable through the existing `ConfigEditor` mounted as a collapsed
   section at the bottom of the new page. Structured editing for those
   sections is explicitly out of scope.

### API surface

| Route | Method | Body | Returns |
|---|---|---|---|
| `/api/portals` | GET | — | `{ companies: TrackedCompany[], raw: string }` |
| `/api/portals` | POST | `{ careers_url, name?, notes? }` | `{ ok, company }` or 409 `{ conflict }` |
| `/api/portals/[name]` | PATCH | `{ enabled }` | `{ ok }` |
| `/api/portals/[name]` | DELETE | — | `{ ok }` |

Single in-process mutex around the file path serializes writes so parallel
PATCH requests from multiple browser tabs don't race on the
read-modify-write.

### Files to create

- `packages/career-ops-ui/src/lib/portals.ts` — parse, inference, surgical
  edit primitives (`appendEntry`, `toggleEnabled`, `removeEntry`),
  atomic write, mutex
- `packages/career-ops-ui/src/app/api/portals/route.ts` — GET + POST
- `packages/career-ops-ui/src/app/api/portals/[name]/route.ts` — PATCH + DELETE
- `packages/career-ops-ui/src/app/settings/portals/PortalsManager.tsx` —
  client island with list + filter + toggle + delete + collapsed raw
  fallback + "Run scan now" button (reuses existing `POST /api/actions`
  with `mode: "scan"`)
- `packages/career-ops-ui/src/app/settings/portals/AddPortalForm.tsx` —
  URL input with live inference preview ("detected: ashby · name: PolyAI")

### Files to modify

- `packages/career-ops-ui/src/app/settings/portals/page.tsx` — swap
  `ConfigEditor` for `PortalsManager`
- `packages/career-ops-ui/src/app/settings/page.tsx` — update the Portals
  tile subtitle

### URL → company inference

```
https://boards.greenhouse.io/anthropic   → greenhouse · Anthropic
https://job-boards.greenhouse.io/stripe  → greenhouse · Stripe
https://jobs.ashbyhq.com/polyai          → ashby · PolyAI
https://jobs.lever.co/figma              → lever · Figma
https://acme.com/careers                 → fallback · Acme
```

### Blockers / prerequisites

- None strictly blocking — can be built anytime.
- `ANTHROPIC_API_KEY` in the Coolify env is a prereq for the "Run scan now"
  button to do useful work, but add/toggle/remove are pure filesystem and
  don't need it.

### When to prioritize

Before or alongside Phase 5 polish. The current 131 `tracked_companies` is
a solid starting list, so there's no immediate dataset problem — the
feature is about ergonomics, not capability.

### Explicitly out of scope (will stay deferred even after this ships)

- Structured editor for `title_filter` and `search_queries`
- Bulk CSV / multi-paste import
- Rename of existing entries (raw YAML for that)
- Any "paste a job posting URL to evaluate it" flow — that was a separate
  ask from 2026-04-13 that was never actually needed; document for
  posterity, don't build

---

## How to add new deferred features to this file

Each entry should have:
- A one-line status with a date
- A short "why it exists" paragraph grounded in user behavior, not a
  feature wish
- The core design constraints that make the design non-obvious
- API surface + file list so it's buildable without a new planning round
- Blockers and when to prioritize
