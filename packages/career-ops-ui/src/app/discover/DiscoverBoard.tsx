"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StarRating } from "@/components/ui/StarRating";
import { ScoreBar } from "@/components/ui/ScoreBar";
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
  items,
  initialMinScore,
  serverFloor,
  lastScan,
}: Props) {
  const [minScore, setMinScore] = useState(initialMinScore);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Sync slider value into the URL so the page is shareable + survives reloads.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("minScore", minScore.toFixed(1));
    window.history.replaceState(null, "", url);
  }, [minScore]);

  const filtered = useMemo(
    () =>
      items.filter((d) => (d.pipeline.score ?? 0) >= minScore),
    [items, minScore],
  );

  const aboveCount = filtered.length;
  const totalLoaded = items.length;

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
            <DiscoverCard
              key={d.pipeline.id}
              item={d}
              expanded={!!expanded[d.pipeline.id]}
              onToggle={() =>
                setExpanded((prev) => ({
                  ...prev,
                  [d.pipeline.id]: !prev[d.pipeline.id],
                }))
              }
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

function DiscoverCard({
  item,
  expanded,
  onToggle,
}: {
  item: DiscoverItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { pipeline, report, excerpt } = item;
  const score = pipeline.score ?? 0;
  const subScores = report?.subScores ?? {};

  return (
    <li>
      <Card>
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-subtle tabular-nums">
                #{pipeline.num ?? "—"}
              </div>
              <h2 className="text-sm font-semibold text-foreground truncate">
                {pipeline.title ?? "Untitled role"}
              </h2>
              <div className="text-xs text-muted truncate">
                {pipeline.company ?? "Unknown company"}
              </div>
            </div>
            <StarRating score={score} size="md" />
          </div>

          {report && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
              <ScoreBar label="CV match" score={subScores.cvMatch} />
              <ScoreBar label="North star" score={subScores.northStar} />
              <ScoreBar label="Comp" score={subScores.comp} />
              <ScoreBar label="Cultural" score={subScores.cultural} />
            </div>
          )}

          {excerpt && (
            <p className="text-xs leading-relaxed text-muted line-clamp-3">
              {excerpt}
            </p>
          )}

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

          <div className="flex items-center gap-2 pt-1">
            <Link
              href={`/apply/${pipeline.num ?? pipeline.id}`}
              className="flex-1"
            >
              <Button variant="primary" size="sm" className="w-full">
                Approve → chat
              </Button>
            </Link>
            {report && (
              <Button variant="secondary" size="sm" onClick={onToggle}>
                {expanded ? "Hide" : "Read"} report
              </Button>
            )}
            <a
              href={pipeline.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-subtle hover:text-accent px-2 transition"
              aria-label="Open job posting in new tab"
            >
              ↗
            </a>
          </div>

          {!pipeline.pdfReady && report && (
            <div className="text-[10px] text-warning">
              ⚠ PDF report not yet generated
            </div>
          )}
        </div>
      </Card>
    </li>
  );
}
