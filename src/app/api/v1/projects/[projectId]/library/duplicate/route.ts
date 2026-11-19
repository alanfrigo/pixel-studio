import { api, json, readJson } from "@/server/http";
import { DuplicateInput, duplicateAsset } from "@/server/library/library";

/** Duplica asset ou clipe: asset novo com os mesmos blobs; a origem não muda. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, DuplicateInput);
  return json(duplicateAsset(studio, params.projectId, body), 201);
});
