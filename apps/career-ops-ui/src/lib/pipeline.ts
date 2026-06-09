import { promises as fs } from "node:fs";
import { p } from "./paths";

export type PipelineState = "pending" | "processed" | "blocked";

export type PipelineItem = {
  id: string;
  state: PipelineState;
  url: string;
  company: string | null;
  title: string | null;
  num: number | null;
  score: number | null;
  pdfReady: boolean;
  error: string | null;
  raw: string;
};

const LINE_RE = /^-\s+\[([ x!])\]\s+(.+?)$/;
const NUM_RE = /^#(\d+)$/;
const SCORE_RE = /^([\d.]+)\s*\/\s*5$/;
const PDF_RE = /^PDF\s*(✅|❌|YES|NO|TRUE|FALSE)$/i;
const URL_RE = /https?:\/\/\S+/;
// em dash, en dash, or " -- " — used by `- [!] URL — Error: reason`
const BLOCKED_SEP_RE = /\s[—–]\s|\s--\s/;

function parseLine(line: string): PipelineItem | null {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const [, mark, rest] = m;
  const state: PipelineState =
    mark === "x" ? "processed" : mark === "!" ? "blocked" : "pending";

  let url: string | null = null;
  let company: string | null = null;
  let title: string | null = null;
  let num: number | null = null;
  let score: number | null = null;
  let pdfReady = false;
  let error: string | null = null;

  if (state === "blocked") {
    // - [!] URL — Error: reason
    const sepMatch = rest.match(BLOCKED_SEP_RE);
    if (sepMatch && sepMatch.index !== undefined) {
      const head = rest.slice(0, sepMatch.index).trim();
      const tail = rest.slice(sepMatch.index + sepMatch[0].length).trim();
      const u = head.match(URL_RE);
      if (u) url = stripUrlTrailing(u[0]);
      error = tail.replace(/^Error:\s*/i, "") || null;
    } else {
      const u = rest.match(URL_RE);
      if (u) url = stripUrlTrailing(u[0]);
    }
  } else {
    // Pending or processed: pipe-separated segments.
    // Pending:   `- [ ] URL` or `- [ ] URL | Company | Title`
    // Processed: `- [x] #NNN | URL | Company | Role | X.X/5 | PDF ✅/❌`
    const segments = rest
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);

    const remaining: string[] = [];

    for (const seg of segments) {
      const numM = seg.match(NUM_RE);
      if (numM && num === null) {
        num = parseInt(numM[1], 10);
        continue;
      }

      const scoreM = seg.match(SCORE_RE);
      if (scoreM && score === null) {
        score = parseFloat(scoreM[1]);
        continue;
      }

      const pdfM = seg.match(PDF_RE);
      if (pdfM) {
        const v = pdfM[1];
        pdfReady = v === "✅" || /^(YES|TRUE)$/i.test(v);
        continue;
      }

      const urlM = seg.match(URL_RE);
      if (urlM && !url) {
        url = stripUrlTrailing(urlM[0]);
        continue;
      }

      remaining.push(seg);
    }

    // Whatever's left, in order, is company then title.
    if (remaining.length >= 1) company = remaining[0];
    if (remaining.length >= 2) title = remaining.slice(1).join(" | ");
  }

  if (!url) {
    const u = line.match(URL_RE);
    if (u) url = stripUrlTrailing(u[0]);
  }
  if (!url) return null;

  return {
    id: Buffer.from(url).toString("base64url"),
    state,
    url,
    company,
    title,
    num,
    score,
    pdfReady,
    error,
    raw: rest,
  };
}

function stripUrlTrailing(u: string): string {
  return u.replace(/[),.;]+$/, "");
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

  if (i.state === "processed" && i.score !== null) {
    const parts: string[] = [];
    if (i.num !== null) parts.push(`#${i.num}`);
    parts.push(i.url);
    if (i.company) parts.push(i.company);
    if (i.title) parts.push(i.title);
    parts.push(`${i.score.toFixed(1)}/5`);
    parts.push(`PDF ${i.pdfReady ? "✅" : "❌"}`);
    return `- [${mark}] ${parts.join(" | ")}`;
  }

  if (i.state === "blocked") {
    return `- [${mark}] ${i.url}${i.error ? ` — ${i.error}` : ""}`;
  }

  const parts = [i.url];
  if (i.company) parts.push(i.company);
  if (i.title) parts.push(i.title);
  return `- [${mark}] ${parts.join(" | ")}`;
}

function blankItem(
  url: string,
  state: PipelineState,
  meta?: { company?: string; title?: string },
): PipelineItem {
  return {
    id: Buffer.from(url).toString("base64url"),
    state,
    url,
    company: meta?.company ?? null,
    title: meta?.title ?? null,
    num: null,
    score: null,
    pdfReady: false,
    error: null,
    raw: "",
  };
}

export async function addUrl(
  url: string,
  meta?: { company?: string; title?: string },
): Promise<PipelineItem> {
  const items = await readPipeline();
  const existing = items.find((i) => i.url === url);
  if (existing) return existing;

  const item = blankItem(url, "pending", meta);
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

// Richer mutator used by the reconcile flow after /career-ops auto-pipeline
// finishes running — lets us patch score/num/pdfReady onto an item in one
// atomic read-modify-write instead of multiple setState calls.
export async function enrichItem(
  id: string,
  patch: Partial<
    Pick<
      PipelineItem,
      "state" | "num" | "score" | "pdfReady" | "error" | "company" | "title"
    >
  >,
): Promise<PipelineItem> {
  const items = await readPipeline();
  const target = items.find((i) => i.id === id);
  if (!target) throw new Error(`pipeline item not found: ${id}`);

  if (patch.state !== undefined) target.state = patch.state;
  if (patch.num !== undefined) target.num = patch.num;
  if (patch.score !== undefined) target.score = patch.score;
  if (patch.pdfReady !== undefined) target.pdfReady = patch.pdfReady;
  if (patch.error !== undefined) target.error = patch.error;
  if (patch.company !== undefined) target.company = patch.company;
  if (patch.title !== undefined) target.title = patch.title;

  await writePipeline(items);
  return target;
}

export async function removeItem(id: string): Promise<void> {
  const items = await readPipeline();
  const filtered = items.filter((i) => i.id !== id);
  await writePipeline(filtered);
}
