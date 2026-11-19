import { api, json, readJson } from "@/server/http";
import { checkSceneLayer, LayerCheckInput } from "@/server/scenes/scenes";

/** Bancada do plano: continuidade da repetição e linha do chão, sem publicar. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await checkSceneLayer(studio, params.projectId, await readJson(req, LayerCheckInput))));
