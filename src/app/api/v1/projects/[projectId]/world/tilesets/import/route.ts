import { z } from "zod";
import { api, json, readJson } from "@/server/http";
import { AssetTarget, ensureAsset } from "@/server/world/catalog";
import { importTileset, TilesetImportInput } from "@/server/world/tilesets";

const Body = z.strictObject({ target: AssetTarget, kind: z.enum(["corner", "sidescroller", "isometric"]), atlas: TilesetImportInput });

/** Importa um atlas com o layout declarado (chaves, máscaras/configurações ou peças); identificado como importação. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  const asset = ensureAsset(studio, params.projectId, body.target, "tileset", body.kind);
  return json(await importTileset(studio, params.projectId, asset.id, body.atlas), 201);
});
