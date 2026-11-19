import type { AssetFamily } from "@/contracts";
import { getDraft, listAssets, listRevisions } from "../catalog/catalog";
import type { Studio } from "../studio";

/**
 * Catálogo da página `/scenes` (cartão T2): cenas, planos, salas, props,
 * bases de personagem (escala e prévia isométrica), mapas isométricos do T1
 * e tilesets por cantos (destino do kit), numa só leitura.
 */
export function scenesCatalog(studio: Studio, projectId: string) {
  const of = (family: AssetFamily, kinds: string[]) =>
    listAssets(studio.db, projectId, { family })
      .filter((a) => kinds.includes(a.kind))
      .map((asset) => ({ asset, revisions: listRevisions(studio.db, projectId, asset.id) }));
  const isoMaps = listAssets(studio.db, projectId, { family: "map" })
    .filter((a) => a.kind === "tilemap")
    .map((asset) => {
      const draft = getDraft(studio.db, projectId, asset.id);
      const latest = listRevisions(studio.db, projectId, asset.id)[0];
      const payload = (draft?.payload ?? latest?.payload) as { projection?: string } | undefined;
      return { asset, projection: payload?.projection ?? null };
    })
    .filter((m) => m.projection === "isometric")
    .map((m) => m.asset);
  return {
    scenes: of("map", ["scene"]),
    layers: of("map", ["scene_layer"]),
    rooms: of("map", ["room"]),
    objects: of("map", ["object"]),
    characters: of("character", ["base"]),
    cornerTilesets: of("tileset", ["corner"]).map(({ asset, revisions }) => ({ asset, revisions: revisions.map((r) => ({ id: r.id, number: r.number, status: r.status, technicalReport: r.technicalReport })) })),
    isoMaps,
  };
}
