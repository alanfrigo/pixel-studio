import { z } from "zod";
import { api, json, readJson } from "@/server/http";
import { ComposeSceneInput, composeScene } from "@/server/scenes/scenes";
import { AssetTarget, ensureAsset } from "@/server/world/catalog";

const Body = z.strictObject({ target: AssetTarget, scene: ComposeSceneInput });

/** Cena em camadas com os planos aprovados, offsets, fatores e repetição; publica com o teste da câmera. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  const asset = ensureAsset(studio, params.projectId, body.target, "map", "scene");
  return json(await composeScene(studio, params.projectId, asset.id, body.scene), 201);
});
