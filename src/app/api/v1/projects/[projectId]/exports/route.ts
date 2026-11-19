import { CreateExportInput, listExports, requestExport } from "@/server/export/exports";
import { api, json, readJson } from "@/server/http";

export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => json({ exports: listExports(studio.db, params.projectId) }));

/** Valida o fecho (sem custo) e enfileira; a mesma seleção devolve a mesma exportação. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, CreateExportInput);
  const key = req.headers.get("idempotency-key")?.trim() || undefined;
  const result = requestExport(studio, params.projectId, body, key);
  return json(result, 202, { location: `/api/v1/projects/${params.projectId}/exports/${result.export.id}` });
});
