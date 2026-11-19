import { RunCoverageInput, runCoverage } from "@/server/equipment/service";
import { api, json, readJson } from "@/server/http";

/** Congela o plano e enfileira o job (a única ação paga do cartão); mesmo pedido = mesmo job. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const result = await runCoverage(studio, params.projectId, await readJson(req, RunCoverageInput));
  return json(result, 202, { location: `/api/v1/projects/${params.projectId}/jobs/${result.job.id}` });
});
