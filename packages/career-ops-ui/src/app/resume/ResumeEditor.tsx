"use client";

import { useState, useTransition, useRef } from "react";

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
      <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-center">
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
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-lg bg-zinc-100 text-zinc-900 px-4 py-2 text-sm font-medium"
        >
          Upload resume
        </button>
        <p className="mt-2 text-xs text-zinc-500">
          .docx, .pdf, .md — pandoc converts to markdown
        </p>
      </div>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        className="w-full h-[60vh] resize-y rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm font-mono outline-none focus:border-zinc-600"
      />

      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          {status ?? `${content.length} chars`}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-lg bg-zinc-100 text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {pending ? "saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
