import type { HTMLAttributes, ReactNode } from "react";

type CardVariant = "default" | "interactive";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
  children: ReactNode;
};

const BASE = "rounded-xl border border-zinc-800 bg-zinc-900/50 p-4";
const INTERACTIVE =
  "transition hover:bg-zinc-900 hover:border-zinc-700 cursor-pointer";

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
