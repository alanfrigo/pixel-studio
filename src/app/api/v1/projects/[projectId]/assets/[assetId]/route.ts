import { assetLineage, getAsset, listRevisions } from "@/server/catalog/catalog";
import { api, json } from "@/server/http";

export const GET = api<{ projectId: string; assetId: string }>(async (_req, { params, studio }) =>
  json({
    asset: getAsset(studio.db, params.projectId, params.assetId),
    revisions: listRevisions(studio.db, params.projectId, params.assetId),
    lineage: assetLineage(studio.db, params.projectId, params.assetId),
  }),
);
