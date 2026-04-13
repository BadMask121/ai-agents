// Next.js auto-loads this file once when the server boots. We use it as a
// single, loud place to warn about temporary or unsafe runtime configuration.

export async function register(): Promise<void> {
  if (process.env.ALLOW_INSECURE_COOKIES === "1") {
    const lines = [
      "",
      "════════════════════════════════════════════════════════════════════════",
      "  ⚠  ALLOW_INSECURE_COOKIES=1 — session cookies are being issued WITHOUT",
      "     the Secure flag. This is a TEMPORARY workaround so the app can be",
      "     used over plain HTTP (e.g. Coolify's sslip.io URL) until real TLS",
      "     is set up.",
      "",
      "     REMOVE THIS FLAG as soon as you have a real domain + Let's Encrypt",
      "     cert wired up via Coolify (Phase 5 of the deploy checklist).",
      "",
      "     Tracked by bd issue: ai-agents-0xv",
      "════════════════════════════════════════════════════════════════════════",
      "",
    ];
    for (const line of lines) console.warn(line);
  }
}
