import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { serverMessages } from "@/i18n/server";
import { HealthBanner } from "@/app/client/health-banner";
import { EquipmentStudio } from "./equipment-studio";

export default async function EquipmentPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const c = await serverMessages(commonMessages);
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>{c.backToProject}</Link>
      </p>
      <HealthBanner />
      <EquipmentStudio projectId={projectId} />
    </main>
  );
}
