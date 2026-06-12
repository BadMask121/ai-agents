use tauri::AppHandle;

/// Called when a capture errors in a way consistent with missing permission.
pub fn handle_capture_error(app: &AppHandle) {
    let _ = crate::windows::open_permission_guide(app);
}

/// Opens System Settings at the Screen Recording pane.
pub fn open_screen_recording_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .status();
}
