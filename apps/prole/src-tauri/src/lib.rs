mod apply;
mod capture;
mod clipboard;
mod commands;
mod permission;
mod settings;
mod windows;

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::<Option<std::path::PathBuf>>::new(None))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let capture = MenuItem::with_id(app, "capture", "Capture", true, None::<&str>)?;
            let toggle = MenuItem::with_id(
                app,
                "toggle_float",
                "Toggle Floating Button",
                true,
                None::<&str>,
            )?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Prole", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&capture, &toggle, &settings, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => commands::trigger_capture(app.clone()),
                    "toggle_float" => {
                        if let Err(e) = windows::toggle_floating(app) {
                            eprintln!("toggle_floating failed: {e}");
                        }
                    }
                    "settings" => {
                        let _ = windows::open_settings(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if settings::floating_enabled(app.handle()) {
                let _ = windows::show_floating(app.handle());
            }
            crate::apply::register_hotkey(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::get_capture,
            commands::copy_image,
            commands::get_settings,
            commands::set_setting,
            commands::save_floating_position,
            commands::open_screen_recording_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Prole")
        .run(|_app, event| {
            // Menu-bar app: closing the last window (e.g. toggling off the
            // floating button, or closing the editor) must NOT quit the app.
            // Tauri fires ExitRequested with code=None on last-window-closed,
            // and code=Some(_) for an explicit app.exit() (tray "Quit"), which
            // we let proceed.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
