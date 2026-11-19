import { SwapInput, swapItem } from "@/server/equipment/loadouts";
import { api, json, readJson } from "@/server/http";

/** Troca de item em uma operação: retira quem disputa os slots e publica a revisão nova do conjunto. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await swapItem(studio, params.projectId, await readJson(req, SwapInput)), 201));
