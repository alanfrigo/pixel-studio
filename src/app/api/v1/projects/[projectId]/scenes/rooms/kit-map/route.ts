import { api, json, readJson } from "@/server/http";
import { KitMapInput, mapKit } from "@/server/scenes/rooms";

/** Kit mapeado por chave → tileset piso ↔ parede do T1 e portas como props. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await mapKit(studio, params.projectId, await readJson(req, KitMapInput)), 201));
