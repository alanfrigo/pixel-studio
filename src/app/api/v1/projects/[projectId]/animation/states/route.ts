import { api, json, readJson } from "@/server/http";
import { SelectViewsInput, selectViews } from "@/server/animation/temporal-service";

/**
 * Aprovação parcial por vista: publica uma revisão candidata só com as vistas
 * escolhidas (mesmos blobs); as reprovadas ficam como lacunas explícitas. A
 * aprovação segue o fluxo de revisão (`/assets/{id}/reviews`).
 */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, SelectViewsInput);
  return json(selectViews(studio, params.projectId, body), 201);
});
