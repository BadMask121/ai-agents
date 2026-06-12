import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

type Tool = "rect" | "arrow" | "pen" | "text";
interface Shape {
  tool: Tool;
  x: number;
  y: number;
  x2: number;
  y2: number;
  points?: { x: number; y: number }[];
  text?: string;
  size?: number; // canvas-space px for text annotations
}

const ACCENT = "#ff2d55";
const DEFAULT_TEXT_SIZE = 52; // canvas-space px; bigger default reads well on hi-res snips
let textSize = DEFAULT_TEXT_SIZE; // current size applied to new text annotations

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let baseImage: HTMLImageElement | null = null;
let shapes: Shape[] = [];
let tool: Tool = "rect";
let drawing: Shape | null = null;
let textInput: HTMLInputElement | null = null;

async function loadCapture() {
  const b64: string = await invoke("get_capture");
  const img = new Image();
  img.onload = () => {
    baseImage = img;
    canvas.width = img.width;
    canvas.height = img.height;
    redraw();
  };
  img.src = `data:image/png;base64,${b64}`;
}

function redraw() {
  if (!baseImage) return;
  canvas.width = baseImage.width;
  canvas.height = baseImage.height;
  ctx.drawImage(baseImage, 0, 0);
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of [...shapes, drawing].filter(Boolean) as Shape[]) drawShape(s);
}

function drawShape(s: Shape) {
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  if (s.tool === "rect") {
    ctx.strokeRect(s.x, s.y, s.x2 - s.x, s.y2 - s.y);
  } else if (s.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    const a = Math.atan2(s.y2 - s.y, s.x2 - s.x);
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - 14 * Math.cos(a - 0.4), s.y2 - 14 * Math.sin(a - 0.4));
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - 14 * Math.cos(a + 0.4), s.y2 - 14 * Math.sin(a + 0.4));
    ctx.stroke();
  } else if (s.tool === "pen" && s.points) {
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (s.tool === "text" && s.text) {
    ctx.font = `600 ${s.size ?? DEFAULT_TEXT_SIZE}px -apple-system, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(s.text, s.x, s.y);
  }
}

function toCanvasCoords(e: MouseEvent) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
    scale: r.width / canvas.width, // display px per canvas px
  };
}

// Inline text annotation: a small input placed at the click point. Commits on
// Enter or blur, cancels on Escape. Replaces the old prompt() dialog.
function placeTextInput(e: MouseEvent) {
  const { x, y, scale } = toCanvasCoords(e);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "text-input";
  input.style.left = `${e.clientX}px`;
  input.style.top = `${e.clientY}px`;
  input.style.fontSize = `${textSize * scale}px`;
  document.body.appendChild(input);
  textInput = input;
  // Defer focus so the click that created it doesn't immediately blur it.
  requestAnimationFrame(() => input.focus());

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value) {
      shapes.push({ tool: "text", x, y, x2: x, y2: y, text: value, size: textSize });
    }
    input.remove();
    if (textInput === input) textInput = null;
    redraw();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

canvas.addEventListener("mousedown", (e) => {
  if (textInput) return; // let the active text input commit via its blur first
  if (tool === "text") {
    placeTextInput(e);
    return;
  }
  const { x, y } = toCanvasCoords(e);
  drawing = { tool, x, y, x2: x, y2: y, points: tool === "pen" ? [{ x, y }] : undefined };
});
canvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const { x, y } = toCanvasCoords(e);
  drawing.x2 = x;
  drawing.y2 = y;
  if (drawing.tool === "pen") drawing.points!.push({ x, y });
  redraw();
});
window.addEventListener("mouseup", () => {
  if (drawing) {
    shapes.push(drawing);
    drawing = null;
    redraw();
  }
});

const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tool]"));
const textProps = document.getElementById("textProps") as HTMLElement;
function selectTool(next: Tool) {
  tool = next;
  canvas.style.cursor = next === "text" ? "text" : "crosshair";
  for (const b of toolButtons) b.classList.toggle("active", b.dataset.tool === next);
  textProps.hidden = next !== "text"; // text-size control only applies to the text tool
}
toolButtons.forEach((b) => b.addEventListener("click", () => selectTool(b.dataset.tool as Tool)));
selectTool("rect");

// Text size control (numeric field + steppers). Applies to new text annotations.
const MIN_TEXT_SIZE = 8;
const MAX_TEXT_SIZE = 240;
const sizeInput = document.getElementById("sizeInput") as HTMLInputElement;
function setTextSize(next: number) {
  if (!Number.isFinite(next)) return;
  textSize = Math.max(MIN_TEXT_SIZE, Math.min(MAX_TEXT_SIZE, Math.round(next)));
  sizeInput.value = String(textSize);
  // If a text annotation is mid-edit, reflect the new size live.
  if (textInput) {
    const scale = canvas.getBoundingClientRect().width / canvas.width;
    textInput.style.fontSize = `${textSize * scale}px`;
  }
}
sizeInput.value = String(textSize);
sizeInput.addEventListener("input", () => setTextSize(Number(sizeInput.value)));
// Don't let clicking the steppers blur (and commit) an in-progress text input.
for (const id of ["sizeDown", "sizeUp"]) {
  const btn = document.getElementById(id)!;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => setTextSize(textSize + (id === "sizeUp" ? 4 : -4)));
}

document.getElementById("undo")!.addEventListener("click", () => {
  shapes.pop();
  redraw();
});
document.getElementById("clear")!.addEventListener("click", () => {
  shapes = [];
  redraw();
});
document.getElementById("cancel")!.addEventListener("click", () => getCurrentWindow().close());
document.getElementById("copy")!.addEventListener("click", onCopy);

// Copy the annotated image (only) to the clipboard, then close. Any text the
// user wants for Claude is part of the image via the text annotation tool.
async function onCopy() {
  if (!baseImage) return;
  if (textInput) textInput.blur(); // commit any in-progress text first
  const b64 = canvas.toDataURL("image/png").split(",")[1];
  await invoke("copy_image", { pngBase64: b64 });
  await getCurrentWindow().close();
}

listen("capture-updated", () => {
  shapes = [];
  loadCapture();
});
loadCapture();
