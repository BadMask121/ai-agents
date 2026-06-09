"use client";

import { useState, useTransition, useRef } from "react";
import { Button } from "@/components/ui/Button";

export function ResumeEditor({ initial }: { initial: string }) {
  const [content, setContent] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () => {
    setStatus(null);
    startTransition(async () => {
      const res = await fetch("/api/cv", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) setStatus("saved");
      else setStatus("save failed");
    });
  };

  const upload = async (file: File) => {
    setStatus(`uploading ${file.name}…`);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/cv", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(`upload failed: ${body.error ?? res.status}`);
      return;
    }
    const cv = await fetch("/api/cv").then((r) => r.json());
    setContent(cv.content);
    setStatus("uploaded and converted to cv.md");
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-dashed border-border-strong bg-surface-muted p-5 text-center">
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,.docx,.doc,.pdf,.odt,.rtf,.html"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
        <Button
          variant="secondary"
          size="md"
          onClick={() => fileRef.current?.click()}
        >
          Upload resume
        </Button>
        <p className="mt-2 text-xs text-muted">
          .docx, .pdf, .md — converted to markdown automatically
        </p>
      </div>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        placeholder="Your resume in markdown…"
        className="w-full h-[60vh] resize-y rounded-2xl border border-border bg-surface px-4 py-3 text-sm font-mono text-foreground placeholder:text-subtle outline-none focus:border-accent"
      />

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted tabular-nums">
          {status ?? `${content.length} chars`}
        </div>
        <Button
          variant="primary"
          onClick={save}
          loading={pending}
          disabled={pending}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
