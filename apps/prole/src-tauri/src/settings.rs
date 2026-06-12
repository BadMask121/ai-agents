use serde_json::{json, Value};
use tauri::AppHandle;
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

/// All settings = defaults overlaid with any stored overrides.
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
    read_all(app).get(key).cloned()
}

pub fn set(app: &AppHandle, key: &str, value: Value) {
    let store = app.store(STORE).expect("store");
    store.set(key, value);
    let _ = store.save();
}

pub fn floating_enabled(app: &AppHandle) -> bool {
    get(app, "floating_enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}
