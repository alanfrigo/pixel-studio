import { api, json, readJson } from "@/server/http";
import { RetimeInput, retimeClipRevision } from "@/server/animation/service";

/** Ajuste local de durações: revisão nova do clipe com os mesmos quadros, sem gerar pixels. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, RetimeInput);
  const result = retimeClipRevision(studio, params.projectId, body);
  return json(result, result.unchanged ? 200 : 201);
});
