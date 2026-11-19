import { api, json, readJson } from "@/server/http";
import { annotateScene, SceneReviewInput } from "@/server/scenes/scenes";

/** Nova revisão da cena com pontos de apoio e escala revisada com o personagem sobreposto. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await annotateScene(studio, params.projectId, await readJson(req, SceneReviewInput)), 201));
