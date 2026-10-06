import { AppShell } from "@/components/app-shell";
import { RecordsView } from "@/components/records-view";
export default function Page() {
  return (
    <AppShell>
      <RecordsView mode="deadlines" />
    </AppShell>
  );
}
