import { api, json } from "@/server/http";
import { worldCatalog } from "@/server/world/catalog";

/** Catálogo do mundo (T1): texturas, tilesets, objetos e mapas com revisões. */
export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => json(worldCatalog(studio, params.projectId)));
