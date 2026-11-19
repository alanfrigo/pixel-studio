import { ImportAtlasInput, importFontAtlas } from "@/server/dialogue/fonts";
import { api, json, readJson } from "@/server/http";

/** Importa um atlas existente pela grade declarada (caminho distinto da geração). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await importFontAtlas(studio, params.projectId, await readJson(req, ImportAtlasInput)), 201));
