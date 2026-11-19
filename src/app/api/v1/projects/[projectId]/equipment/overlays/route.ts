import { editOverlay, OverlayEditInput } from "@/server/equipment/overlays";
import { api, json, readJson } from "@/server/http";

/** Edição local da peça (célula vazia, lacuna, ordem, empunhaduras, uso de vista rígida): revisão candidata, mesmos blobs. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(editOverlay(studio, params.projectId, await readJson(req, OverlayEditInput)), 201));
