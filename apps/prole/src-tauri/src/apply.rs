use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub fn on_setting_changed(app: &AppHandle, key: &str) {
    match key {
        "floating_enabled" => {
            let enabled = crate::settings::floating_enabled(app);
            if enabled {
                let _ = crate::windows::show_floating(app);
            } else if let Some(w) = tauri::Manager::get_webview_window(app, "floating") {
                // hide(), not close(): keep the window alive so the tray toggle
                // and the Settings toggle agree on one source of truth
                // (visibility) and never race window teardown. See toggle_floating.
                let _ = w.hide();
            }
        }
        "launch_at_login" => {
            let on = crate::settings::get(app, "launch_at_login")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mgr = app.autolaunch();
            let _ = if on { mgr.enable() } else { mgr.disable() };
        }
        "hotkey" => {
            register_hotkey(app);
        }
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
