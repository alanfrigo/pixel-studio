import { z } from "zod";
import { api, json, readJson } from "@/server/http";
import { AssetTarget, ensureAsset } from "@/server/world/catalog";
import { PublishTextureInput, publishTexture } from "@/server/world/textures";

const Body = z.strictObject({ target: AssetTarget, texture: PublishTextureInput });

/** Publica textura (importada ou derivada) como candidata, com o relatório de emendas; eixo reprovado não fica repetível. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  const asset = ensureAsset(studio, params.projectId, body.target, "texture", "material");
  return json(await publishTexture(studio, params.projectId, asset.id, body.texture), 201);
});
