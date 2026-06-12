import { invoke } from "@tauri-apps/api/core";
document.getElementById("open")!.addEventListener("click", () => invoke("open_screen_recording_settings"));
