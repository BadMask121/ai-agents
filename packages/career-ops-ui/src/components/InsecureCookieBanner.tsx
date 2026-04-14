// Renders a permanent, non-dismissable warning bar at the top of every page
// when the ALLOW_INSECURE_COOKIES flag is on. The banner is intentionally loud
// and intentionally not dismissable — the whole point is that it cannot be
// forgotten. Removed alongside the flag (tracked by bd ai-agents-0xv).

import { insecureCookiesEnabled } from "@/lib/auth";

export function InsecureCookieBanner() {
  if (!insecureCookiesEnabled()) return null;
  return (
    <div
      role="alert"
      className="sticky top-0 z-50 border-b border-danger/30 bg-danger-soft px-4 py-2 text-center text-xs font-medium text-danger shadow-sm"
    >
      ⚠ insecure-cookie mode is on — sessions are issued without the{" "}
      <code className="font-mono">Secure</code> flag. set up TLS (deploy
      checklist phase 5) and remove{" "}
      <code className="font-mono">ALLOW_INSECURE_COOKIES</code> from your env
      vars. tracked by bd <code className="font-mono">ai-agents-0xv</code>.
    </div>
  );
}
