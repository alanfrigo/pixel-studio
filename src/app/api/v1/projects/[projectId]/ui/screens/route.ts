import { api, json, readJson } from "@/server/http";
import { SaveScreenInput, saveScreen } from "@/server/ui/screens";

/** Salva uma revisão candidata da tela, conferida nas resoluções testadas. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(saveScreen(studio, params.projectId, await readJson(req, SaveScreenInput)), 201));
