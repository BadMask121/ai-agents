import type { HTMLAttributes, ReactNode } from "react";

type CardVariant = "default" | "interactive";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
  children: ReactNode;
};

const BASE = "rounded-2xl border border-border bg-surface p-5 shadow-[0_1px_2px_rgba(20,14,4,0.04)]";
const INTERACTIVE =
  "transition hover:border-border-strong hover:shadow-[0_2px_8px_rgba(20,14,4,0.06)] cursor-pointer";

export function Card({
  variant = "default",
  className = "",
  children,
  ...rest
}: CardProps) {
  const cls = [BASE, variant === "interactive" ? INTERACTIVE : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
