import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { wrapText, computeCanvasHeight } from "./lib/compositor";

type Tool = "rect" | "arrow" | "pen" | "text";
interface Shape { tool: Tool; x: number; y: number; x2: number; y2: number; points?: {x:number;y:number}[]; text?: string; }

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
  img.onload = () => { baseImage = img; canvas.width = img.width; canvas.height = img.height; redraw(); };
  img.src = `data:image/png;base64,${b64}`;
}

function redraw() {
  if (!baseImage) return;
  canvas.width = baseImage.width; canvas.height = baseImage.height;
  ctx.drawImage(baseImage, 0, 0);
  ctx.lineWidth = 3; ctx.strokeStyle = "#ff2d55"; ctx.fillStyle = "#ff2d55";
  for (const s of [...shapes, drawing].filter(Boolean) as Shape[]) drawShape(s);
}

function drawShape(s: Shape) {
  ctx.beginPath();
  if (s.tool === "rect") {
    ctx.strokeRect(s.x, s.y, s.x2 - s.x, s.y2 - s.y);
  } else if (s.tool === "arrow") {
    ctx.moveTo(s.x, s.y); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    const a = Math.atan2(s.y2 - s.y, s.x2 - s.x);
    ctx.beginPath(); ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - 12 * Math.cos(a - 0.4), s.y2 - 12 * Math.sin(a - 0.4));
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - 12 * Math.cos(a + 0.4), s.y2 - 12 * Math.sin(a + 0.4));
    ctx.stroke();
  } else if (s.tool === "pen" && s.points) {
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (s.tool === "text" && s.text) {
    ctx.font = "20px -apple-system, sans-serif";
    ctx.fillText(s.text, s.x, s.y);
  }
}

canvas.addEventListener("mousedown", (e) => {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (canvas.width / r.width);
  const y = (e.clientY - r.top) * (canvas.height / r.height);
  if (tool === "text") {
    const text = prompt("Label text:");
    if (text) { shapes.push({ tool, x, y, x2: x, y2: y, text }); redraw(); }
    return;
  }
  drawing = { tool, x, y, x2: x, y2: y, points: tool === "pen" ? [{ x, y }] : undefined };
});
canvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (canvas.width / r.width);
  const y = (e.clientY - r.top) * (canvas.height / r.height);
  drawing.x2 = x; drawing.y2 = y;
  if (drawing.tool === "pen") drawing.points!.push({ x, y });
  redraw();
});
window.addEventListener("mouseup", () => { if (drawing) { shapes.push(drawing); drawing = null; redraw(); } });

document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => { tool = b.dataset.tool as Tool; }));
document.getElementById("undo")!.addEventListener("click", () => { shapes.pop(); redraw(); });
document.getElementById("clear")!.addEventListener("click", () => { shapes = []; redraw(); });
document.getElementById("cancel")!.addEventListener("click", () => getCurrentWindow().close());
document.getElementById("copy")!.addEventListener("click", onCopy);

// onCopy: caption-band compositing implemented in a later task. Placeholder keeps the build typed.
async function onCopy() {
  // TODO(next task): composite caption band + invoke copy_composite
}

listen("capture-updated", () => { shapes = []; loadCapture(); });
loadCapture();
// keep imports + the message field referenced until the next task uses them in onCopy
void wrapText; void computeCanvasHeight; void messageEl;
