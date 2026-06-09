type Size = "sm" | "md" | "lg";

type Props = {
  score: number;
  max?: number;
  size?: Size;
  showLabel?: boolean;
};

const SIZE_PX: Record<Size, number> = {
  sm: 14,
  md: 18,
  lg: 24,
};

export function StarRating({
  score,
  max = 5,
  size = "md",
  showLabel = true,
}: Props) {
  const clamped = Math.max(0, Math.min(max, score));
  const percent = (clamped / max) * 100;
  const px = SIZE_PX[size];

  return (
    <div
      className="inline-flex items-center gap-2"
      role="img"
      aria-label={`${clamped.toFixed(1)} out of ${max} stars`}
    >
      <div
        className="relative inline-block"
        style={{ width: px * max + (max - 1) * 2, height: px }}
      >
        <Stars max={max} px={px} className="text-border-strong" />
        <div
          className="absolute inset-y-0 left-0 overflow-hidden"
          style={{ width: `${percent}%` }}
        >
          <Stars max={max} px={px} className="text-accent" />
        </div>
      </div>
      {showLabel && (
        <span className="text-xs font-semibold tabular-nums text-foreground">
          {clamped.toFixed(1)}
        </span>
      )}
    </div>
  );
}

function Stars({
  max,
  px,
  className,
}: {
  max: number;
  px: number;
  className: string;
}) {
  return (
    <div className={`flex gap-[2px] ${className}`}>
      {Array.from({ length: max }, (_, i) => (
        <Star key={i} px={px} />
      ))}
    </div>
  );
}

function Star({ px }: { px: number }) {
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M12 2 L14.9 8.6 L22 9.4 L16.5 14.2 L18.2 21.2 L12 17.5 L5.8 21.2 L7.5 14.2 L2 9.4 L9.1 8.6 Z" />
    </svg>
  );
}
