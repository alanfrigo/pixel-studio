import { api, json, readJson } from "@/server/http";
import { LinkInput, previewLink } from "@/server/scenes/rooms";

/** Duas salas pelas portas: mesma vista/escala, lados opostos e prévia lado a lado. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await previewLink(studio, params.projectId, await readJson(req, LinkInput))));
