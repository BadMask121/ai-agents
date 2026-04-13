import { AppShell } from "@/components/AppShell";
import { readPipeline } from "@/lib/pipeline";
import { PipelineBoard } from "./PipelineBoard";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const items = await readPipeline();
  return (
    <AppShell>
      <div className="space-y-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
          <p className="text-sm text-zinc-400">
            Review and approve jobs to evaluate.
          </p>
        </header>
        <PipelineBoard initial={items} />
      </div>
    </AppShell>
  );
}
