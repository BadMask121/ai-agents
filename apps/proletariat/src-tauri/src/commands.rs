use std::path::PathBuf;
use std::sync::Mutex;

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
    let state = app.state::<Mutex<Option<PathBuf>>>();
    let path = state.lock().unwrap().clone().ok_or("no capture available")?;
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

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(crate::settings::read_all(&app))
}

#[tauri::command]
pub fn set_setting(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    crate::settings::set(&app, &key, value);
    crate::apply::on_setting_changed(&app, &key);
    Ok(())
}

#[tauri::command]
pub fn save_floating_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    crate::settings::set(&app, "floating_x", x.into());
    crate::settings::set(&app, "floating_y", y.into());
    Ok(())
}

#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    crate::permission::open_screen_recording_settings();
    Ok(())
}
