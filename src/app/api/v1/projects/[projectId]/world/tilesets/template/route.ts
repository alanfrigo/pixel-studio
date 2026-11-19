import { z } from "zod";
import { api, json, readJson } from "@/server/http";
import { AssetTarget, ensureAsset } from "@/server/world/catalog";
import { buildTilesetTemplate, TilesetTemplateInput } from "@/server/world/tilesets";

const Body = z.strictObject({ target: AssetTarget, template: TilesetTemplateInput });

/** Gabarito local (16 máscaras, tabela lateral ou peças isométricas) a partir de texturas aprovadas; não é geração nativa. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  const asset = ensureAsset(studio, params.projectId, body.target, "tileset", body.template.kind);
  return json(await buildTilesetTemplate(studio, params.projectId, asset.id, body.template), 201);
});
