import { CompareExpressionsInput, compareExpressions } from "@/server/dialogue/portraits";
import { api, json, readJson } from "@/server/http";

/** Duas expressões lado a lado: pixels alterados fora da boca e compatibilidade dos visemes (prévia, sem publicar). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await compareExpressions(studio, params.projectId, await readJson(req, CompareExpressionsInput))));
