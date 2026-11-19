import { PublishLoadoutInput, publishLoadout } from "@/server/equipment/loadouts";
import { api, json, readJson } from "@/server/http";

/** Publica o conjunto como revisão candidata (snapshot + folha achatada sob demanda); aprovação no fluxo de revisão. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await publishLoadout(studio, params.projectId, await readJson(req, PublishLoadoutInput)), 201));
