import { api, json, readJson } from "@/server/http";
import { applyLocalState, LocalStateInput } from "@/server/ui/components";

/** Estado por transformação local explícita (rampa, realce, deslocamento), sem IA. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await applyLocalState(studio, params.projectId, await readJson(req, LocalStateInput)), 201));
