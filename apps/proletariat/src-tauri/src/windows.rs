use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn open_editor(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("editor") {
        w.set_focus()?;
        w.emit("capture-updated", ())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("src/editor.html".into()))
        .title("Proletariat — Markup")
        .inner_size(1000.0, 760.0)
        .resizable(true)
        .build()?;
    Ok(())
}

pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("src/settings.html".into()))
        .title("Proletariat — Settings")
        .inner_size(420.0, 360.0)
        .resizable(false)
        .build()?;
    Ok(())
}

/// True if the point (x, y) falls within the bounds of any connected monitor.
/// Saved positions can become stale — e.g. an external display that was to the
/// left (negative x) or below (large y) the main screen is later unplugged — and
/// a pill placed there is invisible, which looks identical to "toggle is broken".
fn position_on_screen(app: &AppHandle, x: f64, y: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return true; // can't tell — don't override the saved position
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        let (mx, my) = (p.x as f64, p.y as f64);
        x >= mx && x < mx + s.width as f64 && y >= my && y < my + s.height as f64
    })
}

pub fn show_floating(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("floating") {
        w.show()?;
        return Ok(());
    }
    let mut x = crate::settings::get(app, "floating_x")
        .and_then(|v| v.as_f64())
        .unwrap_or(80.0);
    let mut y = crate::settings::get(app, "floating_y")
        .and_then(|v| v.as_f64())
        .unwrap_or(80.0);
    if !position_on_screen(app, x, y) {
        // Stale/off-screen saved position — fall back to a known-visible spot.
        x = 80.0;
        y = 80.0;
    }
    WebviewWindowBuilder::new(app, "floating", WebviewUrl::App("src/floating.html".into()))
        .title("Proletariat")
        .inner_size(112.0, 48.0)
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
    // Flip visibility on a single persistent window rather than destroying and
    // rebuilding it. `close()` tears down asynchronously, so a destroy/rebuild
    // toggle races its own teardown: a rapid second toggle either still sees the
    // dying window or fails `build()` with "a window with label `floating`
    // already exists" — making the toggle intermittently no-op. hide()/show()
    // is synchronous, race-free, and retains the window's position for free.
    match app.get_webview_window("floating") {
        Some(w) => {
            if w.is_visible()? {
                w.hide()?;
                crate::settings::set(app, "floating_enabled", false.into());
            } else {
                w.show()?;
                crate::settings::set(app, "floating_enabled", true.into());
            }
        }
        None => {
            show_floating(app)?;
            crate::settings::set(app, "floating_enabled", true.into());
        }
    }
    Ok(())
}

pub fn open_permission_guide(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("permission") {
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "permission", WebviewUrl::App("src/permission.html".into()))
        .title("Proletariat — Permission needed")
        .inner_size(440.0, 280.0)
        .resizable(false)
        .build()?;
    Ok(())
}
