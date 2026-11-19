import { api, json } from "@/server/http";
import { inspectKit } from "@/server/scenes/rooms";

/** Folha do kit local (a imagem da sala) e a grade declarada, para mapear por chave. */
export const GET = api<{ projectId: string; revisionId: string }>(async (_req, { params, studio }) => json(inspectKit(studio, params.projectId, params.revisionId)));
