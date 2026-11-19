import { PortraitReviewInput, reviewPortrait } from "@/server/dialogue/portraits";
import { api, json, readJson } from "@/server/http";

/** Âncora facial e regiões do rosto/boca revisadas: nova revisão candidata (a imagem não muda). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(reviewPortrait(studio, params.projectId, await readJson(req, PortraitReviewInput)), 201));
