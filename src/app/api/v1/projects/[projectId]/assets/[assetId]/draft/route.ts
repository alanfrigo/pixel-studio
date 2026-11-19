import { z } from "zod";
import { getDraft, saveDraft } from "@/server/catalog/catalog";
import { api, json, readJson } from "@/server/http";

export const GET = api<{ projectId: string; assetId: string }>(async (_req, { params, studio }) =>
  json({ draft: getDraft(studio.db, params.projectId, params.assetId) }),
);

export const PUT = api<{ projectId: string; assetId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, z.strictObject({ expectedVersion: z.number().int().nonnegative(), payload: z.unknown() }));
  return json({ draft: saveDraft(studio.db, studio.clock, { projectId: params.projectId, assetId: params.assetId, ...body }) });
});
