"use client";

import { useState } from "react";

export function CopyableSnippet({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // some browsers block clipboard on insecure origins; fall through
    }
  }

  return (
    <div className="space-y-2">
      <pre className="rounded-xl bg-surface-muted border border-border p-3 text-xs overflow-x-auto whitespace-pre-wrap break-all font-mono text-foreground">
        {value}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="px-3 py-1.5 text-xs rounded-full bg-accent text-accent-fg hover:bg-accent-hover transition"
      >
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}
