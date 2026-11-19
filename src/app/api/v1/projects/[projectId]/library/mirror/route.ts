import { api, json, readJson } from "@/server/http";
import { MirrorInput, mirrorExplicit } from "@/server/library/library";

/** Espelho explícito: derivação local autorizada, registrada como espelho; arte assimétrica exige confirmação. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, MirrorInput);
  return json(await mirrorExplicit(studio, params.projectId, body), 201);
});
