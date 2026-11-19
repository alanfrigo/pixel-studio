import { dialogueCatalog } from "@/server/dialogue/catalog";
import { api, json } from "@/server/http";

/** Catálogo de retratos, expressões, falas e fontes (cartão D1). */
export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => json(dialogueCatalog(studio, params.projectId)));
