import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();

// Drag the window by pressing anywhere on the pill except the capture button.
// `data-tauri-drag-region` is unreliable on borderless windows, so we call
// startDragging() explicitly. (Requires the capability to apply to this window
// — see capabilities/default.json "windows": ["*"].)
const bar = document.getElementById("bar")!;
bar.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("#snap")) return; // let the capture click through
  void win.startDragging();
});

document.getElementById("snap")!.addEventListener("click", () => invoke("start_capture"));

// Persist position after the user drags the window.
win.onMoved(({ payload }) => {
  void invoke("save_floating_position", { x: payload.x, y: payload.y });
});
