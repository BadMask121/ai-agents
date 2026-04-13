type Props = {
  className?: string;
  width?: string | number;
  height?: string | number;
  rounded?: "sm" | "md" | "lg" | "xl" | "full";
};

const ROUND: Record<NonNullable<Props["rounded"]>, string> = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  full: "rounded-full",
};

export function LoadingSkeleton({
  className = "",
  width,
  height,
  rounded = "md",
}: Props) {
  return (
    <div
      className={`animate-pulse bg-zinc-800/80 ${ROUND[rounded]} ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
