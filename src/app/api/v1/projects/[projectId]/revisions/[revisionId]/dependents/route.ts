import { revisionDependents } from "@/server/catalog/catalog";
import { api, json } from "@/server/http";

export const GET = api<{ projectId: string; revisionId: string }>(async (_req, { params, studio }) =>
  json({ dependents: revisionDependents(studio.db, params.projectId, params.revisionId) }),
);
