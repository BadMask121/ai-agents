use tauri::AppHandle;

pub fn trigger_capture(_app: AppHandle) {}

#[tauri::command]
pub fn start_capture() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_capture() -> Result<String, String> {
    Err("not implemented".into())
}

#[tauri::command]
pub fn copy_composite(_png_base64: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    Ok(crate::settings::read_all(&app))
}

#[tauri::command]
pub fn set_setting(
    app: tauri::AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    crate::settings::set(&app, &key, value);
    crate::apply::on_setting_changed(&app, &key);
    Ok(())
}

#[tauri::command]
pub fn save_floating_position(_x: f64, _y: f64) -> Result<(), String> {
    Ok(())
}
