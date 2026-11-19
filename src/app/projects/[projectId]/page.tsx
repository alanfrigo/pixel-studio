import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { serverMessages } from "@/i18n/server";
import { HealthBanner } from "@/app/client/health-banner";
import { Workspace } from "./workspace";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const c = await serverMessages(commonMessages);
  return (
    <main>
      <p className="small">
        <Link href="/">{c.backToProjects}</Link>
      </p>
      <HealthBanner />
      <Workspace projectId={projectId} />
    </main>
  );
}
