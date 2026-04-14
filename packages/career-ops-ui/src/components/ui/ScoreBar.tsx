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

  // Color cascade: accent (orange) if >= 4, warning if >= 3, danger below.
  const fill =
    !present
      ? "bg-surface-sunk"
      : clamped >= 4
        ? "bg-accent"
        : clamped >= 3
          ? "bg-warning"
          : "bg-danger";

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-semibold tabular-nums text-foreground">
          {present ? `${clamped.toFixed(1)}/${max}` : "—"}
        </span>
      </div>
      <div
        className="h-1.5 rounded-full bg-surface-sunk overflow-hidden"
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
