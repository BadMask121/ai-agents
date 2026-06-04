# 01 — Architecture

## Overview

Proletariat is a Rust + Tauri v2 macOS app. The **Rust backend** owns system integration (tray, windows,
capture invocation, clipboard). The **webview** owns the markup editor UI. The two communicate via Tauri's
`invoke` bridge.

```
┌──────────────────────────── Rust backend (Tauri core) ────────────────────────────┐
│  Tray module ─┐                                                                     │
│  Floating btn ─┼─→ Capture module ──(screencapture -i)──→ temp PNG ──→ open editor  │
│  Global hotkey─┘                                                                    │
│  Clipboard module ←──(invoke set_clipboard_image)── Markup editor (webview)         │
│  Settings store                                                                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Components

Each unit has one purpose, a defined interface, and is testable in isolation.

### 1. Tray module (Rust)
Menu-bar icon + menu: **Capture**, **Toggle floating button**, **Settings**, **Quit**.
Depends on: capture module, settings.

### 2. Floating button window (Rust + minimal webview)
Small always-on-top, borderless, transparent, draggable window with one button; click starts a capture.
Persists its on-screen position via the settings store.

### 3. Capture module (Rust)
```
capture_region() -> Result<PathBuf, CaptureError>
```
Spawns `/usr/sbin/screencapture -i <temp.png>`, awaits exit, returns the temp PNG path. If no file was
written (user pressed Esc) or the file is zero-byte → `CaptureError::Cancelled`. No UI of its own — it
reuses Apple's native rectangle selector.

### 4. Markup editor (webview)
Loads the captured PNG onto an HTML canvas. Tools: **rectangle, arrow, freehand pen, text label**, plus
**undo** and **clear**. A **"Message to Claude"** text box. Buttons: **Copy** (primary), **Cancel**.

On **Copy** it composites, in order:
1. the captured screenshot,
2. the drawn annotations (shapes + text labels),
3. a **caption band** appended below the image rendering the "Message to Claude" text,

then exports a single PNG and hands the bytes to the clipboard module. The caption band is how the typed
question travels *with* the image in one paste (see [02-stack-decisions.md](02-stack-decisions.md),
"Clipboard constraint").

### 5. Clipboard module (Rust)
```
set_clipboard_image(png_bytes: Vec<u8>) -> Result<(), ClipboardError>
```
Decodes the PNG and writes the image to the system clipboard via the `arboard` crate. Rust-side write
avoids flaky webview clipboard-image behavior.

### 6. Settings (Rust + small webview)
Toggle floating button, set optional global hotkey, toggle launch-at-login. Persisted to the app config
dir (Tauri store / JSON).

## Data flow

```
[Tray click / Floating button / Global hotkey]
   → capture_region()                      (screencapture -i)
   → temp PNG path                         (or Cancelled → idle)
   → open markup editor window with the PNG
   → user draws + types "Message to Claude"
   → Copy: canvas composites image + caption band → PNG bytes
   → invoke set_clipboard_image(bytes)
   → clipboard holds the composite image
   → user pastes into Claude desktop/web → asks questions
```

## Permissions & error handling

- **Screen Recording (TCC):** required for `screencapture` to see screen content (macOS 10.15+). On first
  run / black-capture detection, show a guide window with a button deep-linking to *System Settings →
  Privacy & Security → Screen Recording*; re-check on next capture.
- **Accessibility (TCC):** required *only* if/when a global hotkey or the draggable floating window needs
  it; the rectangle-capture core does not. Requested lazily.
- **Capture cancelled (Esc):** no file written → return to idle, no error shown.
- **Empty / zero-byte capture file:** treated as cancel.
- **Clipboard write failure:** error toast in the editor; keep the composed image so the user can retry.

## Testing

- **Rust unit tests:** capture wrapper (inject a fake binary / path to assert arg construction + cancel
  handling); clipboard module (PNG encode→decode round-trip).
- **JS unit tests:** markup canvas (add shape, undo, add text label, caption-band render; export produces a
  valid non-empty PNG of the expected dimensions).
- **Manual QA checklist:** permission-grant flow; single + multi-monitor; Retina scaling correctness;
  Esc-cancel; floating-button drag + position persistence; paste-into-Claude end to end.
