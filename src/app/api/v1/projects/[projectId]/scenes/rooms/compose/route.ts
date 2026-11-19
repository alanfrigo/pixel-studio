import { api, json, readJson } from "@/server/http";
import { ComposeExtractedInput, composeExtracted } from "@/server/scenes/rooms";

/** Sala com o fundo reconstruído (E1) ou rocha revisada e o móvel como prop colocado pelo apoio. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json({ revision: composeExtracted(studio, params.projectId, await readJson(req, ComposeExtractedInput)) }, 201));
