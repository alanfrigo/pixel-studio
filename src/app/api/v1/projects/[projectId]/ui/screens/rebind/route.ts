import { api, json, readJson } from "@/server/http";
import { RebindScreenInput, rebindScreen } from "@/server/ui/screens";

/** Nova revisão da tela com as instâncias religadas à revisão escolhida do componente. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(rebindScreen(studio, params.projectId, await readJson(req, RebindScreenInput)), 201));
