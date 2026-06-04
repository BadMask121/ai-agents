# Proletariat — Manual QA

Run `pnpm tauri dev` (from `apps/proletariat/`), then work through this list. Anything
that can't be verified in code lives here. File follow-up bd issues for failures.

## First run / presence
- [ ] Tray icon appears in the menu bar; no dock icon (accessory app).
- [ ] Tray menu shows: Capture / Toggle Floating Button / Settings… / Quit Proletariat.
- [ ] Quit Proletariat exits the app.

## Capture + editor
- [ ] Tray → Capture opens the native crosshair; selecting a region opens the editor with the snip.
- [ ] Esc during selection → no editor, no error (silent cancel).
- [ ] Draw rectangle, arrow, freehand pen; add a text label (prompt).
- [ ] Undo removes the last shape; Clear removes all shapes.
- [ ] Cancel closes the editor without copying.

## Caption band + clipboard
- [ ] Type a message → Copy → paste into the Claude desktop app shows snip + dark caption band with the message.
- [ ] Empty message → Copy → pasted image has NO caption band (exact screenshot size).
- [ ] Wrapped/multi-line message renders on multiple caption lines.

## Floating button
- [ ] Floating button appears when enabled; transparent background, on top.
- [ ] Grip (⠿) drags the window; ◎ starts a capture.
- [ ] Position persists across relaunch (drag, quit, reopen → same spot).

## Settings
- [ ] Settings window reflects current values (floating, launch-at-login, hotkey).
- [ ] Toggling "Show floating button" shows/hides it live (and via tray Toggle).
- [ ] Setting a hotkey and pressing it from any app starts a capture.
- [ ] "Launch at login" toggle is reflected in System Settings → General → Login Items.

## Permission
- [ ] With Screen Recording revoked, Capture → guide window appears.
- [ ] Guide button opens System Settings → Privacy & Security → Screen Recording.
- [ ] After granting (and relaunch if prompted), Capture works.

## Display correctness
- [ ] Multi-monitor: capture on a secondary display lands the correct pixels.
- [ ] Retina: captured image is full-resolution (not half-size).

## Automated suites (must pass before release)
- [ ] `pnpm test` — frontend compositor tests (5).
- [ ] `pnpm test:rust` — capture + clipboard tests (3).
- [ ] `pnpm test:all` — both.
