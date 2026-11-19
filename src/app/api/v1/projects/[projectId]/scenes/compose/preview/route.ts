import { api, json, readJson } from "@/server/http";
import { ComposeSceneInput, previewScene } from "@/server/scenes/scenes";

/** Câmera deslocando por duas larguras do fundo: tira de quadros, buracos e continuidade do chão. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await previewScene(studio, params.projectId, await readJson(req, ComposeSceneInput))));
