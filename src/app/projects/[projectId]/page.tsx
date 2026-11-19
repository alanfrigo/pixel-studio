import Link from "next/link";
import { HealthBanner } from "@/app/client/health-banner";
import { Workspace } from "./workspace";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <main>
      <p className="small">
        <Link href="/">← Projetos</Link>
      </p>
      <HealthBanner />
      <Workspace projectId={projectId} />
    </main>
  );
}
