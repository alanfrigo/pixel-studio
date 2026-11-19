import { api, json, readJson } from "@/server/http";
import { CopyMapInput, copyTilemap } from "@/server/world/maps";

/** Copia uma revisão do mapa (opcionalmente com outra revisão de tileset): traçado e colocações mantidos. */
export const POST = api<{ projectId: string; assetId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, CopyMapInput);
  return json(copyTilemap(studio, params.projectId, params.assetId, body), 201);
});
