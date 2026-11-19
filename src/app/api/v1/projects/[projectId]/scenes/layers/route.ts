import { z } from "zod";
import { api, json, readJson } from "@/server/http";
import { PublishLayerInput, publishSceneLayer } from "@/server/scenes/scenes";
import { AssetTarget, ensureAsset } from "@/server/world/catalog";

const Body = z.strictObject({ target: AssetTarget, layer: PublishLayerInput });

/** Plano de paralaxe importado ou derivado (máscara revisada); a repetição é validada localmente. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  const asset = ensureAsset(studio, params.projectId, body.target, "map", "scene_layer");
  return json(await publishSceneLayer(studio, params.projectId, asset.id, body.layer), 201);
});
