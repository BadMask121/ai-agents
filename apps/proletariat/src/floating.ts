import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();

// Drag the window from the grip. `data-tauri-drag-region` is unreliable on
// interactive/borderless windows, so we call startDragging() explicitly.
const grip = document.getElementById("grip")!;
grip.addEventListener("mousedown", (e) => {
  if (e.button === 0) win.startDragging();
});

document.getElementById("snap")!.addEventListener("click", () => invoke("start_capture"));

// Persist position after the user drags the window.
win.onMoved(({ payload }) => {
  void invoke("save_floating_position", { x: payload.x, y: payload.y });
});
