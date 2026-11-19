import { ExpandCellInput, expandCell } from "@/server/equipment/overlays";
import { api, json, readJson } from "@/server/http";

/** Amplia a célula de clipes (camadas, sockets, pivô e coberturas pela mesma margem): revisões candidatas. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(expandCell(studio, params.projectId, await readJson(req, ExpandCellInput)), 201));
