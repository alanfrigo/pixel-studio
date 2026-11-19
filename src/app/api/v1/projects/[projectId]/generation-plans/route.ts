import { api, json, readJson } from "@/server/http";
import { buildPlan, PlanRequest } from "@/server/plan-builders";

/** Prévia validada: plano congelado, capacidades, partes, estimativa e destino. Não cobra nada. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, PlanRequest);
  return json(await buildPlan(studio, params.projectId, body));
});
