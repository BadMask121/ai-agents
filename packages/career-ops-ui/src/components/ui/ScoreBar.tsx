type Props = {
  label: string;
  score: number | undefined;
  max?: number;
};

export function ScoreBar({ label, score, max = 5 }: Props) {
  const value = score ?? 0;
  const clamped = Math.max(0, Math.min(max, value));
  const percent = (clamped / max) * 100;
  const present = score !== undefined && !Number.isNaN(score);

  // Color cascade: green if >= 4, amber if >= 3, red below.
  const fill =
    !present
      ? "bg-zinc-800"
      : clamped >= 4
        ? "bg-emerald-500/80"
        : clamped >= 3
          ? "bg-amber-500/80"
          : "bg-red-500/70";

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-zinc-400">{label}</span>
        <span className="font-medium tabular-nums text-zinc-300">
          {present ? `${clamped.toFixed(1)}/${max}` : "—"}
        </span>
      </div>
      <div
        className="h-1.5 rounded-full bg-zinc-800 overflow-hidden"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={present ? clamped : undefined}
        aria-label={label}
      >
        <div
          className={`h-full rounded-full transition-all ${fill}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
