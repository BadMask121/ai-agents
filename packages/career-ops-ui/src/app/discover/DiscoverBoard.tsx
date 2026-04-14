"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import type { DiscoverItem } from "./page";

type Props = {
  items: DiscoverItem[];
  initialMinScore: number;
  serverFloor: number;
  lastScan: {
    isoTime: string;
    hoursAgo: number;
    newSinceLast: number;
  } | null;
};

export function DiscoverBoard({
  items: initialItems,
  initialMinScore,
  serverFloor,
  lastScan,
}: Props) {
  const [items, setItems] = useState(initialItems);
  const [minScore, setMinScore] = useState(initialMinScore);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [, startTransition] = useTransition();

  // Sync slider value into the URL so the page is shareable + survives reloads.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("minScore", minScore.toFixed(1));
    window.history.replaceState(null, "", url);
  }, [minScore]);

  const filtered = useMemo(
    () => items.filter((d) => (d.pipeline.score ?? 0) >= minScore),
    [items, minScore],
  );

  const aboveCount = filtered.length;
  const totalLoaded = items.length;

  // Skip in Discover = move the pipeline row to `blocked` so it doesn't keep
  // showing up. The server re-reads pipeline.md on next page load; for now we
  // optimistically drop it from the board state.
  const skip = (id: string) => {
    startTransition(async () => {
      const res = await fetch("/api/pipeline", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, state: "blocked" }),
      });
      if (res.ok) {
        setItems((prev) => prev.filter((d) => d.pipeline.id !== id));
      }
    });
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Discover
        </h1>
        <p className="text-sm text-muted">
          AI-scored job matches, ranked by fit.
        </p>
      </header>

      <StatusStrip
        lastScan={lastScan}
        totalLoaded={totalLoaded}
        aboveCount={aboveCount}
      />

      <ThresholdControl
        value={minScore}
        onChange={setMinScore}
        floor={serverFloor}
        aboveCount={aboveCount}
      />

      {filtered.length === 0 ? (
        <EmptyState
          title={
            totalLoaded === 0
              ? "No scored jobs yet"
              : "Nothing meets that threshold"
          }
          description={
            totalLoaded === 0
              ? "The career-scan cron hasn't produced any scored jobs yet, or all current results scored below 3.0/5. Check back after the next scheduled scan."
              : `Lower the threshold below ${minScore.toFixed(1)} to see matches, or wait for the next scan.`
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Scored job matches">
          {filtered.map((d) => (
            <JobCard
              key={d.pipeline.id}
              item={d}
              expanded={!!expanded[d.pipeline.id]}
              onToggle={() =>
                setExpanded((prev) => ({
                  ...prev,
                  [d.pipeline.id]: !prev[d.pipeline.id],
                }))
              }
              onSkip={() => skip(d.pipeline.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusStrip({
  lastScan,
  totalLoaded,
  aboveCount,
}: {
  lastScan: Props["lastScan"];
  totalLoaded: number;
  aboveCount: number;
}) {
  const lastScanLabel = lastScan
    ? `last scan: ${formatHoursAgo(lastScan.hoursAgo)}`
    : "no scans recorded yet";
  const newLabel =
    lastScan && lastScan.newSinceLast > 0
      ? ` · ${lastScan.newSinceLast} new in 24h`
      : "";
  return (
    <div className="flex items-center justify-between rounded-full border border-border bg-surface-muted px-4 py-2 text-[11px] text-muted">
      <span>
        {lastScanLabel}
        {newLabel}
      </span>
      <span className="tabular-nums text-foreground font-medium">
        {aboveCount}/{totalLoaded} above threshold
      </span>
    </div>
  );
}

function formatHoursAgo(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ThresholdControl({
  value,
  onChange,
  floor,
  aboveCount,
}: {
  value: number;
  onChange: (n: number) => void;
  floor: number;
  aboveCount: number;
}) {
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(20,14,4,0.04)]">
      <div className="flex items-baseline justify-between">
        <label
          htmlFor="threshold"
          className="text-[10px] font-semibold uppercase tracking-wider text-muted"
        >
          Minimum score
        </label>
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {value.toFixed(1)}/5
        </span>
      </div>
      <input
        id="threshold"
        type="range"
        min={floor}
        max={5}
        step={0.1}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-[var(--color-accent)]"
        aria-valuetext={`${value.toFixed(1)} out of 5`}
      />
      <div className="flex justify-between text-[10px] text-subtle">
        <span>{floor.toFixed(1)}</span>
        <span className="text-muted">
          {aboveCount} match{aboveCount === 1 ? "" : "es"}
        </span>
        <span>5.0</span>
      </div>
    </div>
  );
}

/* ─────────────────────── Job card ─────────────────────── */

function JobCard({
  item,
  expanded,
  onToggle,
  onSkip,
}: {
  item: DiscoverItem;
  expanded: boolean;
  onToggle: () => void;
  onSkip: () => void;
}) {
  const { pipeline, report, excerpt, reportDate } = item;
  const score = pipeline.score;
  const hasReport = !!report;

  return (
    <li>
      <Card>
        <div className="space-y-3">
          {/* Header: company bold, role underneath, meta pinned right */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-foreground truncate">
                {pipeline.company ?? "Unknown company"}
              </h2>
              <div className="text-xs text-muted truncate mt-0.5">
                {pipeline.title ?? "Untitled role"}
              </div>
            </div>
            <div className="shrink-0 text-[10px] text-subtle tabular-nums whitespace-nowrap">
              {pipeline.num !== null && <span>#{pipeline.num}</span>}
              {pipeline.num !== null && reportDate && (
                <span className="mx-1">·</span>
              )}
              {reportDate && <span>{formatShortDate(reportDate)}</span>}
            </div>
          </div>

          {/* Status pill row */}
          <div className="flex flex-wrap items-center gap-1.5">
            {hasReport && (
              <Badge variant="success">
                <CheckIcon /> Evaluated
              </Badge>
            )}
            {score !== null && (
              <Badge variant="outline">
                <span className="tabular-nums">{score.toFixed(1)}/5</span>
              </Badge>
            )}
            {pipeline.pdfReady && <Badge variant="outline">PDF</Badge>}
            {hasReport && !pipeline.pdfReady && (
              <Badge variant="warning">PDF pending</Badge>
            )}
          </div>

          {/* Excerpt */}
          {excerpt && (
            <p className="text-xs leading-relaxed text-muted line-clamp-3">
              {excerpt}
            </p>
          )}

          {/* Expanded full report */}
          {expanded && report && (
            <div className="rounded-xl border border-border bg-surface-muted p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">
                Full report
              </div>
              <pre className="text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words font-mono max-h-96 overflow-auto">
                {report.raw}
              </pre>
            </div>
          )}

          {/* Action row — the big Approve + Skip pair */}
          <div className="flex items-center gap-2 pt-1">
            <Link
              href={`/apply/${pipeline.num ?? pipeline.id}`}
              className="flex-1"
            >
              <Button variant="primary" size="md" className="w-full">
                Approve
              </Button>
            </Link>
            <Button variant="secondary" size="md" onClick={onSkip}>
              Skip
            </Button>
          </div>

          {/* Tertiary actions — low-visual-weight links below the main CTA */}
          <div className="flex items-center justify-between pt-1 text-[11px]">
            {report ? (
              <button
                type="button"
                onClick={onToggle}
                className="text-muted hover:text-accent transition"
              >
                {expanded ? "Hide" : "Read"} full report
              </button>
            ) : (
              <span />
            )}
            <a
              href={pipeline.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted hover:text-accent transition"
            >
              Open posting ↗
            </a>
          </div>
        </div>
      </Card>
    </li>
  );
}

function formatShortDate(iso: string): string {
  // iso is YYYY-MM-DD. Parse without timezone shenanigans and format as "7 Apr".
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, , mm, dd] = m;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const monthIdx = parseInt(mm, 10) - 1;
  const day = parseInt(dd, 10);
  if (monthIdx < 0 || monthIdx > 11 || Number.isNaN(day)) return iso;
  return `${day} ${months[monthIdx]}`;
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path
        d="m3.5 8 3 3 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
