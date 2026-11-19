import { RenderInput, renderFontText } from "@/server/dialogue/fonts";
import { api, json, readJson } from "@/server/http";

/** Texto de teste com o atlas + métricas: 1×, zoom inteiro, ausentes, largura e quebra (prévia, sem publicar). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await renderFontText(studio, params.projectId, await readJson(req, RenderInput))));
