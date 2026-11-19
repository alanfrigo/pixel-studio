import Link from "next/link";
import { HealthBanner } from "@/app/client/health-banner";
import { EquipmentStudio } from "./equipment-studio";

export default async function EquipmentPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>← Projeto</Link>
      </p>
      <HealthBanner />
      <EquipmentStudio projectId={projectId} />
    </main>
  );
}
