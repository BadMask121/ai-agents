# 06 — Frontend

No framework, no bundler, no transpile. `public/` is served by `express.static` exactly as
it sits on disk — **the files you edit are the files the browser runs.**

## Layout

```
public/
  index.html      one page; three panes toggled by class
  styles.css      CSS custom properties + grid
  js/
    app.js        boot, pane switching, wires everything together
    api.js        fetch() wrapper over /api/*
    quickadd.js   input + mic + editable draft row
    voice.js      getUserMedia → MediaRecorder → upload
    todos.js      list render, complete, edit, delete
    calendar.js   month/week grid, drag-to-reschedule
    plan.js       plan-my-day pane
```

Loaded once, as a module graph:

```html
<script type="module" src="/js/app.js"></script>
```

Native ES modules — `import { listTodos } from './api.js'` — resolved by the browser. Note
the **`.js` extension is required** in the specifier; browsers don't do Node-style
resolution.

## Conventions

Without a framework, consistency has to come from convention. Four rules:

**1. One module owns one pane.** `todos.js` owns the Today list, `calendar.js` owns the
calendar, `plan.js` owns the plan. Each exports `render(state)` and `mount(root)`. No
module reaches into another's DOM.

**2. `api.js` is the only place `fetch` appears.** It centralises the base path, JSON
headers, the 401 → show-login redirect, and error normalisation:

```js
async function request(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 401) { showLogin(); throw new AuthError(); }
  if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? res.statusText, res.status);
  return res.status === 204 ? null : res.json();
}
```

Every route gets a named wrapper — `listTodos`, `createTodo`, `parseText`, `transcribe` —
so no caller composes URLs by hand.

**3. State is one object, re-render is a function.** No observables, no diffing:

```js
const state = { todos: [], pane: 'today', draft: null, voice: 'idle' };
function render() { /* dispatch to the active pane's render(state) */ }
```

After any mutation: update `state`, call `render()`. At this scale a full re-render of one
pane is imperceptible and far simpler than tracking what changed. If a list ever gets long
enough for this to stutter, the fix is keyed row reuse in `todos.js` alone — not a
framework.

**4. Build DOM with `document.createElement` and `textContent`, never `innerHTML` with
data.** Todo titles come from a transcript, which came from a microphone. `innerHTML` on
that path is an XSS hole with extra steps. `textContent` is not a style preference here.

## Rendering the panes

### Today (`todos.js`)

Sections: **Overdue** · **Today** · **Upcoming** · **No date**. Each row is title,
priority dot, due chip, tag chips, and a checkbox.

- Checkbox → `POST /api/todos/:id/complete`. Apply optimistically, roll back on error —
  the round trip is short but not free, and a checkbox that lags feels broken.
- A recurring row that advances re-sorts into its new section, with a brief "next: Sep 1"
  affordance so it doesn't look like the tap did nothing.
- Inline edit on title click; blur or Enter commits a `PATCH`.

### Quick-add (`quickadd.js`)

The centrepiece. Input, mic button, and — after a parse — the **draft row**:

```
┌──────────────────────────────────────────────────────────┐
│ Lunch with Sam                                           │  ← editable
│ [ Tue 11 Aug, 1:00 PM ▾ ] [ high ▾ ] [ +tag ] [ repeat ▾ ]│  ← editable chips
│                                    [ Discard ]  [ Save ] │
└──────────────────────────────────────────────────────────┘
```

Every field is editable before saving. **Nothing is written until Save.** On a `422` from
the parse route, the draft collapses to just the raw text as a title — a failed parse must
never lose the thought.

### Calendar (`calendar.js`)

CSS Grid, `grid-template-columns: repeat(7, 1fr)`. Month and week toggle.

- Drag uses native HTML5 DnD (`draggable="true"`, `dragstart`/`dragover`/`drop`). Drop
  computes the new `dueAt` — preserving the time-of-day when `dueHasTime` is true — and
  `PATCH`es.
- **Virtual occurrences render muted and set `draggable="false"`.** Dragging one is
  meaningless: there's no row behind it. Clicking one opens the parent's repeat rule.
- Fetch is windowed: `GET /api/todos?from=&to=` for the visible range only.

Native DnD has real quirks — you must `preventDefault()` in `dragover` for `drop` to fire,
and the drag image needs setting explicitly on some browsers. Worth it to avoid a
dependency; just don't rediscover those two from scratch.

### Plan (`plan.js`)

Renders `dayPlans[date].blocks` as a vertical timeline. Read-only — the plan is advice,
not a schedule. A Regenerate button hits `?refresh=1`.

## Styling

CSS custom properties on `:root`, no preprocessor:

```css
:root {
  --bg: …;  --surface: …;  --text: …;  --muted: …;  --border: …;
  --accent: …;  --priority-high: …;  --priority-med: …;  --priority-low: …;
  --radius: 10px;  --gap: 12px;
}
```

Its own palette — don't copy `career-ops-ui`'s phosphor-green wholesale; different app,
different feel. Support `prefers-color-scheme` from the start: it's a second block of
custom-property overrides, and retrofitting it later means auditing every rule.

Layout is flexbox and grid. No utility framework — at this size the CSS is a few hundred
lines and a class-per-property system would be more text, not less.

## Accessibility

Not optional, and cheap if done from the start:

- The mic is a `<button>` with an `aria-label` that reflects state ("Start recording" /
  "Stop recording"), not a clickable `<div>`.
- Recording, transcribing, and error states announce via `aria-live="polite"` — a
  spinner is invisible to a screen reader.
- The todo list is a `<ul>`; checkboxes are real `<input type="checkbox">` with labels.
- Calendar cells are focusable and support keyboard reschedule (arrow to a day, Enter to
  drop) — HTML5 drag-and-drop is mouse-only, so without this the calendar is unusable by
  keyboard.
- Visible focus rings. Don't `outline: none` without a replacement.

## What this costs

Being honest about the trade, since the no-framework choice is deliberate:

- Manual DOM updates and no component reuse across panes.
- Every module must remember `textContent`, not `innerHTML`.
- No type checking on the client — the server is TypeScript, the browser code is not.
  JSDoc annotations on `api.js` return types recover a useful fraction of that in editors.
- Keyboard-accessible drag needs hand-writing.

All acceptable for a single-user app of this size. The line where it stops being
acceptable is named in [09-roadmap](09-roadmap.md).
