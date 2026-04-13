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
      className="sticky top-0 z-50 border-b border-red-700 bg-red-900/95 px-4 py-2 text-center text-sm font-medium text-red-50 shadow-md backdrop-blur"
    >
      ⚠ insecure-cookie mode is on — sessions are issued without the{" "}
      <code className="font-mono">Secure</code> flag. set up TLS (deploy
      checklist phase 5) and remove{" "}
      <code className="font-mono">ALLOW_INSECURE_COOKIES</code> from your env
      vars. tracked by bd <code className="font-mono">ai-agents-0xv</code>.
    </div>
  );
}
