"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "login failed");
        return;
      }
      const next = search.get("next") ?? "/";
      router.replace(next);
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm space-y-6 rounded-2xl border border-border bg-surface p-6 shadow-[0_4px_16px_rgba(20,14,4,0.06)]"
    >
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          career-ops
        </h1>
        <p className="text-sm text-muted">sign in to continue</p>
      </div>
      <div className="space-y-2">
        <label
          htmlFor="password"
          className="text-[10px] font-semibold text-muted uppercase tracking-wider"
        >
          Password
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-full border border-border bg-surface-muted px-4 py-2.5 text-sm text-foreground outline-none focus:border-accent focus:bg-surface"
        />
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-danger-soft border border-danger/20 px-3 py-2 text-xs text-danger"
        >
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={!password}
        loading={pending}
        className="w-full"
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
