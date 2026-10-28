/** Constant-time string comparison (length is not secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Same rules as the Mac's MCP_SECRET_PATH check. */
export function validSecretPath(s: string | undefined): s is string {
  return typeof s === "string" && s.length >= 32 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** 12 hex chars — short enough for ChatGPT (or a human) to repeat back. */
export function newJobId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function addSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * 1000);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function relativeTime(iso: string, now: Date): string {
  const secs = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Downloader errors end with the tool's own output; its last `ERROR` line
 * says why (e.g. "Video unavailable"), so prefer that over wrapper text.
 */
export function errorSummary(s: string): string {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return [...lines].reverse().find((l) => l.includes("ERROR")) ?? lines[0] ?? s;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}
