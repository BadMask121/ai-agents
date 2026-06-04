# Proletariat

> Native macOS "snip → ask Claude" capture tool. Inspired by [agentation.com](https://www.agentation.com/),
> rebuilt for the desktop instead of the browser DOM.

**Status:** Design / pre-implementation · **Date:** 2026-06-04 · **Stack:** Rust + Tauri v2 · **macOS only**

## What it is

Proletariat lives in your menu bar (and as an optional floating desktop button). You trigger it, draw a
rectangle around **anything** on screen, mark it up, type a question, and it copies a single composite
image to your clipboard. You paste that into the Claude desktop/web app and ask your question about
whatever you captured.

```
Trigger → draw rectangle (macOS native selector) → markup editor
        → draw/label + type "Message to Claude"
        → Copy → composite image (snip + caption band) on clipboard
        → paste into Claude → ask
```

## Why not just agentation?

Agentation runs inside the browser DOM, so it can extract CSS selectors, source paths, and React
component trees. A native screen overlay has **no DOM** — none of that metadata exists for arbitrary
desktop apps. Proletariat therefore captures **pixels + your typed note only**. It is a *visual Q&A capture
tool*, not a code-fixing / selector-export tool. See [02-stack-decisions.md](02-stack-decisions.md).

## Docs

| Doc | Contents |
| --- | --- |
| [01-architecture.md](01-architecture.md) | Components, data flow, permissions, error handling, testing |
| [02-stack-decisions.md](02-stack-decisions.md) | Key technology choices + rationale + alternatives weighed |
| [03-roadmap.md](03-roadmap.md) | v1 scope, fast-follow, and explicitly-deferred future work |

## Open decisions (to confirm)

1. **Project location** — proposed `apps/proletariat/` (aligns with the in-flight `packages/` → `apps/`
   restructure). Alternative: standalone repo.
2. **Global hotkey + launch-at-login** — currently planned **in v1**; can be demoted to fast-follow.
