import { api, json, readJson } from "@/server/http";
import { RemovePartInput, removeParts } from "@/server/library/library";

/** Exclui direção, quadro ou parte publicando revisão nova; as anteriores ficam (pacotes antigos resolvem). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, RemovePartInput);
  return json(removeParts(studio, params.projectId, body), 201);
});
