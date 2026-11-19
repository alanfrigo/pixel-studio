import { api, json, readJson } from "@/server/http";
import { ShiftLayerInput, shiftLayerForSeam } from "@/server/scenes/scenes";

/** Bancada da emenda do plano: etapa deslocada meia largura e máscara da faixa central para o inpainting (E1). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await shiftLayerForSeam(studio, params.projectId, await readJson(req, ShiftLayerInput)), 201));
