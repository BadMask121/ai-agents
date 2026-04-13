import { promises as fs } from "node:fs";
import { p } from "./paths";

export type PipelineState = "pending" | "processed" | "blocked";

export type PipelineItem = {
  id: string;
  state: PipelineState;
  url: string;
  company: string | null;
  title: string | null;
  raw: string;
};

const LINE_RE =
  /^-\s+\[([ x!])\]\s+(.+?)$/;

function parseLine(raw: string): PipelineItem | null {
  const m = raw.match(LINE_RE);
  if (!m) return null;
  const [, mark, rest] = m;
  const state: PipelineState =
    mark === "x" ? "processed" : mark === "!" ? "blocked" : "pending";

  // Format variants seen in scan.mjs and modes/pipeline.md:
  //   - [ ] https://... | Company | Title
  //   - [ ] https://...
  //   - [x] #NNN | https://... | Company | Role | Score | PDF ✅
  //   - [!] https://... — Error: ...
  const segments = rest.split("|").map((s) => s.trim()).filter(Boolean);

  let url: string | null = null;
  let company: string | null = null;
  let title: string | null = null;

  for (const seg of segments) {
    const urlMatch = seg.match(/https?:\/\/\S+/);
    if (urlMatch && !url) {
      url = urlMatch[0].replace(/[),.;]+$/, "");
      continue;
    }
    if (!company) {
      company = seg;
    } else if (!title) {
      title = seg;
    }
  }

  if (!url) {
    // fallback: look anywhere in the line for a URL
    const anyUrl = rest.match(/https?:\/\/\S+/);
    if (anyUrl) url = anyUrl[0].replace(/[),.;]+$/, "");
  }

  if (!url) return null;

  return {
    id: Buffer.from(url).toString("base64url"),
    state,
    url,
    company,
    title,
    raw,
  };
}

export async function readPipeline(): Promise<PipelineItem[]> {
  let text: string;
  try {
    text = await fs.readFile(p.pipeline, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const items: PipelineItem[] = [];
  for (const line of text.split("\n")) {
    const item = parseLine(line);
    if (item) items.push(item);
  }
  return items;
}

export async function writePipeline(items: PipelineItem[]): Promise<void> {
  // Rebuild the file preserving the section headers used by scan.mjs
  const pending = items.filter((i) => i.state === "pending");
  const blocked = items.filter((i) => i.state === "blocked");
  const processed = items.filter((i) => i.state === "processed");

  const body: string[] = ["# Pipeline", ""];
  body.push("## Pendientes", "");
  for (const i of pending) body.push(fmtLine(i));
  if (blocked.length > 0) {
    body.push("", "## Bloqueadas", "");
    for (const i of blocked) body.push(fmtLine(i));
  }
  body.push("", "## Procesadas", "");
  for (const i of processed) body.push(fmtLine(i));
  body.push("");

  await fs.mkdir(p.root + "/data", { recursive: true });
  await fs.writeFile(p.pipeline, body.join("\n"), "utf-8");
}

function fmtLine(i: PipelineItem): string {
  const mark = i.state === "processed" ? "x" : i.state === "blocked" ? "!" : " ";
  const parts = [i.url];
  if (i.company) parts.push(i.company);
  if (i.title) parts.push(i.title);
  return `- [${mark}] ${parts.join(" | ")}`;
}

export async function addUrl(
  url: string,
  meta?: { company?: string; title?: string },
): Promise<PipelineItem> {
  const items = await readPipeline();
  const existing = items.find((i) => i.url === url);
  if (existing) return existing;

  const item: PipelineItem = {
    id: Buffer.from(url).toString("base64url"),
    state: "pending",
    url,
    company: meta?.company ?? null,
    title: meta?.title ?? null,
    raw: "",
  };
  items.push(item);
  await writePipeline(items);
  return item;
}

export async function updateState(
  id: string,
  state: PipelineState,
): Promise<void> {
  const items = await readPipeline();
  const target = items.find((i) => i.id === id);
  if (!target) throw new Error(`pipeline item not found: ${id}`);
  target.state = state;
  await writePipeline(items);
}

export async function removeItem(id: string): Promise<void> {
  const items = await readPipeline();
  const filtered = items.filter((i) => i.id !== id);
  await writePipeline(filtered);
}
