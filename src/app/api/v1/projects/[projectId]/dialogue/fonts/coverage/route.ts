import { CoverageInput, fontCoverage } from "@/server/dialogue/fonts";
import { api, json, readJson } from "@/server/http";

/** Cobertura exigida pelos textos do projeto × glyphs inspecionados da fonte (ausentes listados). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(fontCoverage(studio, params.projectId, await readJson(req, CoverageInput))));
