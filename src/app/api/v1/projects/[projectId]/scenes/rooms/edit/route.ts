import { api, json, readJson } from "@/server/http";
import { editRoom, RoomEditInput } from "@/server/scenes/rooms";

/** Nova revisão da sala: grade, portas, móveis (mover/reutilizar) e ligações com outras salas. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(editRoom(studio, params.projectId, await readJson(req, RoomEditInput)), 201));
