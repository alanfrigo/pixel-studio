import { z } from "zod";
import { Id } from "@/contracts";
import { api, json, readJson } from "@/server/http";
import { checkTilesetRevision } from "@/server/world/tilesets";

const Body = z.strictObject({ revisionId: Id, threshold: z.number().positive().max(20).optional() });

/** Emendas de todos os pares compatíveis / lacunas laterais / losangos e apoio, com prévias. Não grava nada. */
export const POST = api<{ projectId: string }>(
  async (req, { params, studio }) => {
    const body = await readJson(req, Body);
    return json(await checkTilesetRevision(studio, params.projectId, body.revisionId, body.threshold ? { threshold: body.threshold } : {}));
  });
