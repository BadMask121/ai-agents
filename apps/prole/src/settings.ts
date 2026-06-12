import { invoke } from "@tauri-apps/api/core";

const floating = document.getElementById("floating_enabled") as HTMLInputElement;
const launch = document.getElementById("launch_at_login") as HTMLInputElement;
const hotkey = document.getElementById("hotkey") as HTMLInputElement;

async function init() {
  const s = await invoke<Record<string, unknown>>("get_settings");
  floating.checked = Boolean(s.floating_enabled);
  launch.checked = Boolean(s.launch_at_login);
  hotkey.value = String(s.hotkey ?? "");
}

floating.addEventListener("change", () => invoke("set_setting", { key: "floating_enabled", value: floating.checked }));
launch.addEventListener("change", () => invoke("set_setting", { key: "launch_at_login", value: launch.checked }));
hotkey.addEventListener("change", () => invoke("set_setting", { key: "hotkey", value: hotkey.value }));

init();
