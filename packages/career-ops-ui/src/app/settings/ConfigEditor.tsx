"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";

type Kind = "profile" | "portals" | "modesProfile";

export function ConfigEditor({
  kind,
  title,
  subtitle,
  language,
}: {
  kind: Kind;
  title: string;
  subtitle: string;
  language: "yaml" | "markdown";
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    fetch(`/api/config?kind=${kind}`)
      .then((r) => r.json())
      .then((data) => {
        setContent(data.content ?? "");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [kind]);

  const save = () => {
    setStatus(null);
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/config?kind=${kind}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setStatus("saved");
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "save failed");
      }
    });
  };

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="text-sm text-muted">{subtitle}</p>
      </header>

      {loading ? (
        <div className="rounded-2xl border border-border bg-surface-muted py-10 text-center text-sm text-muted">
          loading…
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="w-full h-[65vh] resize-y rounded-2xl border border-border bg-surface px-4 py-3 text-sm font-mono text-foreground outline-none focus:border-accent"
          data-language={language}
        />
      )}

      {error && (
        <div className="rounded-lg bg-danger-soft border border-danger/20 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted tabular-nums">
          {status ?? `${content.length} chars`}
        </div>
        <Button
          variant="primary"
          onClick={save}
          loading={pending}
          disabled={pending || loading}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
