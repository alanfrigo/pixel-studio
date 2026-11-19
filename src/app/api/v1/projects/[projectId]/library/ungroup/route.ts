import { api, json, readJson } from "@/server/http";
import { UngroupInput, ungroupDirections } from "@/server/library/library";

/** Separa um conjunto de direções em assets por direção (mesmos blobs). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, UngroupInput);
  return json(ungroupDirections(studio, params.projectId, body), 201);
});
