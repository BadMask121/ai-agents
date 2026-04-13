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
    <div className="w-full max-w-sm space-y-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
      <div className="h-5 w-24 rounded bg-zinc-800 animate-pulse" />
      <div className="h-10 rounded bg-zinc-800 animate-pulse" />
      <div className="h-10 rounded bg-zinc-800 animate-pulse" />
    </div>
  );
}
