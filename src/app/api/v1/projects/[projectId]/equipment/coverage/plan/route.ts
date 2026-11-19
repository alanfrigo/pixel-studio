import { buildOverlayCoveragePlan, OverlayCoveragePlanInput } from "@/server/equipment/plans";
import { api, json, readJson } from "@/server/http";

/** Prévia do plano "Criar peça": matriz de cobertura, tiras, rota honesta e custo antes de gerar. Nada é enviado. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await buildOverlayCoveragePlan(studio, params.projectId, await readJson(req, OverlayCoveragePlanInput))));
