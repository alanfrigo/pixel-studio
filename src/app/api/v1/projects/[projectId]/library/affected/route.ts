import { api, json } from "@/server/http";
import { affectedByFrames } from "@/server/library/affected";
import { tx } from "@/i18n/locales";
import { DomainFailure } from "@/server/errors";

/** Eventos e peças (coberturas, vistas rígidas) que referenciam `(clipRevisionId, frameId)`. */
export const GET = api<{ projectId: string }>(async (req, { params, studio }) => {
  const url = new URL(req.url);
  const clipRevisionId = url.searchParams.get("clipRevisionId");
  const frameIds = url.searchParams.getAll("frameId");
  if (!clipRevisionId || frameIds.length === 0) throw new DomainFailure("validation_failed", tx("Informe clipRevisionId e ao menos um frameId", "Provide clipRevisionId and at least one frameId"));
  return json(affectedByFrames(studio.db, params.projectId, clipRevisionId, frameIds));
});
