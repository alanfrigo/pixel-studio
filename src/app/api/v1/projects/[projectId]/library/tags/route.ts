import { api, json, readJson } from "@/server/http";
import { assetsWithTag, listTags, SetTagsInput, setAssetTags } from "@/server/library/library";

/** Etiquetas da biblioteca: metadado editorial, nunca cria revisão. `?tag=` lista os assets com a etiqueta. */
export const GET = api<{ projectId: string }>(async (req, { params, studio }) => {
  const tag = new URL(req.url).searchParams.get("tag");
  return json(tag ? { tag, assetIds: assetsWithTag(studio, params.projectId, tag) } : { tags: listTags(studio, params.projectId) });
});

export const PUT = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, SetTagsInput);
  return json(setAssetTags(studio, params.projectId, body));
});
