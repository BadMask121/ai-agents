"use client";

import { useState, useTransition } from "react";
import type { PipelineItem } from "@/lib/pipeline";

type Tab = "pending" | "processed" | "blocked";

export function PipelineBoard({ initial }: { initial: PipelineItem[] }) {
  const [items, setItems] = useState(initial);
  const [tab, setTab] = useState<Tab>("pending");
  const [url, setUrl] = useState("");
  const [pending, startTransition] = useTransition();
  const [log, setLog] = useState<string>("");
  const [running, setRunning] = useState(false);

  const filtered = items.filter((i) => i.state === tab);

  const addUrl = async () => {
    if (!url.trim()) return;
    const res = await fetch("/api/pipeline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url.trim() }),
    });
    if (res.ok) {
      const { item } = await res.json();
      setItems((prev) => {
        if (prev.some((p) => p.id === item.id)) return prev;
        return [...prev, item];
      });
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

  const approve = async (item: PipelineItem) => {
    setRunning(true);
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
      setState(item.id, "processed");
    } catch (err) {
      setLog(`error: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addUrl();
          }}
          placeholder="Paste a job URL…"
          className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-zinc-600"
        />
        <button
          type="button"
          onClick={addUrl}
          disabled={pending || !url.trim()}
          className="rounded-lg bg-zinc-100 text-zinc-900 px-4 py-2.5 text-sm font-medium disabled:opacity-40"
        >
          Add
        </button>
      </div>

      <div className="flex gap-1 text-xs">
        {(["pending", "processed", "blocked"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg capitalize transition ${
              tab === t
                ? "bg-zinc-100 text-zinc-900"
                : "bg-zinc-900 text-zinc-400 hover:text-zinc-100"
            }`}
          >
            {t} ({items.filter((i) => i.state === t).length})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-500">
          no {tab} items
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3"
            >
              <div className="space-y-1">
                <div className="text-sm font-medium truncate">
                  {item.title ?? "Untitled role"}
                </div>
                <div className="text-xs text-zinc-400 truncate">
                  {item.company ?? "Unknown company"}
                </div>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-zinc-500 hover:text-zinc-200 truncate block"
                >
                  {item.url}
                </a>
              </div>
              <div className="flex gap-2">
                {tab === "pending" && (
                  <>
                    <button
                      type="button"
                      onClick={() => approve(item)}
                      disabled={running}
                      className="flex-1 rounded-lg bg-green-600/90 hover:bg-green-600 text-white px-3 py-2 text-xs font-medium disabled:opacity-40"
                    >
                      {running ? "evaluating…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setState(item.id, "blocked")}
                      className="rounded-lg bg-zinc-800 hover:bg-zinc-700 px-3 py-2 text-xs font-medium"
                    >
                      Skip
                    </button>
                  </>
                )}
                {tab !== "pending" && (
                  <>
                    <button
                      type="button"
                      onClick={() => setState(item.id, "pending")}
                      className="flex-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 px-3 py-2 text-xs font-medium"
                    >
                      Move to pending
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(item.id)}
                      className="rounded-lg border border-red-900 text-red-400 hover:bg-red-950 px-3 py-2 text-xs font-medium"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {log && (
        <div className="rounded-xl border border-zinc-800 bg-black p-3">
          <div className="text-xs text-zinc-500 mb-2">
            agent output
          </div>
          <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap break-all max-h-80 overflow-auto font-mono">
            {log}
          </pre>
        </div>
      )}
    </div>
  );
}
