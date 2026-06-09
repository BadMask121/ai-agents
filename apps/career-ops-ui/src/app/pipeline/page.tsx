import { AppShell } from "@/components/AppShell";
import { readPipeline } from "@/lib/pipeline";
import { PipelineBoard } from "./PipelineBoard";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const items = await readPipeline();
  return (
    <AppShell>
      <PipelineBoard initial={items} />
    </AppShell>
  );
}
