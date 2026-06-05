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

pub fn show_floating(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("floating") {
        w.show()?;
        return Ok(());
    }
    let x = crate::settings::get(app, "floating_x")
        .and_then(|v| v.as_f64())
        .unwrap_or(80.0);
    let y = crate::settings::get(app, "floating_y")
        .and_then(|v| v.as_f64())
        .unwrap_or(80.0);
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
    match app.get_webview_window("floating") {
        Some(w) => {
            w.close()?;
            crate::settings::set(app, "floating_enabled", false.into());
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
