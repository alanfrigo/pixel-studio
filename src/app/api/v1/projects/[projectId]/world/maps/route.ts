import { api, json, readJson } from "@/server/http";
import { CreateMapInput, createTilemap } from "@/server/world/maps";

/** Cria um mapa (rascunho versionado) a partir de uma revisão de tileset. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, CreateMapInput);
  return json(createTilemap(studio, params.projectId, body), 201);
});
