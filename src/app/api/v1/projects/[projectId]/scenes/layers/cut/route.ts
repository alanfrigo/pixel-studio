import { api, json, readJson } from "@/server/http";
import { CutLayerInput, cutSceneLayer } from "@/server/scenes/scenes";

/** Derivação local revisada: recorta um plano de uma imagem plana e registra a área para o inpainting (E1). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await cutSceneLayer(studio, params.projectId, await readJson(req, CutLayerInput))));
