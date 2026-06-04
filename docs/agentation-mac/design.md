# Agentation Mac — Design Spec

- **Status:** Draft for review
- **Date:** 2026-06-04
- **Working name:** Agentation Mac (placeholder, rename anytime)
- **Stack:** Rust + Tauri v2, macOS only

## 1. Summary

A native macOS menu-bar app inspired by [agentation.com](https://www.agentation.com/), adapted from the
browser/DOM world to the native desktop. The user snips any region of the screen, marks it up, writes a
question/note, and copies the result so it can be pasted into the Claude desktop/web app to **ask questions
about whatever was captured**.

Core flow:

> Trigger → draw a rectangle anywhere on screen (Apple's native selector) → the snip opens in a small
> markup editor → draw/label on it and type a "Message to Claude" → click **Copy** → the composite image
> (marked-up screenshot + a caption band containing the message) lands on the clipboard → paste into the
> Claude desktop/web app and ask.

### Why this differs from agentation

Agentation lives inside the browser DOM, so it can extract CSS selectors, source-file paths, and React
component trees. A native screen overlay has no DOM, so **none of that metadata exists** for arbitrary
desktop apps. This app therefore captures **pixels only** (plus the user's own typed note) — it is a
visual Q&A capture tool, not a code-fixing/selector-export tool.

### Clipboard constraint (drove a key decision)

A single paste into the Claude app carries **either an image or text, not both at once**. To get the
user's typed question to travel *with* the screenshot in one paste, the text is rendered into the image as
a **caption band** appended to the screenshot. (See §4 Markup editor.)

## 2. Scope

### In scope (v1)
- Menu-bar (tray) presence + a floating, draggable, always-on-top capture button.
- Rectangle region capture via Apple's `screencapture -i`.
- Markup editor: rectangle, arrow, freehand pen, on-image text labels, undo, clear.
- "Message to Claude" text box → rendered as a caption band appended to the composite image.
- Copy composite PNG to the system clipboard.
- Settings: toggle floating button, optional global hotkey, optional launch-at-login.
- Screen Recording permission detection + guidance.

### Out of scope (v1) — noted so architecture doesn't preclude them
- In-app Claude chat / direct Claude API calls.
- OCR / text extraction from the screenshot.
- macOS Accessibility element-awareness (hover/click real UI elements like agentation).
- Selector / source-path / component-tree export (impossible without a DOM).
- Notarized/signed distribution (dev build is fine for v1).

## 3. Architecture

- **Rust + Tauri v2.** Rust backend owns the tray, the floating-button window, capture invocation, image
  composition hand-off, and clipboard writes. The webview (HTML/CSS/JS) owns the markup editor UI.
- **Capture (approach A):** shell out to `/usr/sbin/screencapture -i <temp.png>`. This reuses Apple's
  native rectangle selector and its permission handling. Esc/cancel = no file written → abort quietly.
  Chosen over a custom ScreenCaptureKit overlay (approach B) to ship fast; B remains a future option if a
  branded selection UI or element-awareness is ever wanted.
- **Image composition:** the markup editor (HTML canvas) composites screenshot + annotations + caption
  band and exports a single PNG.
- **Clipboard:** editor sends PNG bytes to Rust via `invoke`; Rust decodes and writes the image to the
  system clipboard using the `arboard` crate (reliable macOS image support). Rust-side write avoids flaky
  webview clipboard-image behavior.

## 4. Components

Each component has one clear purpose and a defined interface so it can be understood and tested alone.

1. **Tray module (Rust)** — menu-bar icon + menu: *Capture*, *Toggle floating button*, *Settings*, *Quit*.
   Depends on: capture module, settings.
2. **Floating button window (Rust + minimal webview)** — small always-on-top, borderless, transparent,
   draggable window with one button; click starts a capture. Persists its on-screen position.
3. **Capture module (Rust)** — `capture_region() -> Result<PathBuf, CaptureError>`. Spawns
   `screencapture -i <temp.png>`, waits, returns the temp PNG path or `Cancelled`. No UI.
4. **Markup editor (webview)** — loads the PNG onto a canvas. Tools: **rectangle, arrow, freehand pen,
   text label**, plus **undo** and **clear**. A **"Message to Claude"** text box. Buttons: **Copy**
   (primary) and **Cancel**. On Copy: composites screenshot + annotations, appends a caption band
   rendering the message text below the image, exports one PNG, hands bytes to the clipboard module.
5. **Clipboard module (Rust)** — `set_clipboard_image(png_bytes) -> Result<(), ClipboardError>`. Decodes
   PNG → writes image to the system clipboard.
6. **Settings (Rust + small webview)** — toggle floating button, set optional global hotkey, toggle
   launch-at-login. Persisted to disk (Tauri store / JSON in app config dir).

## 5. Data flow

```
[Tray click / Floating button / Hotkey]
        → capture_region()  (screencapture -i)
        → temp PNG path  (or Cancelled → idle)
        → open Markup Editor window with the PNG
        → user draws + types "Message to Claude"
        → Copy: canvas composites image + caption band → PNG bytes
        → invoke set_clipboard_image(bytes)
        → clipboard holds composite image
        → user pastes into Claude desktop/web → asks questions
```

## 6. Permissions & error handling

- **Screen Recording (TCC):** required for `screencapture` to see screen content (macOS 10.15+). First run
  / black-capture detection → show a guide window with a button deep-linking to *System Settings → Privacy
  & Security → Screen Recording*. Re-check on next capture.
- **Capture cancelled (Esc):** no file written → return to idle, no error shown.
- **Clipboard write failure:** show an error toast in the editor; keep the composed image so the user can
  retry Copy.
- **Empty/zero-byte capture file:** treat as cancel.

## 7. Testing

- **Rust unit tests:** capture wrapper (inject a fake binary / path to assert arg construction + cancel
  handling); clipboard module (PNG encode→decode round-trip).
- **JS unit tests:** markup canvas (add shape, undo, add text label, caption-band render, export produces a
  valid non-empty PNG of expected dimensions).
- **Manual QA checklist:** permission-grant flow; single + multi-monitor; Retina scaling correctness;
  Esc-cancel; floating-button drag + position persistence; paste-into-Claude end to end.

## 8. Project location

New, greenfield, unrelated to `career-ops-ui`. Default: a new directory in this repo at
**`packages/agentation-mac/`** with its own Cargo + Tauri project. Alternative: a standalone new git repo
if we'd rather keep Rust out of this Node-centric repo. **To be confirmed during spec review.**

## 9. Open questions / to confirm

- Final app name (placeholder: "Agentation Mac").
- Project location: `packages/agentation-mac/` vs standalone repo.
- Include global hotkey + launch-at-login in v1, or defer to a fast-follow?
