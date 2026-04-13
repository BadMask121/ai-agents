"use client";

import { useEffect, useState, useTransition } from "react";

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
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-zinc-400">{subtitle}</p>
      </header>

      {loading ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 py-10 text-center text-sm text-zinc-500">
          loading…
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="w-full h-[65vh] resize-y rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm font-mono outline-none focus:border-zinc-600"
          data-language={language}
        />
      )}

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          {status ?? `${content.length} chars`}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={pending || loading}
          className="rounded-lg bg-zinc-100 text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {pending ? "saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
