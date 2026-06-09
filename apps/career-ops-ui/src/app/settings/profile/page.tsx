import { AppShell } from "@/components/AppShell";
import { ConfigEditor } from "../ConfigEditor";

export const dynamic = "force-dynamic";

export default function ProfileSettingsPage() {
  return (
    <AppShell>
      <ConfigEditor
        kind="profile"
        title="Profile"
        subtitle="config/profile.yml — identity, targets, comp range"
        language="yaml"
      />
    </AppShell>
  );
}
