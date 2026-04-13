import { AppShell } from "@/components/AppShell";
import { readText } from "@/lib/textFile";
import { p } from "@/lib/paths";
import { ResumeEditor } from "./ResumeEditor";

export const dynamic = "force-dynamic";

export default async function ResumePage() {
  const content = await readText(p.cv);
  return (
    <AppShell>
      <div className="space-y-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Resume</h1>
          <p className="text-sm text-zinc-400">
            Source of truth for tailored CV generation.
          </p>
        </header>
        <ResumeEditor initial={content} />
      </div>
    </AppShell>
  );
}
