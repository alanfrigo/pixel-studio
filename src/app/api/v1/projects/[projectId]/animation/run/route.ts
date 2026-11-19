import { api, json, readJson } from "@/server/http";
import { RunAnimationInput, runAnimation } from "@/server/animation/service";

/**
 * Monta o plano congelado e enfileira o job numa só chamada (atalho de um
 * clique). A chave de idempotência vem do digest do plano: repetir o mesmo
 * pedido devolve o mesmo job (202, `created: false`) e não cobra de novo.
 */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, RunAnimationInput);
  const result = runAnimation(studio, params.projectId, body);
  return json(result, 202, { location: `/api/v1/projects/${params.projectId}/jobs/${result.job.id}` });
});
