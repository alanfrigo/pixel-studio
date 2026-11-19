import { ApplyReuseInput, applyReuse } from "@/server/equipment/service";
import { api, json, readJson } from "@/server/http";

/** Aplica o reaproveitamento de poses equivalentes sem gerar nada. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(applyReuse(studio, params.projectId, await readJson(req, ApplyReuseInput)), 201));
