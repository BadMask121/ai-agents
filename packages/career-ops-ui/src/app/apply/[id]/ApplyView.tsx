"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingSkeleton } from "@/components/ui/LoadingSkeleton";
import type { ApplySession } from "@/lib/applySession";

type Props = { initial: ApplySession };

export function ApplyView({ initial }: Props) {
  const [session, setSession] = useState<ApplySession>(initial);
  const [copied, setCopied] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Poll while the prepare agent is still running so the page updates
  // without a manual refresh. Polling stops as soon as preparing flips false
  // or the status is terminal.
  useEffect(() => {
    if (!session.preparing && session.status !== "draft") return;
    if (session.payload && !session.preparing) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/apply/sessions/${session.id}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const { session: next } = (await res.json()) as { session: ApplySession };
        if (cancelled) return;
        setSession(next);
      } catch {
        // network blip — try again on the next tick
      }
    };

    tick();
    const interval = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [session.id, session.preparing, session.payload, session.status]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/apply/sessions/${session.id}/retry`, {
        method: "POST",
      });
      if (!res.ok) return;
      const { session: next } = (await res.json()) as { session: ApplySession };
      setSession(next);
    } finally {
      setRetrying(false);
    }
  }, [session.id]);

  const copyField = useCallback((question: string, answer: string) => {
    void navigator.clipboard.writeText(answer).then(() => {
      setCopied(question);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  return (
    <div className="space-y-5">
      <Header session={session} />

      {session.preparing && !session.payload && <PreparingPanel />}

      {session.error && (
        <Card>
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-danger">
              Preparation failed
            </div>
            <p className="text-sm text-foreground leading-relaxed">
              {session.error}
            </p>
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={retry}
                loading={retrying}
              >
                Retry
              </Button>
            </div>
          </div>
        </Card>
      )}

      {session.payload && session.payload.fields.length > 0 && (
        <PayloadSection
          fields={session.payload.fields}
          onCopy={copyField}
          copied={copied}
          jobUrl={session.jobUrl}
        />
      )}

      {!session.preparing && !session.payload && !session.error && (
        <EmptyState
          title="Nothing drafted yet"
          description="The agent finished but didn't return any form fields. Use Retry to run it again."
          action={
            <Button variant="secondary" size="sm" onClick={retry} loading={retrying}>
              Retry prepare
            </Button>
          }
        />
      )}

      {session.history.length > 0 && <AgentNotes history={session.history} />}
    </div>
  );
}

function Header({ session }: { session: ApplySession }) {
  const scoreLabel =
    session.score !== null ? `${session.score.toFixed(1)}/5` : null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <Link
          href="/discover"
          className="hover:text-foreground transition"
          aria-label="Back to Discover"
        >
          ← Discover
        </Link>
        {session.jobNum !== null && (
          <span className="tabular-nums">#{session.jobNum}</span>
        )}
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {session.title ?? "Untitled role"}
      </h1>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted truncate">
          {session.company ?? "Unknown company"}
        </p>
        {scoreLabel && (
          <span className="text-xs font-semibold tabular-nums text-accent">
            {scoreLabel}
          </span>
        )}
      </div>
      <a
        href={session.jobUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[11px] text-subtle hover:text-accent transition"
      >
        Open job posting ↗
      </a>
    </div>
  );
}

function PreparingPanel() {
  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Spinner />
          <div>
            <div className="text-sm font-semibold text-foreground">
              Drafting your application
            </div>
            <div className="text-xs text-muted">
              Fetching the posting, extracting the form, drafting answers
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <LoadingSkeleton height={16} className="w-1/3" />
          <LoadingSkeleton height={40} className="w-full" />
          <LoadingSkeleton height={16} className="w-1/4" />
          <LoadingSkeleton height={40} className="w-full" />
        </div>
        <p className="text-[11px] text-subtle">
          This usually takes 1–3 minutes. You can close the tab and come back —
          the draft will be waiting.
        </p>
      </div>
    </Card>
  );
}

function PayloadSection({
  fields,
  onCopy,
  copied,
  jobUrl,
}: {
  fields: { question: string; answer: string }[];
  onCopy: (question: string, answer: string) => void;
  copied: string | null;
  jobUrl: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Drafted answers
        </h2>
        <span className="text-[11px] text-subtle tabular-nums">
          {fields.length} field{fields.length === 1 ? "" : "s"}
        </span>
      </div>

      <ul className="space-y-3" aria-label="Application form fields">
        {fields.map((f, idx) => (
          <li key={`${idx}-${f.question}`}>
            <Card>
              <div className="space-y-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {f.question}
                </div>
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {f.answer || (
                    <span className="italic text-subtle">
                      (blank — candidate to fill)
                    </span>
                  )}
                </p>
                {f.answer && (
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onCopy(f.question, f.answer)}
                    >
                      {copied === f.question ? "Copied ✓" : "Copy answer"}
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>

      <Card>
        <div className="space-y-2">
          <div className="text-xs font-semibold text-foreground">
            Ready to submit?
          </div>
          <p className="text-[11px] text-muted leading-relaxed">
            Autonomous dispatch arrives in a later phase. For now, open the
            posting in a new tab and paste each answer into its field.
          </p>
          <a
            href={jobUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block"
          >
            <Button variant="primary" size="sm">
              Open posting in new tab ↗
            </Button>
          </a>
        </div>
      </Card>
    </div>
  );
}

function AgentNotes({
  history,
}: {
  history: ApplySession["history"];
}) {
  const agentMessages = history.filter((m) => m.role === "agent");
  if (agentMessages.length === 0) return null;
  return (
    <details className="rounded-2xl border border-border bg-surface-muted p-4">
      <summary className="cursor-pointer text-xs font-semibold text-muted">
        Agent notes
      </summary>
      <div className="mt-3 space-y-3 text-xs leading-relaxed text-foreground">
        {agentMessages.map((m, idx) => (
          <p key={idx} className="whitespace-pre-wrap">
            {m.content}
          </p>
        ))}
      </div>
    </details>
  );
}

function Spinner() {
  return (
    <svg
      className="h-5 w-5 animate-spin text-accent"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.2"
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
