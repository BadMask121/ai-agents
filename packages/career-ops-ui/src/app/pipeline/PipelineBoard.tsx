"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { PipelineItem } from "@/lib/pipeline";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StarRating } from "@/components/ui/StarRating";
import { EmptyState } from "@/components/ui/EmptyState";

type Tab = "pending" | "processed" | "blocked";

const PAGE_SIZE = 50;

export function PipelineBoard({ initial }: { initial: PipelineItem[] }) {
  const [items, setItems] = useState(initial);
  const [tab, setTab] = useState<Tab>("pending");
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [pending, startTransition] = useTransition();
  const [log, setLog] = useState<string>("");
  const [running, setRunning] = useState<string | null>(null);

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
  const evaluate = async (item: PipelineItem) => {
    setRunning(item.id);
    setLog("");
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "auto-pipeline", arg: item.url }),
      });
      if (!res.ok || !res.body) {
        setLog(`error: ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const block of events) {
          const lines = block.split("\n");
          let data = "";
          for (const ln of lines) {
            if (ln.startsWith("data:")) data += ln.slice(5).trim();
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.chunk) setLog((prev) => prev + parsed.chunk);
          } catch {}
        }
      }

      // Stream ended — auto-pipeline has (hopefully) written a report and
      // PDF. Ask the server to locate them, parse the overall score, and
      // patch the pipeline row. If the reconcile can't find a matching
      // report it still flips state to processed so the UI doesn't get stuck.
      const rec = await fetch("/api/pipeline/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      if (rec.ok) {
        const outcome = (await rec.json()) as
          | {
              ok: true;
              item: PipelineItem;
              overallScore: number | null;
            }
          | {
              ok: false;
              reason:
                | "item-not-found"
                | "already-scored"
                | "no-matching-report";
              item: PipelineItem | null;
            };
        if (outcome.item) {
          const updated = outcome.item;
          setItems((prev) =>
            prev.map((p) => (p.id === updated.id ? updated : p)),
          );
        }
        if (!outcome.ok && outcome.reason === "no-matching-report") {
          setLog(
            (prev) =>
              prev +
              "\n\n[reconcile] evaluation finished but the corresponding report couldn't be located in reports/. The item is marked processed but won't appear on Discover until the score is back-filled manually.",
          );
        }
      } else {
        // Worst case: reconcile endpoint errored. Fall back to the old
        // behavior — flip state to processed so the UI at least advances.
        setState(item.id, "processed");
      }
    } catch (err) {
      setLog(`error: ${(err as Error).message}`);
    } finally {
      setRunning(null);
    }
  };

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
                isRunning={running === item.id}
                anyRunning={running !== null}
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
                Show {Math.min(PAGE_SIZE, filtered.length - visible)} more
              </Button>
            </div>
          )}
        </>
      )}

      {log && (
        <Card className="bg-surface-sunk border-border-strong">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider text-muted font-semibold">
              Agent output
            </span>
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
        </Card>
      )}
    </div>
  );
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
              {domain && (
                <span className="text-subtle"> · {domain}</span>
              )}
            </div>
          </div>
          {hasScore && (
            <StarRating score={item.score!} size="sm" />
          )}
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
