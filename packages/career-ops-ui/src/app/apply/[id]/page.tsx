import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getSession } from "@/lib/applySession";
import { ApplyView } from "./ApplyView";

export const dynamic = "force-dynamic";

export default async function ApplySessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) notFound();

  return (
    <AppShell>
      <ApplyView initial={session} />
    </AppShell>
  );
}
