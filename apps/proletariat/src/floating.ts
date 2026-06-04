import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

document.getElementById("snap")!.addEventListener("click", () => invoke("start_capture"));

// Persist position after the user drags the window.
const win = getCurrentWindow();
win.onMoved(async ({ payload }) => {
  await invoke("save_floating_position", { x: payload.x, y: payload.y });
});
