import { api, json, readJson } from "@/server/http";
import { PublishMapInput, publishTilemap } from "@/server/world/maps";

/** Publica o mapa como revisão candidata: autotile recalculado no servidor e passagens exigidas conferidas. */
export const POST = api<{ projectId: string; assetId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, PublishMapInput);
  return json(publishTilemap(studio, params.projectId, params.assetId, body), 201);
});
