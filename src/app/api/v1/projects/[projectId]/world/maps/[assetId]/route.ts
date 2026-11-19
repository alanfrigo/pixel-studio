import { api, json } from "@/server/http";
import { openTilemap } from "@/server/world/maps";

/** Abre o rascunho (padrão) ou `?revision=` com o contexto para desenhar: tileset, objetos e catálogo. */
export const GET = api<{ projectId: string; assetId: string }>(async (req, { params, studio }) => {
  const revisionId = new URL(req.url).searchParams.get("revision") ?? undefined;
  return json(openTilemap(studio, params.projectId, params.assetId, revisionId ? { revisionId } : {}));
});
