import { api, json, readJson } from "@/server/http";
import { checkTexture, TextureCheckInput } from "@/server/world/textures";

/** Bancada de repetição: emenda por eixo, mosaico 3×3 (1× e ampliado com linhas) e deslocamento cíclico. Não grava nada. */
export const POST = api<{ projectId: string }>(
  async (req, { params, studio }) => json(await checkTexture(studio, params.projectId, await readJson(req, TextureCheckInput))));
