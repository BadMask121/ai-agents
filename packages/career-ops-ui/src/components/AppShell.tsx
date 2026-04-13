import Link from "next/link";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/resume", label: "Resume" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto max-w-2xl px-5 py-3 flex items-center justify-between">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            career-ops
          </Link>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="text-xs text-zinc-400 hover:text-zinc-200 transition"
            >
              sign out
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-2xl px-5 py-6 pb-28">
        {children}
      </main>
      <nav className="fixed bottom-0 inset-x-0 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto max-w-2xl grid grid-cols-4">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="py-3 text-center text-xs text-zinc-400 hover:text-zinc-100 transition"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
