"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingSkeleton } from "@/components/ui/LoadingSkeleton";
import type { ApplySession, ApplyField } from "@/lib/applySession";

type Props = { initial: ApplySession };

// How long a just-updated field card pulses the accent border before
// fading back to normal. 2s is long enough to notice but short enough
// that repeated edits don't leave stale highlights behind.
const HIGHLIGHT_MS = 2000;

export function ApplyView({ initial }: Props) {
  const [session, setSession] = useState<ApplySession>(initial);
  const [copied, setCopied] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Set of field indices that just changed via chat — used to flash the
  // accent border so the user sees which cards the agent just updated.
  const [highlighted, setHighlighted] = useState<Set<number>>(new Set());
  const prevFieldsRef = useRef<ApplyField[] | null>(
    initial.payload?.fields ?? null,
  );

  // Diff payload fields across updates and highlight the indices that
  // changed. This also covers the prepare → ready transition on first
  // payload arrival, which is fine — the highlight just draws attention
  // to freshly-drafted answers.
  useEffect(() => {
    const prev = prevFieldsRef.current;
    const next = session.payload?.fields ?? null;
    if (!prev || !next) {
      prevFieldsRef.current = next;
      return;
    }
    const changed = new Set<number>();
    const max = Math.max(prev.length, next.length);
    for (let i = 0; i < max; i++) {
      if (prev[i]?.answer !== next[i]?.answer) changed.add(i);
    }
    prevFieldsRef.current = next;
    if (changed.size === 0) return;
    setHighlighted(changed);
    const t = setTimeout(() => setHighlighted(new Set()), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [session.payload]);

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
          highlighted={highlighted}
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

      {session.payload && (
        <ChatPanel
          session={session}
          onSessionUpdate={setSession}
        />
      )}
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
  highlighted,
}: {
  fields: { question: string; answer: string }[];
  onCopy: (question: string, answer: string) => void;
  copied: string | null;
  jobUrl: string;
  highlighted: Set<number>;
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
        {fields.map((f, idx) => {
          const isHighlighted = highlighted.has(idx);
          return (
            <li key={`${idx}-${f.question}`}>
              <Card
                className={
                  isHighlighted
                    ? "border-accent/60 shadow-[0_0_0_1px_rgb(0_230_118/0.4)] transition-all"
                    : "transition-all"
                }
              >
                <div className="space-y-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {f.question}
                    </div>
                    {isHighlighted && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-accent shrink-0">
                        just updated
                      </span>
                    )}
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
          );
        })}
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

function ChatPanel({
  session,
  onSessionUpdate,
}: {
  session: ApplySession;
  onSessionUpdate: (next: ApplySession) => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Show only user + agent turns in the chat thread. System messages are
  // internal and shouldn't clutter the conversation.
  const visibleHistory = useMemo(
    () => session.history.filter((m) => m.role !== "system"),
    [session.history],
  );

  // Auto-scroll to the bottom when new messages land. Only when the chat
  // is the user's current focus, not when the payload updates far above.
  useEffect(() => {
    if (streamingText !== null || sending) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [visibleHistory.length, streamingText, sending]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setSendError(null);
    setStreamingText("");
    setInput("");

    try {
      const res = await fetch(`/api/apply/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setSendError(body.error ?? `HTTP ${res.status}`);
        setStreamingText(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      let accumulated = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const frames = sseBuf.split("\n\n");
        sseBuf = frames.pop() ?? "";

        for (const frame of frames) {
          const lines = frame.split("\n");
          let event = "message";
          let data = "";
          for (const ln of lines) {
            if (ln.startsWith("event:")) event = ln.slice(6).trim();
            else if (ln.startsWith("data:")) data += ln.slice(5).trim();
          }
          if (!data) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event === "delta" && typeof parsed.text === "string") {
            accumulated += parsed.text;
            setStreamingText(accumulated);
          } else if (event === "done" && parsed.session) {
            onSessionUpdate(parsed.session as ApplySession);
            setStreamingText(null);
          } else if (event === "error" && typeof parsed.message === "string") {
            setSendError(parsed.message);
          }
        }
      }
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSending(false);
      setStreamingText(null);
    }
  }, [input, sending, session.id, onSessionUpdate]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Iterate with AI
        </h2>
        <span className="text-[10px] text-subtle">
          Enter to send · Shift+Enter for newline
        </span>
      </div>

      <Card className="space-y-3">
        {visibleHistory.length === 0 && streamingText === null && (
          <p className="text-xs text-subtle italic leading-relaxed">
            Tell the agent how you want the drafts changed. Examples:
            <br />
            &ldquo;make the cover letter more casual, cut to 3 sentences&rdquo;
            <br />
            &ldquo;rewrite the salary expectation to $180-220k&rdquo;
            <br />
            &ldquo;add a sentence mentioning my Rust experience to &lsquo;why
            this role&rsquo;&rdquo;
          </p>
        )}

        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {visibleHistory.map((m, idx) => (
            <ChatBubble key={idx} role={m.role} content={m.content} />
          ))}
          {streamingText !== null && (
            <ChatBubble
              role="agent"
              content={streamingText || "…"}
              streaming
            />
          )}
          <div ref={messagesEndRef} />
        </div>

        {sendError && (
          <div className="rounded-lg bg-danger-soft border border-danger/20 px-3 py-2 text-[11px] text-danger">
            {sendError}
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-border pt-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the agent to change an answer…"
            disabled={sending}
            rows={2}
            className="flex-1 resize-none rounded-xl border border-border bg-surface-muted px-3 py-2 text-sm text-foreground placeholder:text-subtle outline-none focus:border-accent focus:bg-surface disabled:opacity-50"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={send}
            loading={sending}
            disabled={!input.trim() || sending}
          >
            Send
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ChatBubble({
  role,
  content,
  streaming = false,
}: {
  role: ApplySession["history"][number]["role"];
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      aria-label={isUser ? "You" : "Assistant"}
    >
      <div
        className={[
          "max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words",
          isUser
            ? "bg-accent text-accent-fg"
            : "bg-surface-muted text-foreground border border-border",
        ].join(" ")}
      >
        {content}
        {streaming && (
          <span className="inline-block w-1.5 h-3 ml-1 align-middle bg-accent animate-pulse rounded-sm" />
        )}
      </div>
    </div>
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
