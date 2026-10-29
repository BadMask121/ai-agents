// The owner's /stats: download counts the site Worker keeps in R2
// (apps/dj-sync-site: djsync/stats/downloads.json). Private to the Telegram
// chat in ALERT_CHAT_ID; for anyone else /stats doesn't exist.

export const DOWNLOAD_STATS_KEY = "djsync/stats/downloads.json";

/** days → "install:1.3.4" | "update:1.3.4" → count. */
export interface DownloadStats {
  days: Record<string, Record<string, number>>;
}

export interface StatsBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

export function summarize(stats: DownloadStats, today: string): string {
  const days = Object.keys(stats.days).sort();
  if (days.length === 0) return "No downloads counted yet.";
  const sum = (from: string, kind: string) =>
    days
      .filter((d) => d >= from)
      .reduce((n, d) => n + Object.entries(stats.days[d]!).filter(([k]) => k.startsWith(`${kind}:`)).reduce((a, [, v]) => a + v, 0), 0);
  const ago = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const line = (label: string, from: string) => {
    const failed = sum(from, "failed-missing") + sum(from, "failed-error");
    return `${label}: ${sum(from, "install")} installs, ${sum(from, "update")} updates${failed > 0 ? `, ${failed} failed` : ""}`;
  };
  const versions = new Map<string, number>();
  for (const d of days) for (const [k, v] of Object.entries(stats.days[d]!)) if (k.startsWith("install:")) versions.set(k.slice(8), (versions.get(k.slice(8)) ?? 0) + v);
  const top = [...versions].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `• ${v}: ${n}`);
  const failures = new Map<string, number>();
  for (const d of days)
    for (const [k, v] of Object.entries(stats.days[d]!)) {
      const m = /^failed-(missing|error):(.+)$/.exec(k);
      if (m) failures.set(`${m[2]} (${m[1] === "missing" ? "not found" : "server error"})`, (failures.get(`${m[2]} (${m[1] === "missing" ? "not found" : "server error"})`) ?? 0) + v);
    }
  const failed = [...failures].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `• ${k}: ${n}`);
  return [
    "DJ Sync downloads",
    line("Today", today),
    line("Last 7 days", ago(6)),
    line(`Since ${days[0]}`, days[0]!),
    ...(top.length > 0 ? ["", "Installs by version:", ...top] : []),
    ...(failed.length > 0 ? ["", "Failed downloads:", ...failed] : []),
  ].join("\n");
}

export async function downloadStatsText(bucket: StatsBucket | undefined, today: string): Promise<string> {
  if (!bucket) return "Download counts aren't connected.";
  try {
    const object = await bucket.get(DOWNLOAD_STATS_KEY);
    if (!object) return "No downloads counted yet.";
    const raw = (await object.json()) as Partial<DownloadStats> | null;
    return summarize({ days: raw?.days ?? {} }, today);
  } catch {
    return "Couldn't read the download counts.";
  }
}
