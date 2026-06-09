import { z } from "zod";

/**
 * Centralized, validated runtime config. Throws a readable error at boot if a
 * required secret is missing — better than a cryptic undefined deep in a flow.
 *
 * Note: GOOGLE_REFRESH_TOKEN is intentionally NOT here — Google accounts are
 * linked at runtime via the Telegram /connect device flow and stored per-account
 * under the workspace (see paths.googleAccounts).
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  BOOKING_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  // Public callback for the Telegram /connect web flow, e.g.
  // https://booking.yourdomain.com/oauth/callback. Optional: if unset, /connect
  // is disabled (you can still link via the local auth:local loopback CLI).
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  // Port the OAuth callback web server listens on (Coolify maps the domain here).
  OAUTH_PORT: z.coerce.number().int().positive().default(8080),

  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_CHAT_ID: z.string().min(1, "TELEGRAM_CHAT_ID is required"),

  LOOPS_API_KEY: z.string().min(1, "LOOPS_API_KEY is required"),

  BOOKING_OPS_WORKSPACE: z.string().default("/workspace/booking-ops"),
  BOOKING_TIMEZONE: z.string().default("Europe/London"),
  GMAIL_POLL_SECONDS: z.coerce.number().int().positive().default(90),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | null = null;

/**
 * Load + validate config from process.env. Cached after first call.
 * Call once at worker startup so a misconfig fails fast and loudly.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid booking-ops environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: clear the memoized config so a fresh env can be loaded. */
export function resetConfigCache(): void {
  cached = null;
}
