import { promises as fs } from "node:fs";
import { AppShell } from "@/components/AppShell";
import { readPipeline, type PipelineItem } from "@/lib/pipeline";
import { readReportWithScores, type ReportContent } from "@/lib/report";
import { p } from "@/lib/paths";
import { DiscoverBoard } from "./DiscoverBoard";

export const dynamic = "force-dynamic";

const DEFAULT_MIN_SCORE = 4.0;
// Server-side baseline: load anything plausibly interesting so the client
// slider can move freely without a re-fetch. Items below this are hidden
// from Discover entirely (they live on the Pipeline page if needed).
const SERVER_FLOOR = 3.0;

export type DiscoverItem = {
  pipeline: PipelineItem;
  report: ReportContent | null;
  excerpt: string;
  // ISO date string parsed from the report filename (`143-acme-2026-01-15.md`),
  // or null when the filename doesn't match the pattern. Used for the `7 Apr`
  // meta stamp in the top-right of each card.
  reportDate: string | null;
};

type LastScan = {
  isoTime: string;
  hoursAgo: number;
  newSinceLast: number;
} | null;

async function loadDiscoverItems(): Promise<DiscoverItem[]> {
  const items = await readPipeline();
  const scored = items.filter(
    (i) =>
      i.state === "processed" &&
      i.score !== null &&
      i.score >= SERVER_FLOOR,
  );

  const enriched = await Promise.all(
    scored.map(async (pipeline) => {
      const report =
        pipeline.num !== null
          ? await readReportWithScores(pipeline.num).catch(() => null)
          : null;
      return {
        pipeline,
        report,
        excerpt: report ? excerptFromReport(report.raw) : "",
        reportDate: report ? dateFromReportFilename(report.path) : null,
      };
    }),
  );

  enriched.sort((a, b) => (b.pipeline.score ?? 0) - (a.pipeline.score ?? 0));
  return enriched;
}

// Report filenames are `NNN-{company-slug}-YYYY-MM-DD.md` per modes/auto-pipeline.md.
// Extract the trailing YYYY-MM-DD as an ISO date so the card can stamp
// "7 Apr" in the corner without another file stat call.
function dateFromReportFilename(filePath: string): string | null {
  const base = filePath.split("/").pop() ?? "";
  const m = base.match(/-(\d{4}-\d{2}-\d{2})\.md$/);
  return m ? m[1] : null;
}

function excerptFromReport(raw: string, maxChars = 320): string {
  // Strip headings, table syntax, bold, and code fences to find a paragraph
  // worth quoting on the card.
  const stripped = raw
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\|.*$/gm, "")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\*\*/g, "")
    .replace(/^>\s?/gm, "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40 && !p.startsWith("-"));
  const first = stripped[0] ?? "";
  if (first.length <= maxChars) return first;
  return first.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
}

async function loadLastScan(): Promise<LastScan> {
  try {
    const raw = await fs.readFile(p.scanHistory, "utf-8");
    const lines = raw.trim().split("\n").slice(1); // skip header
    if (lines.length === 0) return null;

    let latest = 0;
    let newSinceLast = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    for (const line of lines) {
      const cols = line.split("\t");
      if (cols.length < 2) continue;
      const t = Date.parse(cols[1]);
      if (Number.isNaN(t)) continue;
      if (t > latest) latest = t;
      if (t > cutoff) newSinceLast++;
    }

    if (latest === 0) return null;
    return {
      isoTime: new Date(latest).toISOString(),
      hoursAgo: Math.max(0, Math.floor((Date.now() - latest) / 3_600_000)),
      newSinceLast,
    };
  } catch {
    return null;
  }
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ minScore?: string }>;
}) {
  const params = await searchParams;
  const initialMinScore =
    params.minScore !== undefined && !Number.isNaN(parseFloat(params.minScore))
      ? parseFloat(params.minScore)
      : DEFAULT_MIN_SCORE;

  const [items, lastScan] = await Promise.all([
    loadDiscoverItems(),
    loadLastScan(),
  ]);

  return (
    <AppShell>
      <DiscoverBoard
        items={items}
        initialMinScore={initialMinScore}
        lastScan={lastScan}
        serverFloor={SERVER_FLOOR}
      />
    </AppShell>
  );
}
