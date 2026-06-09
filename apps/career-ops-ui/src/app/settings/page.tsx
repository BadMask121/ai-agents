import Link from "next/link";
import { AppShell } from "@/components/AppShell";

const SETTINGS = [
  {
    href: "/settings/profile",
    title: "Profile",
    subtitle: "Identity, targets, archetypes (config/profile.yml)",
  },
  {
    href: "/settings/portals",
    title: "Portals",
    subtitle: "Company career boards to scan (portals.yml)",
  },
  {
    href: "/settings/modes-profile",
    title: "Narrative",
    subtitle: "Your archetypes and negotiation scripts (modes/_profile.md)",
  },
];

export default function SettingsPage() {
  return (
    <AppShell>
      <div className="space-y-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Settings
          </h1>
          <p className="text-sm text-muted">
            Edit the user-layer files career-ops reads.
          </p>
        </header>
        <ul className="space-y-2">
          {SETTINGS.map((s) => (
            <li key={s.href}>
              <Link
                href={s.href}
                className="block rounded-2xl border border-border bg-surface hover:border-accent/40 hover:shadow-[0_0_0_1px_rgb(0_230_118/0.2)] px-5 py-4 transition"
              >
                <div className="text-sm font-semibold text-foreground">
                  {s.title}
                </div>
                <div className="text-xs text-muted mt-0.5">{s.subtitle}</div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}
