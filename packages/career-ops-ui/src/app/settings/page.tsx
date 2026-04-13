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
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-zinc-400">
            Edit the user-layer files career-ops reads.
          </p>
        </header>
        <ul className="space-y-2">
          {SETTINGS.map((s) => (
            <li key={s.href}>
              <Link
                href={s.href}
                className="block rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 px-4 py-3 transition"
              >
                <div className="text-sm font-medium">{s.title}</div>
                <div className="text-xs text-zinc-500 mt-0.5">{s.subtitle}</div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}
