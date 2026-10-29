// The owner's /metrics: every model call (Jev, DeepSeek, Workers AI) and how
// each Telegram message was handled, counted per day across all DJs in the
// Registry, and drawn as text bar charts for Telegram. Counts only: no
// message text, no chat ids, no DJ ids.

import type { AiRunner } from "./telegram-agent";

export interface UsageEvent {
  /** "model": one call to a model; "route": which layer handled a message. */
  kind: "model" | "route";
  /** The model id, or the layer (code, jev, assistant, buttons). */
  name: string;
  ok: boolean;
  ms: number;
  tokensIn: number;
  tokensOut: number;
}

/** One Registry row: a day's totals for one kind/name/ok. */
export interface UsageRow {
  day: string;
  kind: string;
  name: string;
  ok: number;
  calls: number;
  ms: number;
  tokens_in: number;
  tokens_out: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/** Tokens from an OpenAI-style or Workers AI response. */
export function tokensOf(raw: unknown): { tokensIn: number; tokensOut: number } {
  const u = (raw as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  return { tokensIn: num(u.prompt_tokens ?? u.input_tokens), tokensOut: num(u.completion_tokens ?? u.output_tokens) };
}

/** A model runner that reports each call (time, tokens, success) before returning or throwing. */
export function meteredRunner(ai: AiRunner, model: string, onCall: (e: UsageEvent) => void): AiRunner {
  return {
    async run(m, inputs) {
      const started = Date.now();
      try {
        const out = await ai.run(m, inputs);
        onCall({ kind: "model", name: model, ok: true, ms: Date.now() - started, ...tokensOf(out) });
        return out;
      } catch (e) {
        onCall({ kind: "model", name: model, ok: false, ms: Date.now() - started, tokensIn: 0, tokensOut: 0 });
        throw e;
      }
    },
  };
}

// ---------- the chart ----------

/**
 * Per million tokens, in USD: estimates for the owner's eyes, not billing.
 * Jev: TypeSafe's published rate (output free). DeepSeek V4.1 Flash 1017 on
 * Fireworks: third-party trackers' figures. Workers AI: the free allowance.
 */
function priceOf(model: string): { in: number; out: number } | null {
  if (model.startsWith("jev")) return { in: 0.042, out: 0 };
  if (model.includes("deepseek")) return { in: 0.3, out: 1.2 };
  if (model.startsWith("@cf/")) return { in: 0, out: 0 };
  return null;
}

export function modelLabel(model: string): string {
  if (model.startsWith("jev")) return "Jev";
  if (model.includes("deepseek")) return "DeepSeek";
  const last = model.split("/").at(-1) ?? model;
  return model.startsWith("@cf/") ? `${last.split("-").slice(0, 2).join(" ")} (CF)` : last;
}

const LAYERS: [string, string][] = [
  ["code", "Code"],
  ["jev", "Jev"],
  ["assistant", "Assistant"],
  ["buttons", "Buttons"],
];

const BAR_WIDTH = 12;
const EIGHTHS = "▏▎▍▌▋▊▉";

export function bar(n: number, max: number, width = BAR_WIDTH): string {
  if (n <= 0 || max <= 0) return "";
  const eighths = Math.max(1, Math.round((n / max) * width * 8));
  return "█".repeat(Math.floor(eighths / 8)) + (eighths % 8 ? EIGHTHS[(eighths % 8) - 1] : "");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dayBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const money = (usd: number) => (usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const thousands = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

function chart(rows: [string, number, string][]): string {
  if (rows.length === 0) return "none yet";
  const max = Math.max(...rows.map((r) => r[1]), 0);
  const width = Math.max(...rows.map((r) => r[0].length), 0);
  return rows.map(([label, n, note]) => `${label.padEnd(width)} ${bar(n, max).padEnd(BAR_WIDTH)} ${n}${note}`).join("\n");
}

/** The /metrics message (Telegram HTML): the last `days` days ending `today`. */
export function usageReport(rows: UsageRow[], today: string, days = 7): string {
  const since = dayBefore(today, days - 1);
  const recent = rows.filter((r) => r.day >= since && r.day <= today);
  const models = recent.filter((r) => r.kind === "model");
  if (recent.length === 0) return `<b>DJ Sync metrics</b>\nNo model calls or messages counted in the last ${days} days.`;

  type M = { calls: number; failed: number; ms: number; tin: number; tout: number; today: number };
  const byModel = new Map<string, M>();
  for (const r of models) {
    const m = byModel.get(r.name) ?? { calls: 0, failed: 0, ms: 0, tin: 0, tout: 0, today: 0 };
    m.calls += r.calls;
    if (!r.ok) m.failed += r.calls;
    m.ms += r.ms;
    m.tin += r.tokens_in;
    m.tout += r.tokens_out;
    if (r.day === today) m.today += r.calls;
    byModel.set(r.name, m);
  }
  const ordered = [...byModel].sort((a, b) => b[1].calls - a[1].calls).slice(0, 8);
  const cost = (model: string, m: M) => {
    const p = priceOf(model);
    return p ? (m.tin * p.in + m.tout * p.out) / 1e6 : null;
  };
  const total = ordered.reduce((n, [, m]) => n + m.calls, 0);
  const totalToday = ordered.reduce((n, [, m]) => n + m.today, 0);
  const totalCost = ordered.reduce((n, [model, m]) => n + (cost(model, m) ?? 0), 0);

  const perDay: [string, number, string][] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayBefore(today, i);
    const d = new Date(`${day}T00:00:00Z`);
    const label = `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
    perDay.push([label, models.filter((r) => r.day === day).reduce((n, r) => n + r.calls, 0), ""]);
  }

  const handled = LAYERS.map(([key, label]): [string, number, string] => [
    label,
    recent.filter((r) => r.kind === "route" && r.name === key).reduce((n, r) => n + r.calls, 0),
    "",
  ]);

  const details = ordered.map(([model, m]) => {
    const c = cost(model, m);
    return (
      `${modelLabel(model)}: avg ${secs(m.ms / Math.max(m.calls, 1))}, ${thousands(m.tin)} tokens in` +
      (m.tout > 0 ? ` / ${thousands(m.tout)} out` : "") +
      (c === null ? "" : `, ~${money(c)}`)
    );
  });

  return [
    `<b>DJ Sync metrics</b> (last ${days} days, UTC)`,
    `${total} model calls, ${totalToday} today · est. ${money(totalCost)}`,
    "",
    "<b>Calls by model</b>",
    `<pre>${esc(chart(ordered.map(([model, m]) => [modelLabel(model), m.calls, m.failed > 0 ? ` (${m.failed} failed)` : ""])))}</pre>`,
    "<b>Model calls per day</b>",
    `<pre>${esc(chart(perDay))}</pre>`,
    "<b>Messages handled by</b>",
    `<pre>${esc(chart(handled))}</pre>`,
    esc(details.join("\n")),
    "<i>Costs are estimates from list prices; check each provider's console for billing.</i>",
  ].join("\n");
}
