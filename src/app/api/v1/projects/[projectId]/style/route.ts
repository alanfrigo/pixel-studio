import { z } from "zod";
import { Id } from "@/contracts";
import { publishStyleRevision } from "@/server/catalog/catalog";
import { api, json, readJson } from "@/server/http";

const Body = z.strictObject({ payload: z.unknown(), expectedActiveStyleRevisionId: Id.nullable() });

/** Salva o guia de estilo como nova revisão ativa (assets antigos mantêm a revisão com que foram feitos). */
export const PUT = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  const style = publishStyleRevision(studio.db, studio.clock, params.projectId, { payload: body.payload, expectedActiveStyleRevisionId: body.expectedActiveStyleRevisionId });
  return json({ style });
});
