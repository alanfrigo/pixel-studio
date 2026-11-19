import { api, json, readJson } from "@/server/http";
import { ComposeViewsInput, composeBaseViews } from "@/server/animation/service";

/** Publica a base com as vistas escolhidas por direção (aprovação segue o fluxo de revisão). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, ComposeViewsInput);
  return json(composeBaseViews(studio, params.projectId, body), 201);
});
