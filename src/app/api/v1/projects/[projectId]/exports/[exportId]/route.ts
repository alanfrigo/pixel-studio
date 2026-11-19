import { getExport } from "@/server/export/exports";
import { api, json } from "@/server/http";

export const GET = api<{ projectId: string; exportId: string }>(async (_req, { params, studio }) =>
  json({ export: getExport(studio.db, params.projectId, params.exportId) }),
);
