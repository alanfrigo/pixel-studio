import { api, json, readJson } from "@/server/http";
import { RunAnimationInput, runAnimationChecked } from "@/server/animation/service";

/**
 * Monta o plano congelado e enfileira o job numa só chamada (atalho de um
 * clique e operações do S3). A chave de idempotência vem do digest do plano:
 * repetir o mesmo pedido devolve o mesmo job (202, `created: false`) e não
 * cobra de novo. Correção com máscara vazia é recusada antes de enfileirar.
 */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, RunAnimationInput);
  const result = await runAnimationChecked(studio, params.projectId, body);
  return json(result, 202, { location: `/api/v1/projects/${params.projectId}/jobs/${result.job.id}` });
});
