import { api, json, readJson } from "@/server/http";
import { SaveMotionInput, saveMotion } from "@/server/animation/service";

/** Publica a sequência do editor de esqueleto como revisão candidata de movimento (sem chamada paga). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, SaveMotionInput);
  return json(saveMotion(studio, params.projectId, body), 201);
});
