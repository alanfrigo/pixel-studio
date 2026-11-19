import { ShareClipInput, shareClip } from "@/server/equipment/overlays";
import { api, json, readJson } from "@/server/http";

/** Vínculo explícito de clipe compartilhado com outra postura (revisão candidata do clipe, a revisar). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json({ revision: shareClip(studio, params.projectId, await readJson(req, ShareClipInput)) }, 201));
