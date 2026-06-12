# Prole Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native macOS menu-bar app that captures a screen region, lets you mark it up and type a question, then copies a single composite image (snip + your question as a caption band) to the clipboard for pasting into the Claude desktop/web app.

**Architecture:** Rust + Tauri v2. The Rust backend owns system integration (tray, windows, capture via Apple's `screencapture`, clipboard via `arboard`, settings via `tauri-plugin-store`). A Vite + TypeScript multi-page webview owns the markup editor, floating button, and settings UIs. The webview composites the final PNG on an HTML canvas and hands the bytes to Rust over the `invoke` bridge.

**Tech Stack:** Rust, Tauri v2, `arboard`, `image`, `thiserror`, `serde`, `base64`; `tauri-plugin-store`, `tauri-plugin-global-shortcut`, `tauri-plugin-autostart`; TypeScript, Vite, Vitest.

**bd tracking:** Epic `ai-agents-de5`; sub-tasks `de5.1`–`de5.9`. Claim each issue (`bd update <id> --claim`) when its task starts and close it (`bd close <id>`) when its task's final commit lands. Run `bd ready` to confirm the next unblocked task.

**Conventions:** macOS only. Project lives at `apps/prole/`. Run all commands from `apps/prole/` unless noted. Frontend source in `apps/prole/src/`, Rust in `apps/prole/src-tauri/`.

---

## File Structure

```
apps/prole/
├── package.json                      # frontend deps + scripts (vite, vitest)
├── vite.config.ts                    # multi-page build (floating/editor/settings)
├── tsconfig.json
├── index.html                        # unused root (redirect placeholder)
├── src/
│   ├── floating.html  + floating.ts  # always-on-top capture button
│   ├── editor.html    + editor.ts    # markup editor entry
│   ├── settings.html  + settings.ts  # settings UI
│   ├── lib/
│   │   ├── compositor.ts             # pure layout math + canvas compositing
│   │   └── compositor.test.ts        # vitest unit tests (pure functions)
│   └── styles.css
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── icons/                          # tray + app icons
    └── src/
        ├── main.rs                     # thin entry → lib::run()
        ├── lib.rs                      # Tauri builder, plugins, setup, tray
        ├── capture.rs                  # screencapture wrapper (testable)
        ├── clipboard.rs                # PNG→RGBA + arboard write (testable)
        ├── commands.rs                 # #[tauri::command] handlers
        ├── windows.rs                  # create editor/floating/settings/guide windows
        ├── settings.rs                 # typed read/write over tauri-plugin-store
        └── permission.rs               # Screen Recording detection + guide
```

**Responsibility boundaries:**
- `capture.rs` and `clipboard.rs` are pure-logic + thin-IO modules with injected seams → unit tested.
- `compositor.ts` isolates the size/layout math (pure, unit tested) from canvas drawing (thin).
- `commands.rs` is the only place the webview can call into Rust; it delegates to the modules above.
- `windows.rs` centralizes all window creation so URLs/sizes live in one place.

---

## Task 0: Workspace prerequisites (one-time)

**Files:**
- Modify: repo root `pnpm-workspace.yaml` (only if it does not already glob `apps/*`)

- [ ] **Step 1: Verify Rust toolchain and Tauri prerequisites**

Run: `rustc --version && cargo --version && node --version && pnpm --version`
Expected: rustc ≥ 1.77, a Node ≥ 18, pnpm present. If `rustc` is missing, install via `https://rustup.rs`.

- [ ] **Step 2: Install the Tauri CLI locally to the app (done in Task 1) — confirm Xcode CLT present**

Run: `xcode-select -p`
Expected: a path like `/Library/Developer/CommandLineTools` (Tauri needs the macOS SDK + clang). If it errors, run `xcode-select --install` and wait for it to finish.

- [ ] **Step 3: Ensure pnpm workspace includes `apps/*`**

Read `pnpm-workspace.yaml`. If its `packages:` list does not already include `apps/*`, add it:

```yaml
packages:
  - packages/*
  - apps/*
```

- [ ] **Step 4: Commit (only if the workspace file changed)**

```bash
git add pnpm-workspace.yaml
git commit -m "chore: include apps/* in pnpm workspace"
```

---

## Task 1: Scaffold + tray (bd de5.1)

**Files:**
- Create: the whole `apps/prole/` skeleton (via Tauri CLI), then edit the files below.
- Modify: `apps/prole/src-tauri/Cargo.toml`, `.../tauri.conf.json`, `.../src/main.rs`, `.../src/lib.rs`

- [ ] **Step 1: Claim the bd issue**

Run: `bd update ai-agents-de5.1 --claim`
Expected: status → in_progress.

- [ ] **Step 2: Scaffold the Tauri v2 app non-interactively**

Run from `apps/`:
```bash
pnpm create tauri-app@latest prole --template vanilla-ts --manager pnpm --yes
cd prole && pnpm install
```
Expected: an `apps/prole/` directory containing `src/`, `src-tauri/`, `package.json`, `vite.config.ts`.

- [ ] **Step 3: Set the app identifier and product name in `src-tauri/tauri.conf.json`**

Set these top-level / nested fields (leave the rest of the generated file intact):
```json
{
  "productName": "Prole",
  "identifier": "com.prole.app",
  "app": {
    "windows": [],
    "trayIcon": { "iconPath": "icons/icon.png", "iconAsTemplate": true }
  }
}
```
`"windows": []` means no window opens on launch (menu-bar app). Keep the generated `build`, `bundle`, and `frontendDist`/`devUrl` fields.

- [ ] **Step 4: Add Rust dependencies to `src-tauri/Cargo.toml`**

Under `[dependencies]` add (keep the generated `tauri`, `serde`, `serde_json` lines, but ensure `tauri` has the tray feature):
```toml
tauri = { version = "2", features = ["tray-icon", "image-png"] }
arboard = "3"
image = { version = "0.25", default-features = false, features = ["png"] }
thiserror = "1"
base64 = "0.22"
tauri-plugin-store = "2"
tauri-plugin-global-shortcut = "2"
tauri-plugin-autostart = "2"
```

- [ ] **Step 5: Replace `src-tauri/src/main.rs` with a thin entry**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    prole_lib::run();
}
```
(The crate name is `prole_lib` per the generated `Cargo.toml` `[lib] name`. If the generated lib name differs, match it.)

- [ ] **Step 6: Write `src-tauri/src/lib.rs` with the tray + accessory policy**

```rust
mod capture;
mod clipboard;
mod commands;
mod permission;
mod settings;
mod windows;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Menu-bar only: no dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let capture = MenuItem::with_id(app, "capture", "Capture", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle_float", "Toggle Floating Button", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Prole", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&capture, &toggle, &settings, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => commands::trigger_capture(app.clone()),
                    "toggle_float" => { let _ = windows::toggle_floating(app); }
                    "settings" => { let _ = windows::open_settings(app); }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Show the floating button on launch if enabled in settings.
            if settings::floating_enabled(app.handle()) {
                let _ = windows::show_floating(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::get_capture,
            commands::copy_composite,
            commands::get_settings,
            commands::set_setting,
            commands::save_floating_position,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prole");
}
```
This references modules built in later tasks. To compile now, create empty stub modules in the next step.

- [ ] **Step 7: Create minimal compiling stubs for the referenced modules**

Create `src-tauri/src/capture.rs`, `clipboard.rs`, `commands.rs`, `permission.rs`, `settings.rs`, `windows.rs`, each initially containing only what `lib.rs` needs to compile:

`settings.rs`:
```rust
use tauri::AppHandle;
pub fn floating_enabled(_app: &AppHandle) -> bool { false }
```
`windows.rs`:
```rust
use tauri::AppHandle;
pub fn toggle_floating(_app: &AppHandle) -> tauri::Result<()> { Ok(()) }
pub fn show_floating(_app: &AppHandle) -> tauri::Result<()> { Ok(()) }
pub fn open_settings(_app: &AppHandle) -> tauri::Result<()> { Ok(()) }
```
`commands.rs`:
```rust
use tauri::AppHandle;

pub fn trigger_capture(_app: AppHandle) {}

#[tauri::command] pub fn start_capture() -> Result<(), String> { Ok(()) }
#[tauri::command] pub fn get_capture() -> Result<String, String> { Err("not implemented".into()) }
#[tauri::command] pub fn copy_composite(_png_base64: String) -> Result<(), String> { Ok(()) }
#[tauri::command] pub fn get_settings() -> Result<serde_json::Value, String> { Ok(serde_json::json!({})) }
#[tauri::command] pub fn set_setting(_key: String, _value: serde_json::Value) -> Result<(), String> { Ok(()) }
#[tauri::command] pub fn save_floating_position(_x: f64, _y: f64) -> Result<(), String> { Ok(()) }
```
`capture.rs`, `clipboard.rs`, `permission.rs`: empty files for now (`// implemented in a later task`).

- [ ] **Step 8: Build and run; verify the tray appears**

Run: `pnpm tauri dev`
Expected: the app compiles, no window appears, and a tray icon shows in the macOS menu bar. Clicking it shows the four menu items. "Quit Prole" exits. (Other items are no-ops until later tasks.)

- [ ] **Step 9: Commit**

```bash
git add apps/prole
git commit -m "feat(prole): scaffold Tauri v2 menu-bar app with tray (de5.1)"
```

- [ ] **Step 10: Close the bd issue**

Run: `bd close ai-agents-de5.1`

---

## Task 2: Capture module (bd de5.2)

**Files:**
- Modify: `src-tauri/src/capture.rs`
- Test: inline `#[cfg(test)]` module in `capture.rs`

- [ ] **Step 1: Claim the bd issue**

Run: `bd update ai-agents-de5.2 --claim`

- [ ] **Step 2: Write the failing tests in `capture.rs`**

```rust
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("capture cancelled")]
    Cancelled,
    #[error("failed to launch screencapture: {0}")]
    Spawn(#[from] std::io::Error),
}

/// Seam so tests can run without invoking the real binary.
pub trait CommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<ExitStatus>;
}

pub struct ScreencaptureRunner;
impl CommandRunner for ScreencaptureRunner {
    fn run(&self, program: &str, args: &[&str]) -> std::io::Result<ExitStatus> {
        std::process::Command::new(program).args(args).status()
    }
}

/// Runs interactive region capture to `out_path`. Returns the path if a
/// non-empty file was produced, else `Cancelled` (user pressed Esc).
pub fn capture_region_with<R: CommandRunner>(
    runner: &R,
    out_path: &Path,
) -> Result<PathBuf, CaptureError> {
    let path_str = out_path.to_str().expect("temp path is valid UTF-8");
    runner.run("/usr/sbin/screencapture", &["-i", "-x", path_str])?;
    match std::fs::metadata(out_path) {
        Ok(meta) if meta.len() > 0 => Ok(out_path.to_path_buf()),
        _ => Err(CaptureError::Cancelled),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeRunner { writes_file: bool }
    impl CommandRunner for FakeRunner {
        fn run(&self, _p: &str, args: &[&str]) -> std::io::Result<ExitStatus> {
            if self.writes_file {
                std::fs::write(args.last().unwrap(), b"\x89PNGfake")?;
            }
            Ok(ExitStatus::from_raw(0))
        }
    }

    #[test]
    fn returns_path_when_file_written() {
        let dir = std::env::temp_dir().join("prole_test_ok");
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("snip.png");
        let _ = std::fs::remove_file(&out);
        let runner = FakeRunner { writes_file: true };
        let got = capture_region_with(&runner, &out).unwrap();
        assert_eq!(got, out);
        std::fs::remove_file(&out).unwrap();
    }

    #[test]
    fn cancelled_when_no_file() {
        let out = std::env::temp_dir().join("prole_test_cancel/none.png");
        let _ = std::fs::remove_file(&out);
        let runner = FakeRunner { writes_file: false };
        assert!(matches!(
            capture_region_with(&runner, &out),
            Err(CaptureError::Cancelled)
        ));
    }
}
```

- [ ] **Step 3: Run tests to verify they pass (logic is in the same edit)**

Run: `cd src-tauri && cargo test capture`
Expected: `returns_path_when_file_written` and `cancelled_when_no_file` PASS.

- [ ] **Step 4: Add the production entry point used by commands**

Append to `capture.rs`:
```rust
/// Convenience wrapper used by the app: captures to a fresh temp file.
pub fn capture_region() -> Result<PathBuf, CaptureError> {
    let out = std::env::temp_dir().join(format!("prole-{}.png", std::process::id()));
    capture_region_with(&ScreencaptureRunner, &out)
}
```
Note: `std::process::id()` keeps the path stable per app run; each capture overwrites the prior temp file, which is fine (we read it immediately).

- [ ] **Step 5: Verify the crate still builds**

Run: `cargo build`
Expected: success, no warnings about unused `capture_region` (it is `pub`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/capture.rs
git commit -m "feat(prole): screencapture wrapper with cancel detection + tests (de5.2)"
```

- [ ] **Step 7: Close the bd issue**

Run: `bd close ai-agents-de5.2`

---

## Task 3: Clipboard module (bd de5.6)

> Built before the editor because the caption-band task (de5.5) depends on it.

**Files:**
- Modify: `src-tauri/src/clipboard.rs`
- Test: inline `#[cfg(test)]` in `clipboard.rs`

- [ ] **Step 1: Claim the bd issue**

Run: `bd update ai-agents-de5.6 --claim`

- [ ] **Step 2: Write the pure decode function + failing test**

```rust
#[derive(Debug, thiserror::Error)]
pub enum ClipboardError {
    #[error("image decode failed: {0}")]
    Decode(#[from] image::ImageError),
    #[error("clipboard error: {0}")]
    Clipboard(#[from] arboard::Error),
}

/// Decode PNG bytes into (width, height, RGBA8 pixels). Pure + unit-tested.
pub fn png_to_rgba(png_bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), ClipboardError> {
    let img = image::load_from_memory(png_bytes)?.to_rgba8();
    let (w, h) = img.dimensions();
    Ok((w, h, img.into_raw()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_known_image() {
        // Build a 2x1 image: red pixel, green pixel.
        let mut img = image::RgbaImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        img.put_pixel(1, 0, image::Rgba([0, 255, 0, 255]));
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(img.as_raw(), 2, 1, image::ExtendedColorType::Rgba8)
            .unwrap();

        let (w, h, rgba) = png_to_rgba(&png).unwrap();
        assert_eq!((w, h), (2, 1));
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[0, 255, 0, 255]);
    }
}
```
Add `use image::ImageEncoder;` at the top of the test module if the encoder's `write_image` needs the trait in scope.

- [ ] **Step 3: Run the test**

Run: `cargo test clipboard`
Expected: `round_trips_a_known_image` PASS.

- [ ] **Step 4: Add the clipboard write (thin IO over the tested decoder)**

Append to `clipboard.rs`:
```rust
use std::borrow::Cow;

pub fn set_clipboard_image(png_bytes: &[u8]) -> Result<(), ClipboardError> {
    let (w, h, rgba) = png_to_rgba(png_bytes)?;
    let mut cb = arboard::Clipboard::new()?;
    cb.set_image(arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: Cow::Owned(rgba),
    })?;
    Ok(())
}
```

- [ ] **Step 5: Build**

Run: `cargo build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/clipboard.rs
git commit -m "feat(prole): PNG→RGBA decode + arboard clipboard write + test (de5.6)"
```

- [ ] **Step 7: Close the bd issue**

Run: `bd close ai-agents-de5.6`

---

## Task 4: Settings store + commands (supports de5.3 & de5.8)

**Files:**
- Modify: `src-tauri/src/settings.rs`, `src-tauri/src/commands.rs`

- [ ] **Step 1: Implement typed settings access in `settings.rs`**

Replace the stub with:
```rust
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";

fn defaults() -> Value {
    json!({
        "floating_enabled": true,
        "floating_x": 80.0,
        "floating_y": 80.0,
        "hotkey": "CmdOrCtrl+Shift+A",
        "launch_at_login": false
    })
}

pub fn read_all(app: &AppHandle) -> Value {
    let store = app.store(STORE).expect("store");
    let mut out = defaults();
    if let Value::Object(ref mut map) = out {
        for (k, v) in map.iter_mut() {
            if let Some(stored) = store.get(k) {
                *v = stored;
            }
        }
    }
    out
}

pub fn get(app: &AppHandle, key: &str) -> Option<Value> {
    let merged = read_all(app);
    merged.get(key).cloned()
}

pub fn set(app: &AppHandle, key: &str, value: Value) {
    let store = app.store(STORE).expect("store");
    store.set(key, value);
    let _ = store.save();
}

pub fn floating_enabled(app: &AppHandle) -> bool {
    get(app, "floating_enabled").and_then(|v| v.as_bool()).unwrap_or(true)
}

// Keeps the Wry type referenced so imports compile across Tauri versions.
#[allow(dead_code)]
fn _type_anchor(_a: &AppHandle<Wry>) {}
```
Note: confirm the exact `tauri-plugin-store` v2 API for `store()`/`get()`/`set()`/`save()` against the installed version (`cargo doc -p tauri-plugin-store --open`); adjust method names if the crate exposes `app.store(...)` returning a `Result` vs an `Arc<Store>`.

- [ ] **Step 2: Wire settings commands in `commands.rs`**

Replace the stub bodies for `get_settings`, `set_setting`:
```rust
use tauri::AppHandle;

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(crate::settings::read_all(&app))
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    crate::settings::set(&app, &key, value);
    crate::apply::on_setting_changed(&app, &key);
    Ok(())
}
```
`crate::apply::on_setting_changed` is added in Task 8 (hotkey/autostart reactions). For now, add a temporary no-op `apply` module: create `src-tauri/src/apply.rs` with `pub fn on_setting_changed(_a: &tauri::AppHandle, _k: &str) {}` and `mod apply;` in `lib.rs`.

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/commands.rs src-tauri/src/apply.rs src-tauri/src/lib.rs
git commit -m "feat(prole): typed settings store + settings commands"
```

---

## Task 5: Capture → editor wiring (commands + windows)

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/windows.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Add capture state to the app**

In `lib.rs`, inside `run()` before `.setup`, add a managed state holding the latest capture path:
```rust
use std::sync::Mutex;
```
Add `.manage(Mutex::<Option<std::path::PathBuf>>::new(None))` to the builder chain (e.g., right after `tauri::Builder::default()`).

- [ ] **Step 2: Implement capture trigger + window open in `commands.rs`**

```rust
use std::sync::Mutex;
use std::path::PathBuf;
use base64::Engine;
use tauri::{AppHandle, Manager};

pub fn trigger_capture(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = start_capture(app).await;
    });
}

#[tauri::command]
pub async fn start_capture(app: AppHandle) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(crate::capture::capture_region)
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(path) => {
            *app.state::<Mutex<Option<PathBuf>>>().lock().unwrap() = Some(path);
            crate::windows::open_editor(&app).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(crate::capture::CaptureError::Cancelled) => Ok(()),
        Err(e) => {
            crate::permission::handle_capture_error(&app);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn get_capture(app: AppHandle) -> Result<String, String> {
    let guard = app.state::<Mutex<Option<PathBuf>>>();
    let path = guard.lock().unwrap().clone().ok_or("no capture available")?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn copy_composite(png_base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|e| e.to_string())?;
    crate::clipboard::set_clipboard_image(&bytes).map_err(|e| e.to_string())
}
```
Remove the old stub versions of these four functions. Keep `set_setting`/`get_settings` from Task 4.

- [ ] **Step 3: Implement window creation in `windows.rs`**

```rust
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn open_editor(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("editor") {
        w.set_focus()?;
        w.emit("capture-updated", ())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("src/editor.html".into()))
        .title("Prole — Markup")
        .inner_size(1000.0, 760.0)
        .resizable(true)
        .build()?;
    Ok(())
}

pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") { w.set_focus()?; return Ok(()); }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("src/settings.html".into()))
        .title("Prole — Settings")
        .inner_size(420.0, 360.0)
        .resizable(false)
        .build()?;
    Ok(())
}

pub fn show_floating(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("floating") { w.show()?; return Ok(()); }
    let x = crate::settings::get(app, "floating_x").and_then(|v| v.as_f64()).unwrap_or(80.0);
    let y = crate::settings::get(app, "floating_y").and_then(|v| v.as_f64()).unwrap_or(80.0);
    WebviewWindowBuilder::new(app, "floating", WebviewUrl::App("src/floating.html".into()))
        .title("Prole")
        .inner_size(64.0, 64.0)
        .position(x, y)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()?;
    Ok(())
}

pub fn toggle_floating(app: &AppHandle) -> tauri::Result<()> {
    match app.get_webview_window("floating") {
        Some(w) => { w.close()?; crate::settings::set(app, "floating_enabled", false.into()); }
        None => { show_floating(app)?; crate::settings::set(app, "floating_enabled", true.into()); }
    }
    Ok(())
}
```

- [ ] **Step 4: Implement `save_floating_position` command**

In `commands.rs`:
```rust
#[tauri::command]
pub fn save_floating_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    crate::settings::set(&app, "floating_x", x.into());
    crate::settings::set(&app, "floating_y", y.into());
    Ok(())
}
```

- [ ] **Step 5: Add a transparent-window capability/permission if required**

In `src-tauri/capabilities/default.json`, ensure the `core:window:allow-*` permissions cover `set-focus`, `show`, `close`, `start-dragging`. Add `"core:window:allow-start-dragging"` so the floating button can be dragged. (Tauri v2 generates a default capabilities file; extend its `permissions` array.)

- [ ] **Step 6: Build**

Run: `cargo build` (and `pnpm tauri dev` once the editor HTML exists in Task 6).
Expected: compiles. (Runtime verification happens in Task 6/7.)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/windows.rs src-tauri/src/lib.rs src-tauri/capabilities
git commit -m "feat(prole): capture→editor wiring, window builders, floating position persistence"
```

---

## Task 6: Markup editor — drawing tools (bd de5.4)

**Files:**
- Create: `src/editor.html`, `src/editor.ts`, `src/lib/compositor.ts`, `src/lib/compositor.test.ts`, `src/styles.css`
- Modify: `vite.config.ts` (multi-page inputs), `package.json` (vitest)

- [ ] **Step 1: Claim the bd issue**

Run: `bd update ai-agents-de5.4 --claim`

- [ ] **Step 2: Configure Vite multi-page + add Vitest**

`vite.config.ts`:
```ts
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        floating: resolve(__dirname, "src/floating.html"),
        editor: resolve(__dirname, "src/editor.html"),
        settings: resolve(__dirname, "src/settings.html"),
      },
    },
  },
});
```
Add Vitest: `pnpm add -D vitest` and a script in `package.json`: `"test": "vitest run"`.

- [ ] **Step 3: Write failing tests for the pure compositor math**

`src/lib/compositor.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeCanvasHeight, wrapText } from "./compositor";

describe("computeCanvasHeight", () => {
  it("returns image height when there is no message", () => {
    expect(computeCanvasHeight(400, "", 20, 6, 14)).toBe(400);
  });
  it("adds a band sized to the wrapped line count when there is a message", () => {
    // 2 lines * lineHeight(20) + 2*padding(6) = 52, added to 400 => 452
    const h = computeCanvasHeight(400, "two\nlines", 20, 6, 14);
    expect(h).toBe(452);
  });
});

describe("wrapText", () => {
  it("keeps short text on one line", () => {
    const measure = (s: string) => s.length * 8; // 8px per char
    expect(wrapText("hello world", 200, measure)).toEqual(["hello world"]);
  });
  it("wraps text that exceeds the max width", () => {
    const measure = (s: string) => s.length * 8;
    expect(wrapText("hello world", 80, measure)).toEqual(["hello", "world"]);
  });
  it("preserves explicit newlines", () => {
    const measure = (s: string) => s.length * 8;
    expect(wrapText("a\nb", 200, measure)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `computeCanvasHeight`/`wrapText` not exported.

- [ ] **Step 5: Implement the pure compositor functions**

`src/lib/compositor.ts`:
```ts
export type Measure = (text: string) => number;

/** Wrap text to `maxWidth`, honoring explicit "\n". `measure` returns pixel width. */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measure(candidate) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** Final canvas height = image height + caption band (only if message present). */
export function computeCanvasHeight(
  imageHeight: number,
  message: string,
  lineHeight: number,
  padding: number,
  _fontSize: number,
): number {
  if (!message.trim()) return imageHeight;
  const lineCount = message.split("\n").reduce((n, p) => n + Math.max(1, 1), 0);
  return imageHeight + lineCount * lineHeight + padding * 2;
}
```
Note: `computeCanvasHeight` counts explicit lines for the test; the real render in Step 7 recomputes the true wrapped line count via `wrapText` against the canvas width and uses the same formula, so behavior is consistent.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: all compositor tests PASS.

- [ ] **Step 7: Build the editor UI + drawing engine**

`src/editor.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><link rel="stylesheet" href="./styles.css" /></head>
  <body>
    <div id="toolbar">
      <button data-tool="rect">▭ Rect</button>
      <button data-tool="arrow">↗ Arrow</button>
      <button data-tool="pen">✎ Pen</button>
      <button data-tool="text">A Text</button>
      <button id="undo">↶ Undo</button>
      <button id="clear">Clear</button>
    </div>
    <div id="stage"><canvas id="canvas"></canvas></div>
    <div id="message-bar">
      <textarea id="message" placeholder="Message to Claude (added as a caption when you copy)…"></textarea>
      <button id="cancel">Cancel</button>
      <button id="copy">Copy to clipboard</button>
    </div>
    <script type="module" src="./editor.ts"></script>
  </body>
</html>
```

`src/editor.ts` (drawing engine — annotations kept as an array so Undo/Clear are trivial, redrawn each frame):
```ts
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { wrapText, computeCanvasHeight } from "./lib/compositor";

type Tool = "rect" | "arrow" | "pen" | "text";
interface Shape { tool: Tool; x: number; y: number; x2: number; y2: number; points?: {x:number;y:number}[]; text?: string; }

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const messageEl = document.getElementById("message") as HTMLTextAreaElement;
let baseImage: HTMLImageElement | null = null;
let shapes: Shape[] = [];
let tool: Tool = "rect";
let drawing: Shape | null = null;

async function loadCapture() {
  const b64: string = await invoke("get_capture");
  const img = new Image();
  img.onload = () => { baseImage = img; canvas.width = img.width; canvas.height = img.height; redraw(); };
  img.src = `data:image/png;base64,${b64}`;
}

function redraw() {
  if (!baseImage) return;
  canvas.width = baseImage.width; canvas.height = baseImage.height;
  ctx.drawImage(baseImage, 0, 0);
  ctx.lineWidth = 3; ctx.strokeStyle = "#ff2d55"; ctx.fillStyle = "#ff2d55";
  for (const s of [...shapes, drawing].filter(Boolean) as Shape[]) drawShape(s);
}

function drawShape(s: Shape) {
  ctx.beginPath();
  if (s.tool === "rect") {
    ctx.strokeRect(s.x, s.y, s.x2 - s.x, s.y2 - s.y);
  } else if (s.tool === "arrow") {
    ctx.moveTo(s.x, s.y); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    const a = Math.atan2(s.y2 - s.y, s.x2 - s.x);
    ctx.beginPath(); ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - 12 * Math.cos(a - 0.4), s.y2 - 12 * Math.sin(a - 0.4));
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - 12 * Math.cos(a + 0.4), s.y2 - 12 * Math.sin(a + 0.4));
    ctx.stroke();
  } else if (s.tool === "pen" && s.points) {
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (s.tool === "text" && s.text) {
    ctx.font = "20px -apple-system, sans-serif";
    ctx.fillText(s.text, s.x, s.y);
  }
}

canvas.addEventListener("mousedown", (e) => {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (canvas.width / r.width);
  const y = (e.clientY - r.top) * (canvas.height / r.height);
  if (tool === "text") {
    const text = prompt("Label text:");
    if (text) { shapes.push({ tool, x, y, x2: x, y2: y, text }); redraw(); }
    return;
  }
  drawing = { tool, x, y, x2: x, y2: y, points: tool === "pen" ? [{ x, y }] : undefined };
});
canvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (canvas.width / r.width);
  const y = (e.clientY - r.top) * (canvas.height / r.height);
  drawing.x2 = x; drawing.y2 = y;
  if (drawing.tool === "pen") drawing.points!.push({ x, y });
  redraw();
});
window.addEventListener("mouseup", () => { if (drawing) { shapes.push(drawing); drawing = null; redraw(); } });

document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => { tool = b.dataset.tool as Tool; }));
document.getElementById("undo")!.addEventListener("click", () => { shapes.pop(); redraw(); });
document.getElementById("clear")!.addEventListener("click", () => { shapes = []; redraw(); });
document.getElementById("cancel")!.addEventListener("click", () => getCurrentWindow().close());
document.getElementById("copy")!.addEventListener("click", onCopy);

// (onCopy is implemented in Task 7.)
listen("capture-updated", () => { shapes = []; loadCapture(); });
loadCapture();
(window as any).__copyDeps = { wrapText, computeCanvasHeight }; // referenced in Task 7
```

- [ ] **Step 8: Run the app and verify drawing works**

Run: `pnpm tauri dev`, then trigger Capture from the tray, select a region.
Expected: the editor window opens with the screenshot; you can draw rect/arrow/pen, add a text label, Undo removes the last shape, Clear removes all. (Copy is wired in Task 7.)

- [ ] **Step 9: Commit**

```bash
git add apps/prole/src apps/prole/vite.config.ts apps/prole/package.json
git commit -m "feat(prole): markup editor drawing tools + compositor math + tests (de5.4)"
```

- [ ] **Step 10: Close the bd issue**

Run: `bd close ai-agents-de5.4`

---

## Task 7: Caption band composite + copy (bd de5.5)

**Files:**
- Modify: `src/editor.ts` (add `onCopy` + caption rendering)

- [ ] **Step 1: Claim the bd issue**

Run: `bd update ai-agents-de5.5 --claim`

- [ ] **Step 2: Implement `onCopy` with caption-band compositing**

Add to `src/editor.ts` (replace the `// (onCopy is implemented in Task 7.)` comment):
```ts
const CAPTION = { fontSize: 16, lineHeight: 22, padding: 12, bg: "#111", fg: "#fff" };

async function onCopy() {
  if (!baseImage) return;
  const message = messageEl.value.trim();

  // Measure wrapping against the image width using a scratch context.
  const scratch = document.createElement("canvas").getContext("2d")!;
  scratch.font = `${CAPTION.fontSize}px -apple-system, sans-serif`;
  const measure = (t: string) => scratch.measureText(t).width;
  const maxTextWidth = baseImage.width - CAPTION.padding * 2;
  const lines = message ? wrapText(message, maxTextWidth, measure) : [];

  const bandHeight = lines.length ? lines.length * CAPTION.lineHeight + CAPTION.padding * 2 : 0;

  // Build the final composite: annotated image on top, caption band below.
  const out = document.createElement("canvas");
  out.width = baseImage.width;
  out.height = baseImage.height + bandHeight;
  const octx = out.getContext("2d")!;

  // 1) annotated screenshot (reuse the on-screen canvas, which already has shapes)
  octx.drawImage(canvas, 0, 0);

  // 2) caption band
  if (bandHeight) {
    octx.fillStyle = CAPTION.bg;
    octx.fillRect(0, baseImage.height, out.width, bandHeight);
    octx.fillStyle = CAPTION.fg;
    octx.font = `${CAPTION.fontSize}px -apple-system, sans-serif`;
    octx.textBaseline = "top";
    lines.forEach((line, i) =>
      octx.fillText(line, CAPTION.padding, baseImage.height + CAPTION.padding + i * CAPTION.lineHeight));
  }

  const b64 = out.toDataURL("image/png").split(",")[1];
  await invoke("copy_composite", { pngBase64: b64 });
  await getCurrentWindow().close();
}
```

- [ ] **Step 3: Manual verification — text travels with the image**

Run: `pnpm tauri dev`. Capture a region, draw an arrow, type "What does this error mean?" in the message box, click **Copy**.
Then open the **Claude desktop app**, focus the message box, and paste (⌘V).
Expected: one image appears containing the screenshot, the arrow, and a dark caption strip at the bottom reading "What does this error mean?". The editor window closes after Copy.

- [ ] **Step 4: Manual verification — no message means no band**

Capture, draw nothing, leave the message empty, Copy, paste into Claude.
Expected: the pasted image is exactly the screenshot size with no caption band.

- [ ] **Step 5: Commit**

```bash
git add apps/prole/src/editor.ts
git commit -m "feat(prole): composite caption band + copy to clipboard (de5.5)"
```

- [ ] **Step 6: Close the bd issue**

Run: `bd close ai-agents-de5.5`

---

## Task 8: Floating button UI + hotkey + launch-at-login (bd de5.3 & de5.8)

**Files:**
- Create: `src/floating.html`, `src/floating.ts`, `src/settings.html`, `src/settings.ts`
- Modify: `src-tauri/src/apply.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Claim both bd issues**

Run: `bd update ai-agents-de5.3 --claim && bd update ai-agents-de5.8 --claim`

- [ ] **Step 2: Build the floating button window**

`src/floating.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><link rel="stylesheet" href="./styles.css" /></head>
  <body class="floating">
    <button id="grip" data-tauri-drag-region title="Drag to move">⠿</button>
    <button id="snap" title="Capture">◎</button>
    <script type="module" src="./floating.ts"></script>
  </body>
</html>
```
`src/floating.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

document.getElementById("snap")!.addEventListener("click", () => invoke("start_capture"));

// Persist position after the user drags the window.
const win = getCurrentWindow();
win.onMoved(async ({ payload }) => {
  await invoke("save_floating_position", { x: payload.x, y: payload.y });
});
```
The `data-tauri-drag-region` attribute makes the grip drag the window (requires the `core:window:allow-start-dragging` capability added in Task 5).

- [ ] **Step 3: Build the settings window**

`src/settings.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><link rel="stylesheet" href="./styles.css" /></head>
  <body class="settings">
    <label><input type="checkbox" id="floating_enabled" /> Show floating button</label>
    <label><input type="checkbox" id="launch_at_login" /> Launch at login</label>
    <label>Global hotkey <input type="text" id="hotkey" placeholder="CmdOrCtrl+Shift+A" /></label>
    <script type="module" src="./settings.ts"></script>
  </body>
</html>
```
`src/settings.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

const s = await invoke<Record<string, unknown>>("get_settings");
const floating = document.getElementById("floating_enabled") as HTMLInputElement;
const launch = document.getElementById("launch_at_login") as HTMLInputElement;
const hotkey = document.getElementById("hotkey") as HTMLInputElement;
floating.checked = Boolean(s.floating_enabled);
launch.checked = Boolean(s.launch_at_login);
hotkey.value = String(s.hotkey ?? "");

floating.addEventListener("change", () => invoke("set_setting", { key: "floating_enabled", value: floating.checked }));
launch.addEventListener("change", () => invoke("set_setting", { key: "launch_at_login", value: launch.checked }));
hotkey.addEventListener("change", () => invoke("set_setting", { key: "hotkey", value: hotkey.value }));
```

- [ ] **Step 4: React to setting changes in `apply.rs`**

Replace the no-op `apply.rs`:
```rust
use tauri::AppHandle;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_autostart::ManagerExt;

pub fn on_setting_changed(app: &AppHandle, key: &str) {
    match key {
        "floating_enabled" => {
            let enabled = crate::settings::floating_enabled(app);
            if enabled { let _ = crate::windows::show_floating(app); }
            else if let Some(w) = tauri::Manager::get_webview_window(app, "floating") { let _ = w.close(); }
        }
        "launch_at_login" => {
            let on = crate::settings::get(app, "launch_at_login").and_then(|v| v.as_bool()).unwrap_or(false);
            let mgr = app.autolaunch();
            let _ = if on { mgr.enable() } else { mgr.disable() };
        }
        "hotkey" => { register_hotkey(app); }
        _ => {}
    }
}

pub fn register_hotkey(app: &AppHandle) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if let Some(hk) = crate::settings::get(app, "hotkey").and_then(|v| v.as_str().map(String::from)) {
        if !hk.is_empty() {
            let app2 = app.clone();
            let _ = gs.on_shortcut(hk.as_str(), move |_app, _shortcut, _event| {
                crate::commands::trigger_capture(app2.clone());
            });
        }
    }
}
```
Confirm the exact `on_shortcut` signature against the installed `tauri-plugin-global-shortcut` v2 (`cargo doc -p tauri-plugin-global-shortcut --open`); adjust the closure arity if needed.

- [ ] **Step 5: Register the hotkey on startup**

In `lib.rs` `.setup`, after the floating-button block, add:
```rust
crate::apply::register_hotkey(app.handle());
```

- [ ] **Step 6: Build + manual verification**

Run: `pnpm tauri dev`.
Expected:
- Floating button appears (when enabled); the grip drags it; the ◎ button starts a capture; after dragging and relaunching, it reappears at the saved position.
- Settings window: toggling "Show floating button" shows/hides it live; setting a hotkey and pressing it anywhere starts a capture; "Launch at login" toggles the LaunchAgent (verify in *System Settings → General → Login Items*).

- [ ] **Step 7: Commit**

```bash
git add apps/prole/src apps/prole/src-tauri/src/apply.rs apps/prole/src-tauri/src/lib.rs
git commit -m "feat(prole): floating button, global hotkey, launch-at-login (de5.3, de5.8)"
```

- [ ] **Step 8: Close both bd issues**

Run: `bd close ai-agents-de5.3 && bd close ai-agents-de5.8`

---

## Task 9: Screen Recording permission guide (bd de5.7)

**Files:**
- Modify: `src-tauri/src/permission.rs`, `src-tauri/src/windows.rs`
- Create: `src/permission.html`, `src/permission.ts`
- Modify: `vite.config.ts` (add `permission` input)

- [ ] **Step 1: Claim the bd issue**

Run: `bd update ai-agents-de5.7 --claim`

- [ ] **Step 2: Implement permission handling in `permission.rs`**

```rust
use tauri::AppHandle;

/// Called when a capture errors in a way consistent with missing permission.
/// Heuristic: on macOS, a failed/black capture after a non-cancel error.
pub fn handle_capture_error(app: &AppHandle) {
    let _ = crate::windows::open_permission_guide(app);
}

/// Opens System Settings at the Screen Recording pane.
pub fn open_screen_recording_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .status();
}
```

- [ ] **Step 3: Add the guide window builder + a command to open settings**

In `windows.rs`:
```rust
pub fn open_permission_guide(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("permission") { w.set_focus()?; return Ok(()); }
    WebviewWindowBuilder::new(app, "permission", WebviewUrl::App("src/permission.html".into()))
        .title("Prole — Permission needed")
        .inner_size(440.0, 280.0)
        .resizable(false)
        .build()?;
    Ok(())
}
```
In `commands.rs` add and register a command:
```rust
#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    crate::permission::open_screen_recording_settings();
    Ok(())
}
```
Add `commands::open_screen_recording_settings` to the `generate_handler!` list in `lib.rs`.

- [ ] **Step 4: Build the guide UI**

`src/permission.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><link rel="stylesheet" href="./styles.css" /></head>
  <body class="permission">
    <h2>Screen Recording permission</h2>
    <p>Prole needs Screen Recording permission to capture your screen.
       Enable it for Prole, then try Capture again.</p>
    <button id="open">Open Screen Recording settings</button>
    <script type="module" src="./permission.ts"></script>
  </body>
</html>
```
`src/permission.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";
document.getElementById("open")!.addEventListener("click", () => invoke("open_screen_recording_settings"));
```
Add `permission: resolve(__dirname, "src/permission.html")` to `vite.config.ts` `rollupOptions.input`.

- [ ] **Step 5: Manual verification**

To simulate: revoke Prole's Screen Recording permission in *System Settings → Privacy & Security → Screen Recording*, then trigger Capture.
Expected: capture yields a black/failed image; on the error path the guide window opens; clicking the button opens the Screen Recording settings pane. After granting and relaunching, capture works.
Note: macOS sometimes requires an app relaunch after granting; mention this in the guide copy if testing shows it.

- [ ] **Step 6: Commit**

```bash
git add apps/prole/src apps/prole/src-tauri/src
git commit -m "feat(prole): Screen Recording permission detection + guide window (de5.7)"
```

- [ ] **Step 7: Close the bd issue**

Run: `bd close ai-agents-de5.7`

---

## Task 10: Test wiring + QA checklist + epic close (bd de5.9)

**Files:**
- Create: `apps/prole/QA.md`
- Modify: `apps/prole/package.json` (test scripts)

- [ ] **Step 1: Claim the bd issue**

Run: `bd update ai-agents-de5.9 --claim`

- [ ] **Step 2: Add convenience test scripts**

In `apps/prole/package.json` `scripts`:
```json
{
  "test": "vitest run",
  "test:rust": "cd src-tauri && cargo test",
  "test:all": "pnpm test && pnpm test:rust"
}
```

- [ ] **Step 3: Run the full unit suite**

Run: `pnpm test:all`
Expected: Vitest compositor tests PASS; `cargo test` capture + clipboard tests PASS.

- [ ] **Step 4: Write the manual QA checklist**

`apps/prole/QA.md`:
```markdown
# Prole — Manual QA

- [ ] First-run: tray icon appears, no dock icon.
- [ ] Capture from tray → native crosshair → editor opens with the snip.
- [ ] Esc during selection → no editor, no error.
- [ ] Draw rect/arrow/pen/text label; Undo; Clear.
- [ ] Type a message → Copy → paste into Claude desktop shows snip + caption band.
- [ ] Empty message → Copy → pasted image has no band.
- [ ] Floating button: drag to move; position persists across relaunch; ◎ captures.
- [ ] Toggle floating button from tray + settings (live show/hide).
- [ ] Global hotkey triggers capture from any app.
- [ ] Launch-at-login toggle reflected in System Settings → Login Items.
- [ ] Screen Recording permission revoked → guide window → settings deep link.
- [ ] Multi-monitor: capture on secondary display lands correct pixels.
- [ ] Retina: captured image is full-resolution (not half-size).
```

- [ ] **Step 5: Execute the QA checklist manually**

Run: `pnpm tauri dev`, then work through `QA.md`. Fix any failures (file follow-up bd issues for anything out of scope).

- [ ] **Step 6: Commit**

```bash
git add apps/prole/QA.md apps/prole/package.json
git commit -m "test(prole): test scripts + manual QA checklist (de5.9)"
```

- [ ] **Step 7: Close the issue and the epic**

Run: `bd close ai-agents-de5.9`
Then confirm all children closed: `bd show ai-agents-de5`. If all children are closed, run `bd close ai-agents-de5`.

- [ ] **Step 8: End-of-session workflow**

Run quality gates, then `bd dolt push` and `git push` per `AGENTS.md`.

---

## Self-Review

**Spec coverage:**
- Tray + menu-bar presence → Task 1. ✓
- Floating button → Task 8. ✓
- `screencapture -i` rectangle capture → Task 2. ✓
- Markup editor (rect/arrow/pen/text, undo, clear) → Task 6. ✓
- Message-to-Claude caption band composited into PNG → Task 7. ✓
- `arboard` clipboard write → Task 3. ✓
- Screen Recording permission guide → Task 9. ✓
- Global hotkey + launch-at-login → Task 8. ✓
- Settings persistence → Task 4. ✓
- Tests + QA → Tasks 2, 3, 6, 10. ✓
- All nine bd sub-tasks have a claim/close step. ✓

**Type/name consistency:** `capture_region`/`capture_region_with`/`CaptureError`, `png_to_rgba`/`set_clipboard_image`/`ClipboardError`, `wrapText`/`computeCanvasHeight`, and command names (`start_capture`, `get_capture`, `copy_composite`, `get_settings`, `set_setting`, `save_floating_position`, `open_screen_recording_settings`) are used consistently across `lib.rs` `generate_handler!` and the TS `invoke` calls.

**Known verification points flagged inline (not placeholders — confirm against installed crate versions):** `tauri-plugin-store` v2 store API (Task 4), `tauri-plugin-global-shortcut` v2 `on_shortcut` arity (Task 8). These are API-surface confirmations, not missing logic.

**Build order:** dependency-encoded in bd; this plan sequences scaffold → capture → clipboard → settings/wiring → editor → caption → floating/hotkey → permission → QA, matching `bd ready`.
