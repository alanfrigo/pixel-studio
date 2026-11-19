import { z } from "zod";
import { type AssetFamily, Id } from "@/contracts";
import { tx } from "@/i18n/locales";
import { createAsset, getAsset, listAssets, listRevisions } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import type { Studio } from "../studio";

/**
 * Catálogo do mundo (T1) para a página `/world`: texturas, tilesets, objetos
 * e mapas com suas revisões, numa só leitura.
 */

export function worldCatalog(studio: Studio, projectId: string) {
  const of = (family: AssetFamily, kinds?: string[]) =>
    listAssets(studio.db, projectId, { family })
      .filter((a) => !kinds || kinds.includes(a.kind))
      .map((asset) => ({ asset, revisions: listRevisions(studio.db, projectId, asset.id) }));
  return {
    textures: of("texture"),
    tilesets: of("tileset"),
    objects: of("map", ["object"]),
    maps: of("map", ["tilemap"]).map(({ asset, revisions }) => ({
      asset,
      // O mapa pode ter só rascunho; as revisões vêm sem o payload (grande) — o editor abre pelo endpoint próprio.
      revisions: revisions.map((r) => ({ id: r.id, number: r.number, status: r.status, createdAt: r.createdAt, technicalReport: r.technicalReport })),
    })),
  };
}

/** Destino da publicação: asset existente (`assetId`) ou novo (`name`), conferindo família e tipo. */
export const AssetTarget = z.union([z.strictObject({ assetId: Id }), z.strictObject({ name: z.string().trim().min(1).max(120) })]);

export function ensureAsset(studio: Studio, projectId: string, target: z.infer<typeof AssetTarget>, family: AssetFamily, kind: string) {
  if ("assetId" in target) {
    const asset = getAsset(studio.db, projectId, target.assetId);
    if (asset.family !== family || asset.kind !== kind) throw new DomainFailure("validation_failed", tx(`O asset é ${asset.family}/${asset.kind}; esperado ${family}/${kind}`, `The asset is ${asset.family}/${asset.kind}; expected ${family}/${kind}`));
    return asset;
  }
  return createAsset(studio.db, studio.clock, { projectId, family, kind, name: target.name });
}
