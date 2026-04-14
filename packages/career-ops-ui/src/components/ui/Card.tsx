import type { HTMLAttributes, ReactNode } from "react";

type CardVariant = "default" | "interactive";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
  children: ReactNode;
};

// Flat panels on black — borders carry the hierarchy rather than shadows.
// Interactive variant gets a subtle green ring on hover for the hacker vibe.
const BASE = "rounded-2xl border border-border bg-surface p-5";
const INTERACTIVE =
  "transition hover:border-accent/40 hover:shadow-[0_0_0_1px_rgb(0_230_118/0.2)] cursor-pointer";

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
