import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <Suspense fallback={<LoginFormFallback />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}

function LoginFormFallback() {
  return (
    <div className="w-full max-w-sm space-y-6 rounded-2xl border border-border bg-surface p-6 shadow-[0_4px_16px_rgba(20,14,4,0.06)]">
      <div className="h-5 w-24 rounded-full bg-surface-sunk animate-pulse" />
      <div className="h-10 rounded-full bg-surface-sunk animate-pulse" />
      <div className="h-10 rounded-full bg-surface-sunk animate-pulse" />
    </div>
  );
}
