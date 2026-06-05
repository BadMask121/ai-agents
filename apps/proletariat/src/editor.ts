import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

type Tool = "rect" | "arrow" | "pen";
interface Shape {
  tool: Tool;
  x: number;
  y: number;
  x2: number;
  y2: number;
  points?: { x: number; y: number }[];
}

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const messageEl = document.getElementById("message") as HTMLTextAreaElement;
let baseImage: HTMLImageElement | null = null;
let shapes: Shape[] = [];
let tool: Tool = "rect";
let drawing: Shape | null = null;

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
  ctx.strokeStyle = "#ff2d55";
  for (const s of [...shapes, drawing].filter(Boolean) as Shape[]) drawShape(s);
}

function drawShape(s: Shape) {
  ctx.beginPath();
  if (s.tool === "rect") {
    ctx.strokeRect(s.x, s.y, s.x2 - s.x, s.y2 - s.y);
  } else if (s.tool === "arrow") {
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
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
}

function toCanvasCoords(e: MouseEvent) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

canvas.addEventListener("mousedown", (e) => {
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
function selectTool(next: Tool) {
  tool = next;
  for (const b of toolButtons) b.classList.toggle("active", b.dataset.tool === next);
}
toolButtons.forEach((b) => b.addEventListener("click", () => selectTool(b.dataset.tool as Tool)));
selectTool("rect");

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

// Copy the annotated screenshot AND the typed message (as editable text) to the
// clipboard together, then close. The text is sent separately — not baked into
// the image — so it pastes into Claude as editable text alongside the image.
async function onCopy() {
  if (!baseImage) return;
  const text = messageEl.value.trim();
  const b64 = canvas.toDataURL("image/png").split(",")[1];
  await invoke("copy_to_clipboard", { pngBase64: b64, text });
  await getCurrentWindow().close();
}

listen("capture-updated", () => {
  shapes = [];
  loadCapture();
});
loadCapture();
