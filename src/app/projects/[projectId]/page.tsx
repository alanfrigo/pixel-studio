import { HealthBanner } from "@/app/client/health-banner";
import { EXPORT_PROFILES } from "@/server/export/profiles";
import { Workspace } from "./workspace";

export default async function ProjectPage({ params, searchParams }: PageProps<"/projects/[projectId]">) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const view = query.view === "library" || query.view === "activity" || query.view === "export" || query.view === "style" ? query.view : "create";
  const templateId = typeof query.template === "string" ? query.template : undefined;
  return (
    <>
      <HealthBanner />
      <Workspace key={projectId} projectId={projectId} view={view} templateId={templateId} exportProfiles={view === "export" ? Object.values(EXPORT_PROFILES) : []} />
    </>
  );
}
