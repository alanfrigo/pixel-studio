import { z } from "zod";
import { Id } from "@/contracts";
import { reviewRevision } from "@/server/catalog/catalog";
import { api, json, readJson } from "@/server/http";

const ReviewBody = z.strictObject({
  revisionId: Id,
  decision: z.enum(["approve", "reject", "promote"]),
  reason: z.string().trim().max(1000).nullable().default(null),
  expectedActiveRevisionId: Id.nullable(),
});

export const POST = api<{ projectId: string; assetId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, ReviewBody);
  return json(reviewRevision(studio.db, studio.clock, { projectId: params.projectId, assetId: params.assetId, ...body }));
});
