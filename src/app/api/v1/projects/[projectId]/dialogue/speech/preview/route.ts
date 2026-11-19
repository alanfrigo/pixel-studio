import { previewSpeech, SpeechInput } from "@/server/dialogue/speech";
import { api, json, readJson } from "@/server/http";

/** Plano temporal de uma fala pela regra de letras (local, sem geração, sem publicar). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(previewSpeech(studio, params.projectId, await readJson(req, SpeechInput))));
