import { api, json, readJson } from "@/server/http";
import { CutoutInput, previewCutout } from "@/server/scenes/rooms";

/** Prévia do recorte: peça, sombra separada e a área antes oculta, com o contorno medido. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await previewCutout(studio, params.projectId, await readJson(req, CutoutInput))));
