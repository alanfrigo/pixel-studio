import { api, json, readJson } from "@/server/http";
import { RoomToMapInput, roomToMap } from "@/server/scenes/rooms";

/** Remonta a sala num mapa editável do T1 (rascunho aberto no editor de mapas). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(roomToMap(studio, params.projectId, await readJson(req, RoomToMapInput)), 201));
