import type { ReactNode } from "react";

type Variant = "success" | "outline" | "muted" | "warning" | "danger";

type Props = {
  variant?: Variant;
  children: ReactNode;
  className?: string;
};

const VARIANT: Record<Variant, string> = {
  // Solid green pill for binary state flags (Evaluated, Applied, etc).
  success:
    "bg-success-soft text-success border border-success/20",
  // Outlined pill for data chips — score, PDF ready, sponsor, etc.
  outline:
    "bg-surface text-foreground border border-border",
  // Subtle background pill for metadata — dates, #num, etc.
  muted:
    "bg-surface-muted text-muted border border-transparent",
  warning:
    "bg-warning-soft text-warning border border-warning/20",
  danger:
    "bg-danger-soft text-danger border border-danger/20",
};

export function Badge({ variant = "outline", children, className = "" }: Props) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-none whitespace-nowrap",
        VARIANT[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
