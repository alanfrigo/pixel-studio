import { PublishSpeechInput, publishSpeech } from "@/server/dialogue/speech";
import { api, json, readJson } from "@/server/http";

/** Publica a fala como revisão candidata que cita a expressão aprovada (zero jobs de geração). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await publishSpeech(studio, params.projectId, await readJson(req, PublishSpeechInput)), 201));
