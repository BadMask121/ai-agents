import { AppShell } from "@/components/AppShell";
import { ConfigEditor } from "../ConfigEditor";

export const dynamic = "force-dynamic";

export default function ModesProfileSettingsPage() {
  return (
    <AppShell>
      <ConfigEditor
        kind="modesProfile"
        title="Narrative"
        subtitle="modes/_profile.md — archetypes and negotiation scripts"
        language="markdown"
      />
    </AppShell>
  );
}
