import { HealthBanner } from "@/app/client/health-banner";
import { AnimationStudio } from "./animation-studio";

export default async function AnimationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <>
      <HealthBanner />
      <AnimationStudio projectId={projectId} />
    </>
  );
}
