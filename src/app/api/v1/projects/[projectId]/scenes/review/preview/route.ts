import { api, json, readJson } from "@/server/http";
import { overlaySceneCharacter, SceneReviewInput } from "@/server/scenes/scenes";

/** Personagem em escala pousado nos pontos de apoio (prévia, sem publicar). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await overlaySceneCharacter(studio, params.projectId, await readJson(req, SceneReviewInput))));
