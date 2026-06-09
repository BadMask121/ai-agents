import { AppShell } from "@/components/AppShell";
import { ConfigEditor } from "../ConfigEditor";

export const dynamic = "force-dynamic";

export default function PortalsSettingsPage() {
  return (
    <AppShell>
      <ConfigEditor
        kind="portals"
        title="Portals"
        subtitle="portals.yml — company career boards to scan"
        language="yaml"
      />
    </AppShell>
  );
}
