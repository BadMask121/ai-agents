# 02 — Stack & key decisions

Each decision lists the choice, the rationale, and the alternatives weighed.

## Language + framework: Rust + Tauri v2

**Chosen.** Native macOS feel with a small binary, a webview for the markup UI (HTML canvas is ideal for
drawing tools), first-class tray/window/global-shortcut support, and Rust for the system glue (process
spawning, clipboard).

- *Alternative — Swift / SwiftUI:* most native, but the user explicitly wants Rust + Tauri, and a canvas
  markup UI is faster to build in a webview.
- *Alternative — Electron:* heavier, no Rust, larger footprint.

## Screen capture: shell out to `screencapture -i` (approach A)

**Chosen.** Invoke Apple's `/usr/sbin/screencapture -i <temp.png>` for rectangle selection.

- ✅ Reuses Apple's native crosshair selector (the exact `⌘⇧4` UX), handles multi-monitor + Retina, and
  routes the Screen Recording permission through the OS.
- ✅ Minimal Rust, fewest edge cases, ships fast.
- ⚠️ No control over the selector's look; no element-awareness.
- *Alternative — approach B: custom Tauri overlay + ScreenCaptureKit/Core Graphics.* Full control and the
  only path to agentation-style element hovering (via the Accessibility API), but far more macOS FFI work,
  manual permission + multi-monitor + scaling handling. Deferred; the architecture can swap to it later.

## Why pixels-only (no selectors / source paths / OCR)

Agentation extracts CSS selectors, source paths, and React trees because it runs **inside the browser
DOM**. There is **no DOM** for arbitrary native apps, so that metadata cannot exist here. The native analog
(macOS Accessibility API) yields only element roles/labels/bounds, only for apps that expose them, and is
unnecessary for the Q&A goal — a rectangle screenshot grabs *anything* and Claude's vision reads it. OCR
was considered and deferred: vision handles on-screen text well enough for v1.

## Getting the typed question to Claude: caption band baked into the image

**Constraint:** a single paste into the Claude app carries **either an image or text, not both**. To make
the user's "Message to Claude" travel *with* the screenshot in one paste, the markup editor renders it as a
**caption band appended below the image** and exports one composite PNG.

- *Alternative — copy note as plain text:* crisper text for Claude, but forces two separate paste/attach
  steps. Deferred as a possible toggle.
- *Alternative — multi-flavor clipboard (image + text):* unreliable; the target app picks one on paste.

## Clipboard write: `arboard` crate (Rust side)

**Chosen.** Rust decodes the composite PNG and writes the image to the system clipboard via `arboard`,
which has reliable macOS image support. Avoids flaky webview `navigator.clipboard` image writes.

## Delivery target

The clipboard image is pasted into the **Claude desktop / web app** (which accepts pasted images). Note the
**Claude Code terminal does not** accept pasted clipboard images — so the CLI is not a target for v1.
