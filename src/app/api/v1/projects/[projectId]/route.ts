import { getProject, getStyleRevision } from "@/server/catalog/catalog";
import { api, json } from "@/server/http";

export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => {
  const project = getProject(studio.db, params.projectId);
  const style = project.activeStyleRevisionId ? getStyleRevision(studio.db, project.id, project.activeStyleRevisionId) : null;
  return json({ project, style });
});
