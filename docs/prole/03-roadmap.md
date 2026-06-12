# 03 — Roadmap

## v1 (the core flow)

The minimum that delivers "snip anything → ask Claude":

- [ ] Tauri v2 project scaffold (macOS), tray icon + menu (Capture / Toggle floating button / Settings / Quit).
- [ ] Capture module — `screencapture -i` wrapper with cancel detection.
- [ ] Floating, draggable, always-on-top capture button; position persisted.
- [ ] Markup editor webview — rectangle, arrow, freehand pen, text label, undo, clear.
- [ ] "Message to Claude" box → caption band composited into the exported PNG.
- [ ] Clipboard module — `arboard` image write.
- [ ] Screen Recording permission detection + guide window.
- [ ] Global hotkey to start a capture. *(In v1 — confirm; otherwise demote to fast-follow.)*
- [ ] Launch-at-login toggle. *(In v1 — confirm; otherwise demote to fast-follow.)*
- [ ] Tests per [01-architecture.md](01-architecture.md) §Testing + manual QA checklist.

## Fast-follow (small, high-value)

- Capture history (recent snips, re-copy).
- Configurable caption-band styling / position; optional "no caption" mode.
- Plain-text copy toggle (note as text instead of baked-in), per
  [02-stack-decisions.md](02-stack-decisions.md).
- Signed + notarized `.app` for distribution.

## Future / explicitly deferred

These are **out of scope** and noted only so the architecture doesn't preclude them:

- **In-app Claude chat / direct API** — snip and ask without leaving the app (needs an API key, streaming
  UI, context management).
- **OCR** — extract selectable text from the snip.
- **Accessibility element-awareness** — agentation-style hover/click of real UI elements (requires
  approach B custom overlay + Accessibility permission; only works for accessible apps).
- **MCP / webhook integration** — push captures to an external agent automatically.

## Open decisions (carried from README)

1. **Project location** — proposed `apps/prole/` vs standalone repo.
2. **Global hotkey + launch-at-login** — v1 vs fast-follow.
