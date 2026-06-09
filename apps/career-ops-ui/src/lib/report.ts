import { promises as fs } from "node:fs";
import path from "node:path";
import { p } from "./paths";

export type ReportSubScores = {
  cvMatch?: number;
  northStar?: number;
  comp?: number;
  cultural?: number;
  redFlags?: number;
  global?: number;
};

export type DraftAnswer = { question: string; answer: string };

export type ReportContent = {
  num: number;
  path: string;
  raw: string;
  subScores: ReportSubScores;
  sectionH: DraftAnswer[];
};

// Mirrors career-ops/analyze-patterns.mjs:126-148 verbatim so a single source-of-truth
// regex set drives both the backend pattern detector and the UI surface.
const SCORE_REGEXES: Record<keyof ReportSubScores, RegExp> = {
  cvMatch: /\|\s*(?:CV Match|Match con CV)\s*\|\s*([\d.]+)\/5\s*\|/i,
  northStar: /\|\s*(?:North Star)\s*\|\s*([\d.]+)\/5\s*\|/i,
  comp: /\|\s*(?:Comp)\s*\|\s*([\d.]+)\/5\s*\|/i,
  cultural: /\|\s*(?:Cultural signals|Cultural)\s*\|\s*([\d.]+)\/5\s*\|/i,
  redFlags: /\|\s*(?:Red flags)\s*\|\s*([-+]?[\d.]+)\s*\|/i,
  global: /\|\s*(?:Global)\s*\|\s*([\d.]+)\/5\s*\|/i,
};

export async function findReport(num: number): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(p.reports);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  // Reports are named e.g. `143-acme-ai-pm-2026-01-15.md`. The pipeline mode
  // numbers them sequentially with no zero padding, but accept padded variants
  // defensively in case that changes.
  const padded = String(num).padStart(3, "0");
  const candidates = [`${num}-`, `${padded}-`, `${num}_`, `${padded}_`];

  const match = entries.find(
    (name) =>
      name.endsWith(".md") && candidates.some((pref) => name.startsWith(pref)),
  );

  return match ? path.join(p.reports, match) : null;
}

export async function readReportWithScores(
  num: number,
): Promise<ReportContent | null> {
  const reportPath = await findReport(num);
  if (!reportPath) return null;

  const raw = await fs.readFile(reportPath, "utf-8");
  // Bold markers around table cells trip the regexes — strip them first
  // (mirrors the `plain` step in analyze-patterns.mjs).
  const plain = raw.replace(/\*\*/g, "");

  const subScores: ReportSubScores = {};
  for (const key of Object.keys(SCORE_REGEXES) as (keyof ReportSubScores)[]) {
    const m = plain.match(SCORE_REGEXES[key]);
    if (m) subScores[key] = parseFloat(m[1]);
  }

  return {
    num,
    path: reportPath,
    raw,
    subScores,
    sectionH: parseSectionH(raw),
  };
}

// Section H is `## H) Draft Application Answers`, only present on score >= 4.5
// runs (auto-pipeline.md:29). Format is freeform — auto-pipeline doesn't enforce
// a strict schema. We try the two common shapes the agent emits and fall back
// to an empty list (callers can render `report.raw` as fallback).
function parseSectionH(raw: string): DraftAnswer[] {
  const sectionRe =
    /^##\s+H\)?\s+Draft\s+Application\s+Answers\s*$([\s\S]*?)(?=^##\s+|\Z)/im;
  const m = raw.match(sectionRe);
  if (!m) return [];
  const body = m[1];

  const answers: DraftAnswer[] = [];

  // Shape 1: `### Question` (or `### N. Question`) followed by a paragraph
  const headingRe = /^###\s+(.+?)\s*$\n+([\s\S]*?)(?=^###\s+|\Z)/gm;
  let h: RegExpExecArray | null;
  while ((h = headingRe.exec(body)) !== null) {
    answers.push({
      question: h[1].trim(),
      answer: h[2].trim(),
    });
  }
  if (answers.length > 0) return answers;

  // Shape 2: `**Question?** answer` inline blocks
  const boldRe = /\*\*(.+?[?:])\*\*\s*([\s\S]*?)(?=\n\*\*|\n\n|$)/g;
  let b: RegExpExecArray | null;
  while ((b = boldRe.exec(body)) !== null) {
    answers.push({
      question: b[1].trim().replace(/[?:]$/, "").trim() + (b[1].endsWith("?") ? "?" : ""),
      answer: b[2].trim(),
    });
  }

  return answers;
}
