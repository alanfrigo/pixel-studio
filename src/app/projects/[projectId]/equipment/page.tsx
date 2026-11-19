import { HealthBanner } from "@/app/client/health-banner";
import { EquipmentStudio } from "./equipment-studio";

export default async function EquipmentPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <>
      <HealthBanner />
      <EquipmentStudio projectId={projectId} />
    </>
  );
}
