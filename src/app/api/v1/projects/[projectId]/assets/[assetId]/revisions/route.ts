import { listRevisions } from "@/server/catalog/catalog";
import { api, json, readJson } from "@/server/http";
import { publishFromSource, PublishRevisionInput } from "@/server/services";

export const GET = api<{ projectId: string; assetId: string }>(async (_req, { params, studio }) =>
  json({ revisions: listRevisions(studio.db, params.projectId, params.assetId) }),
);

/** Publica candidata a partir de um upload (ícone de item) ou de uma saída de processamento local. */
export const POST = api<{ projectId: string; assetId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, PublishRevisionInput);
  return json({ revision: publishFromSource(studio, params.projectId, params.assetId, body) }, 201);
});
