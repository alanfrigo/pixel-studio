import { getUpload } from "@/server/catalog/catalog";
import { api, json } from "@/server/http";

export const GET = api<{ projectId: string; uploadId: string }>(async (_req, { params, studio }) =>
  json({ upload: getUpload(studio.db, params.projectId, params.uploadId) }),
);
