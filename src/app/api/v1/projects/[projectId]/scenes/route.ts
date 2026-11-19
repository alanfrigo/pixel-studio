import { api, json } from "@/server/http";
import { scenesCatalog } from "@/server/scenes/catalog";

/** Catálogo de cenas, planos, salas, props, personagens e mapas isométricos (cartão T2). */
export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => json(scenesCatalog(studio, params.projectId)));
