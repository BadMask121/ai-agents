// After a user clicks Evaluate on a pending pipeline item and the
// `/career-ops auto-pipeline <url>` stream finishes, the agent has written a
// report to `reports/` and a PDF to `output/` — but it hasn't touched
// `pipeline.md`. That's deliberate on the career-ops backend: auto-pipeline
// operates on a single URL and treats pipeline.md as a scanner-owned inbox.
//
// The UI's old flow then did `PATCH /api/pipeline {state: "processed"}` which
// rewrote the pipeline row WITHOUT a score — so Discover (which filters on
// `score !== null && score >= 3.0`) couldn't see the freshly-evaluated job.
//
// This module closes that loop: after the stream ends, the UI calls the
// reconcile endpoint, which locates the just-written report, extracts the
// overall score + sub-scores + num, checks whether the PDF landed in
// `output/`, and patches the pipeline row with the rich data. Next time
// Discover loads, the job shows up ranked where it belongs.

import { promises as fs } from "node:fs";
import path from "node:path";
import { p } from "./paths";
import { enrichItem, readPipeline, type PipelineItem } from "./pipeline";
import { readReportWithScores } from "./report";

// Scan at most this many recently-modified reports before giving up. The
// just-finished run is almost always in the top 1–2; bounding keeps the cost
// trivial even with years of accumulated reports.
const MAX_REPORTS_TO_SCAN = 10;

export type ReconcileOutcome =
  | {
      ok: true;
      item: PipelineItem;
      matchedReportPath: string;
      overallScore: number | null;
    }
  | {
      ok: false;
      reason: "item-not-found" | "already-scored" | "no-matching-report";
      item: PipelineItem | null;
    };

export async function reconcileEvaluation(
  id: string,
): Promise<ReconcileOutcome> {
  const items = await readPipeline();
  const target = items.find((i) => i.id === id);
  if (!target) {
    return { ok: false, reason: "item-not-found", item: null };
  }

  // Already scored — nothing to do. Still flip to processed in case the UI
  // and disk disagree.
  if (target.score !== null && target.num !== null) {
    const refreshed = await enrichItem(id, { state: "processed" });
    return {
      ok: false,
      reason: "already-scored",
      item: refreshed,
    };
  }

  const matched = await findReportForUrl(target.url);
  if (!matched) {
    // Fall back to a plain state flip so the Pipeline UI at least reflects
    // that evaluation completed, even if Discover can't surface it yet.
    const refreshed = await enrichItem(id, { state: "processed" });
    return {
      ok: false,
      reason: "no-matching-report",
      item: refreshed,
    };
  }

  const report = await readReportWithScores(matched.num);
  const overallScore = pickOverallScore(report?.subScores);
  const pdfReady = await pdfExistsForNum(matched.num);

  const refreshed = await enrichItem(id, {
    state: "processed",
    num: matched.num,
    score: overallScore,
    pdfReady,
  });

  return {
    ok: true,
    item: refreshed,
    matchedReportPath: matched.filePath,
    overallScore,
  };
}

// Report filenames are `{NNN}-{slug}-{YYYY-MM-DD}.md`. We want the one that
// was just written — which is almost always the newest by mtime and contains
// the target URL somewhere in its body. We bound the scan to the most recent
// N files so long-lived repos stay snappy.
async function findReportForUrl(
  url: string,
): Promise<{ num: number; filePath: string } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(p.reports);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const mdEntries = entries.filter((f) => f.endsWith(".md"));
  if (mdEntries.length === 0) return null;

  // Sort by mtime descending (newest first).
  const stats = await Promise.all(
    mdEntries.map(async (name) => {
      const full = path.join(p.reports, name);
      const st = await fs.stat(full).catch(() => null);
      return { name, full, mtime: st?.mtimeMs ?? 0 };
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);

  const head = stats.slice(0, MAX_REPORTS_TO_SCAN);

  for (const { name, full } of head) {
    const numMatch = name.match(/^(\d+)-/);
    if (!numMatch) continue;
    const body = await fs.readFile(full, "utf-8").catch(() => "");
    if (body.includes(url)) {
      return { num: parseInt(numMatch[1], 10), filePath: full };
    }
  }

  return null;
}

// Overall score preference: the `Global` row of the evaluation table is the
// top-line number career-ops uses in the pipeline.md Procesadas format. If it's
// missing for any reason (older reports, parsing drift), fall back to the
// CV Match dimension which is always present.
function pickOverallScore(
  subScores: { global?: number; cvMatch?: number } | undefined,
): number | null {
  if (!subScores) return null;
  if (typeof subScores.global === "number") return subScores.global;
  if (typeof subScores.cvMatch === "number") return subScores.cvMatch;
  return null;
}

// PDF is considered ready if ANY file in the output dir has the matching
// numeric prefix. career-ops names PDFs like `{NNN}-{slug}.pdf` but we
// deliberately don't hard-code the suffix — any file matching `^{num}-` counts.
async function pdfExistsForNum(num: number): Promise<boolean> {
  try {
    const entries = await fs.readdir(p.output);
    const prefix = `${num}-`;
    return entries.some(
      (f) => f.toLowerCase().endsWith(".pdf") && f.startsWith(prefix),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}
