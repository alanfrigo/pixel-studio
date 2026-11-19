import { RetargetSpeechInput, retargetSpeech } from "@/server/dialogue/speech";
import { api, json, readJson } from "@/server/http";

/** Mesma fala com outra expressão compatível: nova revisão, a anterior continua intacta. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await retargetSpeech(studio, params.projectId, await readJson(req, RetargetSpeechInput)), 201));
