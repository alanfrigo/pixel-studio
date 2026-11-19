import { equipmentOverview } from "@/server/equipment/service";
import { api, json } from "@/server/http";

/** Visão da página de equipamentos: rigs, clipes, peças, conjuntos, perfis com rota honesta e jobs recentes. */
export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => json(equipmentOverview(studio, params.projectId)));
