/**
 * Tiny structured logger. Writes a single-line JSON-ish record to stdout/stderr
 * so Coolify's log viewer stays greppable. No deps, no transport — the container
 * captures stdout and that's the log.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const base = `${ts} ${level.toUpperCase()} [${scope}] ${msg}`;
  const line = extra === undefined ? base : `${base} ${safeJson(extra)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function safeJson(value: unknown): string {
  try {
    if (value instanceof Error) {
      return JSON.stringify({ error: value.message, stack: value.stack });
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Create a scoped logger, e.g. `const log = logger("gmail")`. */
export function logger(scope: string) {
  return {
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
