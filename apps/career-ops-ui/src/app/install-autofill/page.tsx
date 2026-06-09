import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/ui/Card";
import { getOrCreateAutofillToken } from "@/lib/autofillToken";
import { CopyableSnippet } from "./CopyableSnippet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function getBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function bookmarkletSnippet(base: string, token: string): string {
  // Single-line javascript: URI. Sets globals the engine reads, then injects
  // the script with a cache-busting query so each tap pulls the latest.
  return (
    `javascript:(function(){` +
    `window.__CAREER_OPS_TOKEN=${JSON.stringify(token)};` +
    `window.__CAREER_OPS_BASE=${JSON.stringify(base)};` +
    `var s=document.createElement('script');` +
    `s.src=window.__CAREER_OPS_BASE+'/autofill.js?'+Date.now();` +
    `document.body.appendChild(s);` +
    `})();`
  );
}

export default async function InstallAutofillPage() {
  const [base, token] = await Promise.all([
    getBaseUrl(),
    getOrCreateAutofillToken(),
  ]);
  const snippet = bookmarkletSnippet(base, token);

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-5 py-6 space-y-6">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Install Autofill on iPhone
          </h1>
          <p className="text-sm text-muted">
            One-time setup. After this, tap the bookmark on any job application
            page to fill the form from your profile.
          </p>
        </header>

        <Card>
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-foreground">
              1. Copy the bookmarklet snippet
            </h2>
            <p className="text-xs text-muted">
              This contains your private token — anyone with this snippet can
              read your profile. Don&apos;t share it.
            </p>
            <CopyableSnippet value={snippet} label="Copy snippet" />
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-foreground">
              2. Add it to Safari bookmarks (iOS)
            </h2>
            <ol className="list-decimal list-inside space-y-2 text-sm text-foreground">
              <li>
                Tap the Share icon in Safari, then{" "}
                <span className="font-medium">Add Bookmark</span>. Name it{" "}
                <span className="font-mono text-xs bg-surface-muted px-1.5 py-0.5 rounded">
                  Autofill
                </span>{" "}
                and save.
              </li>
              <li>
                Tap the Bookmarks icon (open book) at the bottom of Safari.
              </li>
              <li>
                Tap <span className="font-medium">Edit</span> in the bottom-right.
              </li>
              <li>Tap your new Autofill bookmark.</li>
              <li>
                Replace the URL field with the snippet you copied above. Tap{" "}
                <span className="font-medium">Done</span>.
              </li>
            </ol>
            <p className="text-xs text-muted pt-1">
              Safari blocks pasting{" "}
              <span className="font-mono">javascript:</span> URLs directly into
              the Add Bookmark dialog — that&apos;s why you bookmark something
              first, then edit.
            </p>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-foreground">3. Try it</h2>
            <p className="text-sm text-foreground">
              Open a job application page, then tap Bookmarks → Autofill. A
              floating overlay shows what was filled and what didn&apos;t match.
            </p>
            <div className="flex gap-3 text-sm">
              <Link
                href="/install-autofill/test-form"
                className="text-accent underline underline-offset-4"
              >
                Open a test form →
              </Link>
            </div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
