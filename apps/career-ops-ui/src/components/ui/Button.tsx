import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
};

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover shadow-sm",
  secondary:
    "bg-surface text-foreground border border-border hover:border-border-strong hover:bg-surface-muted",
  ghost:
    "bg-transparent text-muted hover:bg-surface-muted hover:text-foreground",
  danger:
    "bg-danger-soft text-danger border border-danger/20 hover:bg-danger hover:text-white",
};

const SIZE: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs rounded-full",
  md: "px-4 py-2.5 text-sm rounded-full",
  lg: "px-5 py-3 text-base rounded-full",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: Props) {
  const cls = [
    "inline-flex items-center justify-center gap-2 font-medium transition disabled:opacity-40 disabled:cursor-not-allowed",
    VARIANT[variant],
    SIZE[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M12 2 a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
