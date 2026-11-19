import { api, json } from "@/server/http";
import { uiCatalog } from "@/server/ui/screens";

/** Catálogo do kit de UI (cartão U3): componentes, templates, telas, imagens aprovadas e fundos. */
export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => json(uiCatalog(studio, params.projectId)));
