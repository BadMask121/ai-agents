import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { readPipeline } from "@/lib/pipeline";
import { p } from "@/lib/paths";
import { exists } from "@/lib/textFile";

export const dynamic = "force-dynamic";

async function loadStats() {
  const [items, hasCv, hasProfile, hasPortals] = await Promise.all([
    readPipeline().catch(() => []),
    exists(p.cv),
    exists(p.profile),
    exists(p.portals),
  ]);
  const pending = items.filter((i) => i.state === "pending").length;
  const processed = items.filter((i) => i.state === "processed").length;
  const blocked = items.filter((i) => i.state === "blocked").length;
  return { pending, processed, blocked, hasCv, hasProfile, hasPortals };
}

export default async function HomePage() {
  const stats = await loadStats();
  return (
    <AppShell>
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
          <p className="text-sm text-zinc-400">
            Your personal job application agent.
          </p>
        </header>

        <section className="grid grid-cols-3 gap-3">
          <Stat label="Pending" value={stats.pending} accent="green" />
          <Stat label="Processed" value={stats.processed} />
          <Stat label="Blocked" value={stats.blocked} accent="red" />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Quick actions
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <ActionCard
              href="/pipeline"
              title="Review pipeline"
              subtitle={`${stats.pending} jobs waiting`}
            />
            <ActionCard
              href="/resume"
              title={stats.hasCv ? "Update resume" : "Upload resume"}
              subtitle={stats.hasCv ? "cv.md is set" : "cv.md is missing"}
              warn={!stats.hasCv}
            />
            <ActionCard
              href="/settings/profile"
              title="Profile"
              subtitle={stats.hasProfile ? "configured" : "not configured"}
              warn={!stats.hasProfile}
            />
            <ActionCard
              href="/settings/portals"
              title="Portals"
              subtitle={stats.hasPortals ? "configured" : "not configured"}
              warn={!stats.hasPortals}
            />
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "green" | "red";
}) {
  const color =
    accent === "green"
      ? "text-green-400"
      : accent === "red"
      ? "text-red-400"
      : "text-zinc-100";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <div className="text-xs text-zinc-500 uppercase tracking-wider">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>
        {value}
      </div>
    </div>
  );
}

function ActionCard({
  href,
  title,
  subtitle,
  warn,
}: {
  href: string;
  title: string;
  subtitle: string;
  warn?: boolean;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 transition px-4 py-4 flex flex-col gap-1"
    >
      <div className="text-sm font-medium">{title}</div>
      <div
        className={`text-xs ${warn ? "text-amber-400" : "text-zinc-500"}`}
      >
        {subtitle}
      </div>
    </Link>
  );
}
