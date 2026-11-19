import { api, json } from "@/server/http";
import { previewRoom } from "@/server/scenes/rooms";

/** Sala montada: fundo, sombras e móveis ordenados pelo apoio, muretas por cima. */
export const GET = api<{ projectId: string; revisionId: string }>(async (_req, { params, studio }) => json(await previewRoom(studio, params.projectId, params.revisionId)));
