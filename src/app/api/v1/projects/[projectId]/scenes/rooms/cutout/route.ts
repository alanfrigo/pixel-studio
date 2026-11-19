import { api, json, readJson } from "@/server/http";
import { CutoutPublishInput, publishCutout } from "@/server/scenes/rooms";

/** Recorte local revisado: a peça vira prop (candidato) e a área exposta vira máscara para o inpainting (E1). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await publishCutout(studio, params.projectId, await readJson(req, CutoutPublishInput)), 201));
