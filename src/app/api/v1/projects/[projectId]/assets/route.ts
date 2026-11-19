import { AssetFamily } from "@/contracts";
import { createAsset, listAssets } from "@/server/catalog/catalog";
import { api, json, readJson } from "@/server/http";
import { CreateAssetInput } from "@/server/services";

export const GET = api<{ projectId: string }>(async (req, { params, studio }) => {
  const family = new URL(req.url).searchParams.get("family");
  const parsed = family ? AssetFamily.safeParse(family) : null;
  return json({ assets: listAssets(studio.db, params.projectId, parsed?.success ? { family: parsed.data } : {}) });
});

export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, CreateAssetInput);
  return json({ asset: createAsset(studio.db, studio.clock, { projectId: params.projectId, ...body }) }, 201);
});
