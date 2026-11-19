import { ExtractInput, extractCoverage } from "@/server/equipment/extract";
import { api, json, readJson } from "@/server/http";

/** Extrai a cobertura de um clipe vestido ou de imagens importadas (local, zero chamadas pagas). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await extractCoverage(studio, params.projectId, await readJson(req, ExtractInput)), 201));
