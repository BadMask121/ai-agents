"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { PipelineItem } from "@/lib/pipeline";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StarRating } from "@/components/ui/StarRating";
import { EmptyState } from "@/components/ui/EmptyState";

type Tab = "pending" | "processed" | "blocked";

const PAGE_SIZE = 10;

/* ─────────────────── Eval status types ─────────────────── */

type EvalError =
  | { kind: "permission-denied"; tools: string[] }
  | { kind: "no-report" }
  | { kind: "spawn"; message: string }
  | { kind: "api"; status: number }
  | { kind: "reconcile"; status: number };

type EvalInfo = {
  itemId: string | null;
  phase: "idle" | "running" | "success" | "failed";
  currentAction: string | null;
  cost: number | null;
  durationMs: number | null;
  score: number | null;
  error: EvalError | null;
};

const IDLE_EVAL: EvalInfo = {
  itemId: null,
  phase: "idle",
  currentAction: null,
  cost: null,
  durationMs: null,
  score: null,
  error: null,
};

export function PipelineBoard({ initial }: { initial: PipelineItem[] }) {
  const [items, setItems] = useState(initial);
  const [tab, setTab] = useState<Tab>("pending");
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [pending, startTransition] = useTransition();
  const [log, setLog] = useState<string>("");
  const [evalInfo, setEvalInfo] = useState<EvalInfo>(IDLE_EVAL);

  const runningId = evalInfo.phase === "running" ? evalInfo.itemId : null;

  const counts = useMemo(
    () => ({
      pending: items.filter((i) => i.state === "pending").length,
      processed: items.filter((i) => i.state === "processed").length,
      blocked: items.filter((i) => i.state === "blocked").length,
    }),
    [items],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = items.filter((i) => i.state === tab);
    const searched = q
      ? base.filter((i) => {
          const hay =
            `${i.title ?? ""} ${i.company ?? ""} ${i.url}`.toLowerCase();
          return hay.includes(q);
        })
      : base;
    // Processed items are sorted highest-score-first so the best picks surface.
    if (tab === "processed") {
      return searched
        .slice()
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }
    return searched;
  }, [items, tab, query]);

  const paged = filtered.slice(0, visible);
  const hasMore = filtered.length > visible;

  const switchTab = (next: Tab) => {
    setTab(next);
    setVisible(PAGE_SIZE);
    setQuery("");
  };

  const addUrl = async () => {
    if (!url.trim()) return;
    const res = await fetch("/api/pipeline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url.trim() }),
    });
    if (res.ok) {
      const { item } = await res.json();
      setItems((prev) =>
        prev.some((p) => p.id === item.id) ? prev : [...prev, item],
      );
      setUrl("");
    }
  };

  const setState = (id: string, state: Tab) => {
    startTransition(async () => {
      const res = await fetch("/api/pipeline", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, state }),
      });
      if (res.ok) {
        setItems((prev) =>
          prev.map((p) => (p.id === id ? { ...p, state } : p)),
        );
      }
    });
  };

  const remove = (id: string) => {
    startTransition(async () => {
      const res = await fetch(`/api/pipeline?id=${id}`, { method: "DELETE" });
      if (res.ok) setItems((prev) => prev.filter((p) => p.id !== id));
    });
  };

  // Evaluate = run the full `/career-ops auto-pipeline` chain on a single URL,
  // then reconcile the resulting report back onto the pipeline row so the
  // score/num/pdfReady fields are populated (and Discover can pick it up).
  //
  // Along the way we parse the stream-json events to drive the status card:
  //   - `assistant` events with `tool_use` content → currentAction update
  //   - `result` event at the end → cost, duration, and permission_denials
  //     (permission denials are a hard failure — we short-circuit the
  //      reconcile because there's no report to find)
  const evaluate = async (item: PipelineItem) => {
    setLog("");
    setEvalInfo({
      itemId: item.id,
      phase: "running",
      currentAction: "Starting agent…",
      cost: null,
      durationMs: null,
      score: null,
      error: null,
    });

    // Captured from the stream's final `result` event.
    let finalCost: number | null = null;
    let finalDurationMs: number | null = null;
    let deniedTools: string[] = [];

    const handleStreamEvent = (ev: unknown): void => {
      if (!ev || typeof ev !== "object") return;
      const e = ev as Record<string, unknown>;

      // Assistant turns carry text + tool_use blocks. Narrate tool calls
      // as they happen so the user sees progress in plain English.
      if (e.type === "assistant" && e.message && typeof e.message === "object") {
        const content = (e.message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (
              c &&
              typeof c === "object" &&
              (c as Record<string, unknown>).type === "tool_use"
            ) {
              const name = String(
                (c as Record<string, unknown>).name ?? "",
              );
              const input = (c as Record<string, unknown>).input;
              const narration = humanizeTool(name, input);
              setEvalInfo((prev) =>
                prev.phase === "running"
                  ? { ...prev, currentAction: narration }
                  : prev,
              );
            }
          }
        }
      }

      // The final result event reports cost, duration, and any denied tool
      // calls. Permission denials are fatal — the agent couldn't reach the
      // network, so there's no report to reconcile.
      if (e.type === "result") {
        if (typeof e.total_cost_usd === "number") finalCost = e.total_cost_usd;
        if (typeof e.duration_ms === "number") finalDurationMs = e.duration_ms;
        if (Array.isArray(e.permission_denials) && e.permission_denials.length > 0) {
          deniedTools = Array.from(
            new Set(
              (e.permission_denials as Array<Record<string, unknown>>)
                .map((d) => String(d.tool_name ?? ""))
                .filter(Boolean),
            ),
          );
        }
      }
    };

    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "auto-pipeline", arg: item.url }),
      });
      if (!res.ok || !res.body) {
        setEvalInfo({
          ...IDLE_EVAL,
          itemId: item.id,
          phase: "failed",
          error: { kind: "api", status: res.status },
        });
        return;
      }

      // Two levels of buffering:
      //   1. SSE event buffer (outer `\n\n`-delimited SSE frames)
      //   2. stream-json line buffer (inside each parsed.chunk, newline-
      //      delimited claude events that may span multiple SSE frames)
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      let jsonBuf = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const frames = sseBuf.split("\n\n");
        sseBuf = frames.pop() ?? "";
        for (const frame of frames) {
          const lines = frame.split("\n");
          let data = "";
          for (const ln of lines) {
            if (ln.startsWith("data:")) data += ln.slice(5).trim();
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as { chunk?: string };
            if (typeof parsed.chunk === "string") {
              setLog((prev) => prev + parsed.chunk!);
              jsonBuf += parsed.chunk;
              const lineEnd = jsonBuf.lastIndexOf("\n");
              if (lineEnd >= 0) {
                const complete = jsonBuf.slice(0, lineEnd);
                jsonBuf = jsonBuf.slice(lineEnd + 1);
                for (const ln of complete.split("\n")) {
                  const t = ln.trim();
                  if (!t) continue;
                  try {
                    handleStreamEvent(JSON.parse(t));
                  } catch {
                    /* incomplete or non-JSON line — skip */
                  }
                }
              }
            }
          } catch {
            /* not JSON SSE data — skip */
          }
        }
      }

      // Stream ended. Check for permission denials first — if the agent was
      // blocked, there's nothing for reconcile to find.
      if (deniedTools.length > 0) {
        setEvalInfo({
          itemId: item.id,
          phase: "failed",
          currentAction: null,
          cost: finalCost,
          durationMs: finalDurationMs,
          score: null,
          error: { kind: "permission-denied", tools: deniedTools },
        });
        return;
      }

      // Happy path: ask the server to locate the new report and patch the
      // pipeline row with the score / num / pdfReady fields.
      const rec = await fetch("/api/pipeline/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      if (!rec.ok) {
        setEvalInfo({
          itemId: item.id,
          phase: "failed",
          currentAction: null,
          cost: finalCost,
          durationMs: finalDurationMs,
          score: null,
          error: { kind: "reconcile", status: rec.status },
        });
        return;
      }
      const outcome = (await rec.json()) as
        | {
            ok: true;
            item: PipelineItem;
            overallScore: number | null;
          }
        | {
            ok: false;
            reason: "item-not-found" | "already-scored" | "no-matching-report";
            item: PipelineItem | null;
          };

      if (outcome.item) {
        const updated = outcome.item;
        setItems((prev) =>
          prev.map((p) => (p.id === updated.id ? updated : p)),
        );
      }

      if (outcome.ok) {
        setEvalInfo({
          itemId: item.id,
          phase: "success",
          currentAction: null,
          cost: finalCost,
          durationMs: finalDurationMs,
          score: outcome.overallScore,
          error: null,
        });
      } else if (outcome.reason === "no-matching-report") {
        setEvalInfo({
          itemId: item.id,
          phase: "failed",
          currentAction: null,
          cost: finalCost,
          durationMs: finalDurationMs,
          score: null,
          error: { kind: "no-report" },
        });
      } else {
        // "already-scored" or "item-not-found" — treat as success so the UI
        // doesn't look like a regression.
        setEvalInfo({
          itemId: item.id,
          phase: "success",
          currentAction: null,
          cost: finalCost,
          durationMs: finalDurationMs,
          score: outcome.item?.score ?? null,
          error: null,
        });
      }
    } catch (err) {
      setEvalInfo({
        itemId: item.id,
        phase: "failed",
        currentAction: null,
        cost: finalCost,
        durationMs: finalDurationMs,
        score: null,
        error: { kind: "spawn", message: (err as Error).message },
      });
    }
  };

  const dismissEval = () => setEvalInfo(IDLE_EVAL);

  const runningItem = evalInfo.itemId
    ? items.find((i) => i.id === evalInfo.itemId) ?? null
    : null;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Pipeline
        </h1>
        <p className="text-sm text-muted">
          Review and approve jobs to evaluate.
        </p>
      </header>

      <EvalStatusCard
        evalInfo={evalInfo}
        item={runningItem}
        onDismiss={dismissEval}
      />

      {/* Add URL row */}
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addUrl();
          }}
          placeholder="Paste a job URL…"
          className="flex-1 rounded-full border border-border bg-surface px-4 py-2.5 text-sm text-foreground placeholder:text-subtle outline-none focus:border-accent"
        />
        <Button
          onClick={addUrl}
          disabled={pending || !url.trim()}
          variant="primary"
        >
          Add
        </Button>
      </div>

      {/* Tabs — segmented pill */}
      <div className="inline-flex rounded-full border border-border bg-surface p-1">
        {(["pending", "processed", "blocked"] as Tab[]).map((t) => {
          const active = tab === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => switchTab(t)}
              aria-pressed={active}
              className={[
                "rounded-full px-4 py-1.5 text-xs font-medium capitalize transition",
                active
                  ? "bg-accent text-accent-fg shadow-sm"
                  : "text-muted hover:text-foreground",
              ].join(" ")}
            >
              {t} <span className="tabular-nums">({counts[t]})</span>
            </button>
          );
        })}
      </div>

      {/* Search — appears once there's enough to warrant it */}
      {counts[tab] > 10 && (
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setVisible(PAGE_SIZE);
          }}
          placeholder={`Search ${counts[tab]} ${tab} jobs…`}
          className="w-full rounded-full border border-border bg-surface-muted px-4 py-2 text-xs text-foreground placeholder:text-subtle outline-none focus:border-accent focus:bg-surface"
        />
      )}

      {filtered.length === 0 ? (
        <EmptyState
          title={
            query
              ? `No ${tab} jobs match "${query}"`
              : `No ${tab} jobs yet`
          }
          description={
            tab === "pending"
              ? "Paste a job URL above, or wait for the next scheduled scan."
              : tab === "processed"
                ? "Approved jobs the agent has evaluated will appear here."
                : "Skipped or errored jobs land here."
          }
        />
      ) : (
        <>
          <ul className="space-y-3" aria-label={`${tab} jobs`}>
            {paged.map((item) => (
              <PipelineCard
                key={item.id}
                item={item}
                tab={tab}
                isRunning={runningId === item.id}
                anyRunning={runningId !== null}
                onEvaluate={() => evaluate(item)}
                onSkip={() => setState(item.id, "blocked")}
                onReopen={() => setState(item.id, "pending")}
                onRemove={() => remove(item.id)}
              />
            ))}
          </ul>

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setVisible((n) => n + PAGE_SIZE)}
              >
                Load {Math.min(PAGE_SIZE, filtered.length - visible)} more
              </Button>
            </div>
          )}
        </>
      )}

      {log && (
        <details className="rounded-2xl border border-border bg-surface-muted">
          <summary className="cursor-pointer list-none px-5 py-3 text-[11px] uppercase tracking-wider text-muted font-semibold select-none flex items-center justify-between">
            <span>Show raw agent output</span>
            <span className="text-subtle normal-case tracking-normal font-normal">
              click to expand
            </span>
          </summary>
          <div className="border-t border-border px-5 py-3">
            <div className="flex items-center justify-end mb-2">
              <button
                type="button"
                onClick={() => setLog("")}
                className="text-[10px] text-muted hover:text-foreground transition"
              >
                clear
              </button>
            </div>
            <pre className="text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-all max-h-80 overflow-auto font-mono">
              {log}
            </pre>
          </div>
        </details>
      )}
    </div>
  );
}

/* ──────────────────── Eval status card ──────────────────── */

function EvalStatusCard({
  evalInfo,
  item,
  onDismiss,
}: {
  evalInfo: EvalInfo;
  item: PipelineItem | null;
  onDismiss: () => void;
}) {
  if (evalInfo.phase === "idle") return null;

  const label = item
    ? `${item.company ?? "Unknown company"} — ${item.title ?? "Untitled role"}`
    : "Job evaluation";

  if (evalInfo.phase === "running") {
    return (
      <Card className="border-accent/40">
        <div className="flex items-start gap-3">
          <Spinner />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground truncate">
              Evaluating {label}
            </div>
            <div className="text-xs text-muted truncate mt-0.5">
              {evalInfo.currentAction ?? "Agent is thinking…"}
            </div>
          </div>
        </div>
      </Card>
    );
  }

  if (evalInfo.phase === "success") {
    return (
      <Card className="border-success/30">
        <div className="flex items-start gap-3">
          <SuccessIcon />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground truncate">
              Evaluated {label}
            </div>
            <div className="text-xs text-muted truncate mt-0.5 tabular-nums">
              {evalInfo.score !== null && (
                <>
                  <span className="text-success font-semibold">
                    {evalInfo.score.toFixed(1)}/5
                  </span>
                  {" · "}
                </>
              )}
              {formatDuration(evalInfo.durationMs)}
              {evalInfo.cost !== null &&
                ` · $${evalInfo.cost.toFixed(4)}`}
              {" · visible on Discover"}
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-[10px] text-muted hover:text-foreground transition shrink-0"
          >
            Dismiss
          </button>
        </div>
      </Card>
    );
  }

  // failed
  return (
    <Card className="border-danger/30 bg-danger-soft">
      <div className="flex items-start gap-3">
        <FailIcon />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="text-sm font-semibold text-foreground">
              Evaluation failed for {label}
            </div>
            <div className="text-xs text-muted mt-0.5 tabular-nums">
              {formatDuration(evalInfo.durationMs)}
              {evalInfo.cost !== null && ` · $${evalInfo.cost.toFixed(4)}`}
            </div>
          </div>
          <div className="text-xs text-foreground">
            {renderErrorBody(evalInfo.error)}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[10px] text-muted hover:text-foreground transition shrink-0"
        >
          Dismiss
        </button>
      </div>
    </Card>
  );
}

function renderErrorBody(error: EvalError | null): React.ReactNode {
  if (!error) return "Unknown error.";
  switch (error.kind) {
    case "permission-denied":
      return (
        <>
          <p>
            The agent was blocked from using tools it needs to fetch the job
            posting:
          </p>
          <ul className="mt-1 list-disc list-inside text-muted">
            {error.tools.map((t) => (
              <li key={t} className="font-mono">
                {t}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted">
            This is a container config bug. Ensure{" "}
            <code className="font-mono bg-surface-sunk px-1 rounded">
              --dangerously-skip-permissions
            </code>{" "}
            is passed to the claude CLI in{" "}
            <code className="font-mono bg-surface-sunk px-1 rounded">
              src/lib/runAction.ts
            </code>
            .
          </p>
        </>
      );
    case "no-report":
      return (
        <>
          <p>
            The agent finished but we couldn&apos;t locate the resulting report
            in{" "}
            <code className="font-mono bg-surface-sunk px-1 rounded">
              reports/
            </code>
            . The job is marked processed but won&apos;t show up on Discover.
          </p>
          <p className="mt-2 text-muted">
            Most common cause: the agent couldn&apos;t extract the JD (e.g.,
            LinkedIn login wall, portal down). Check the raw output below for
            details.
          </p>
        </>
      );
    case "spawn":
      return (
        <>
          <p>Couldn&apos;t start or read from the agent process:</p>
          <p className="mt-1 font-mono text-muted break-all">{error.message}</p>
        </>
      );
    case "api":
      return (
        <p>
          The server returned HTTP{" "}
          <span className="font-mono">{error.status}</span> when starting the
          agent. Check the container logs.
        </p>
      );
    case "reconcile":
      return (
        <p>
          The agent finished but the reconcile endpoint returned HTTP{" "}
          <span className="font-mono">{error.status}</span>. The report is on
          disk but the pipeline row wasn&apos;t patched.
        </p>
      );
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="h-5 w-5 shrink-0 animate-spin text-accent"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M12 2 a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="h-5 w-5 shrink-0 text-success"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path
        d="m8 12 3 3 5-6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="h-5 w-5 shrink-0 text-danger"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 7v6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="16.5" r="1.25" fill="currentColor" />
    </svg>
  );
}

/* ──────────────────── Tool narration ──────────────────── */

// Turns raw stream-json tool_use events into short, plain-English status
// lines for the Evaluating card. Keeps the hot path readable while the
// detailed trace stays in the collapsible raw log for debugging.
function humanizeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string): string =>
    typeof i[k] === "string" ? (i[k] as string) : "";
  const host = (u: string): string => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return u;
    }
  };
  const shortName = name.replace(/^mcp__\w+__/, "");

  switch (name) {
    case "mcp__playwright__browser_navigate":
      return `Opening ${host(str("url"))} in browser…`;
    case "mcp__playwright__browser_snapshot":
      return "Reading page structure…";
    case "mcp__playwright__browser_take_screenshot":
      return "Taking screenshot…";
    case "mcp__playwright__browser_click":
      return "Clicking element…";
    case "mcp__playwright__browser_type":
      return "Typing into form field…";
    case "mcp__playwright__browser_fill_form":
      return "Filling form…";
    case "mcp__playwright__browser_press_key":
      return "Pressing key…";
    case "mcp__playwright__browser_wait_for":
      return "Waiting for page element…";
    case "mcp__playwright__browser_close":
      return "Closing browser…";
    case "WebFetch":
      return `Fetching ${host(str("url"))}…`;
    case "WebSearch":
      return `Searching the web${str("query") ? `: ${str("query").slice(0, 40)}` : ""}…`;
    case "Read":
      return `Reading ${basename(str("file_path")) || "file"}…`;
    case "Write":
      return `Writing ${basename(str("file_path")) || "file"}…`;
    case "Edit":
      return `Editing ${basename(str("file_path")) || "file"}…`;
    case "Bash":
      return `Running: ${str("command").slice(0, 50)}…`;
    case "Glob":
      return `Looking for ${str("pattern") || "files"}…`;
    case "Grep":
      return `Grep: ${str("pattern") || "pattern"}…`;
    case "Task":
    case "Agent":
      return "Delegating to a subagent…";
    default:
      return `Running ${shortName}…`;
  }
}

function basename(p: string): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || "";
}

function PipelineCard({
  item,
  tab,
  isRunning,
  anyRunning,
  onEvaluate,
  onSkip,
  onReopen,
  onRemove,
}: {
  item: PipelineItem;
  tab: Tab;
  isRunning: boolean;
  anyRunning: boolean;
  onEvaluate: () => void;
  onSkip: () => void;
  onReopen: () => void;
  onRemove: () => void;
}) {
  const hasScore = item.score !== null;
  const domain = safeDomain(item.url);

  return (
    <li>
      <Card className="space-y-3">
        {/* Header row: title + star rating (if scored) */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            {item.num !== null && (
              <div className="text-[10px] uppercase tracking-wider text-subtle tabular-nums">
                #{item.num}
              </div>
            )}
            <h2 className="text-sm font-semibold text-foreground truncate">
              {item.title ?? "Untitled role"}
            </h2>
            <div className="text-xs text-muted truncate">
              {item.company ?? "Unknown company"}
              {domain && <span className="text-subtle"> · {domain}</span>}
            </div>
          </div>
          {hasScore && <StarRating score={item.score!} size="sm" />}
        </div>

        {/* Blocked error message, if any */}
        {item.state === "blocked" && item.error && (
          <div className="rounded-lg bg-danger-soft border border-danger/20 px-3 py-2 text-[11px] text-danger">
            {item.error}
          </div>
        )}

        {/* Action row — balanced buttons, no more giant Approve */}
        <div className="flex items-center gap-2 pt-1">
          {tab === "pending" && (
            <>
              <Button
                variant="primary"
                size="sm"
                className="flex-1"
                onClick={onEvaluate}
                loading={isRunning}
                disabled={anyRunning && !isRunning}
              >
                {isRunning ? "Evaluating…" : "Evaluate"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onSkip}
                disabled={anyRunning}
              >
                Skip
              </Button>
            </>
          )}
          {tab === "processed" && (
            <>
              <Link href={`/apply/${item.num ?? item.id}`} className="flex-1">
                <Button variant="primary" size="sm" className="w-full">
                  Approve
                </Button>
              </Link>
              <Button variant="ghost" size="sm" onClick={onReopen}>
                Reopen
              </Button>
            </>
          )}
          {tab === "blocked" && (
            <>
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                onClick={onReopen}
              >
                Move to pending
              </Button>
              <Button variant="danger" size="sm" onClick={onRemove}>
                Remove
              </Button>
            </>
          )}
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full px-2 py-1 text-xs text-subtle hover:text-accent transition"
            aria-label="Open job posting in new tab"
          >
            ↗
          </a>
        </div>
      </Card>
    </li>
  );
}

function safeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
