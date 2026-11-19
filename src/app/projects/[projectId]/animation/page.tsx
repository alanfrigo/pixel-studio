import Link from "next/link";
import { HealthBanner } from "@/app/client/health-banner";
import { AnimationStudio } from "./animation-studio";

export default async function AnimationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>← Projeto</Link>
      </p>
      <HealthBanner />
      <AnimationStudio projectId={projectId} />
    </main>
  );
}
