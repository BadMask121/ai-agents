import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/ui/Card";
import Link from "next/link";

export const dynamic = "force-dynamic";

// Test page for the autofill bookmarklet. Mirrors the field shapes you see on
// most ATS forms (Greenhouse, Lever, Workday-lite). Open this on the device
// where you installed the bookmarklet, then tap Bookmarks → Autofill.
export default function AutofillTestFormPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-5 py-6 space-y-6">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Autofill test form
          </h1>
          <p className="text-sm text-muted">
            Tap your <span className="font-medium">Autofill</span> bookmark.
            Filled fields stay; the floating overlay shows what was matched.
            <br />
            <Link
              href="/install-autofill"
              className="text-accent underline underline-offset-4"
            >
              ← Back to install steps
            </Link>
          </p>
        </header>

        <Card>
          <form
            id="test-application"
            action="#"
            className="space-y-4"
          >
            <Field id="firstName" label="First Name" />
            <Field id="lastName" label="Last Name" />
            <Field id="email" label="Email Address" type="email" />
            <Field id="phone" label="Phone" type="tel" />
            <Field id="loc" label="Current City" />
            <Field
              id="linkedin"
              label="LinkedIn URL"
              ariaLabel="LinkedIn URL"
              name="linkedin_url"
            />
            <Field
              id="github"
              label="GitHub"
              placeholder="GitHub profile URL"
            />
            <Field id="ct" label="Current Title" />
            <Field id="cc" label="Current Employer" />

            <div className="space-y-1">
              <label
                htmlFor="auth"
                className="block text-xs font-medium text-muted"
              >
                Are you authorized to work in this country?
              </label>
              <select
                id="auth"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                defaultValue=""
              >
                <option value="">--</option>
                <option>Yes</option>
                <option>No</option>
              </select>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="sponsor"
                className="block text-xs font-medium text-muted"
              >
                Will you require sponsorship?
              </label>
              <select
                id="sponsor"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                defaultValue=""
              >
                <option value="">--</option>
                <option>Yes</option>
                <option>No</option>
              </select>
            </div>

            <Field id="sal" label="Salary Expectation" />
            <Field id="np" label="Notice Period" />
            <Field id="yoe" label="Years of Experience" />
            <Field id="pr" label="Pronouns" />

            <div className="space-y-1">
              <label
                htmlFor="cover"
                className="block text-xs font-medium text-muted"
              >
                Cover Letter (free-text — won&apos;t fill yet)
              </label>
              <textarea
                id="cover"
                rows={4}
                aria-label="Cover Letter"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              />
            </div>
          </form>
        </Card>
      </div>
    </AppShell>
  );
}

function Field({
  id,
  label,
  type = "text",
  name,
  placeholder,
  ariaLabel,
}: {
  id: string;
  label: string;
  type?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        name={name}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      />
    </div>
  );
}
