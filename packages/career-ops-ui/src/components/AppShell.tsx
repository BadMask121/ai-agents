"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type NavItem = {
  href: string;
  label: string;
  icon: (active: boolean) => ReactNode;
};

const NAV: NavItem[] = [
  { href: "/discover", label: "Discover", icon: DiscoverIcon },
  { href: "/pipeline", label: "Pipeline", icon: PipelineIcon },
  { href: "/resume", label: "Resume", icon: ResumeIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto max-w-2xl px-5 py-3 flex items-center justify-between">
          <Link
            href="/discover"
            className="text-sm font-semibold tracking-tight text-foreground"
          >
            career-ops
          </Link>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="text-xs text-muted hover:text-foreground transition"
            >
              sign out
            </button>
          </form>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-2xl px-5 py-6 pb-32">
        {children}
      </main>

      {/* Floating pill nav — the defining chrome of the new design. */}
      <nav
        aria-label="Primary"
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-20"
      >
        <div className="flex items-center gap-1 rounded-full border border-border bg-surface/95 px-2 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.6),0_0_0_1px_rgb(0_230_118/0.12)] backdrop-blur">
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex flex-col items-center gap-0.5 rounded-full px-4 py-1.5 text-[10px] font-medium transition",
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:text-foreground hover:bg-surface-muted",
                ].join(" ")}
              >
                {item.icon(active)}
                <span className="leading-none">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/* ───────────────────────── Icons ───────────────────────── */

function iconClass(active: boolean) {
  return `h-4 w-4 ${active ? "stroke-accent" : "stroke-current"}`;
}

function DiscoverIcon(active: boolean) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={iconClass(active)}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m16 8-5 3-3 5 5-3 3-5Z" />
    </svg>
  );
}

function PipelineIcon(active: boolean) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={iconClass(active)}
    >
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h16" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function ResumeIcon(active: boolean) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={iconClass(active)}
    >
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

function SettingsIcon(active: boolean) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={iconClass(active)}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.13.31.2.65.2 1" />
    </svg>
  );
}
