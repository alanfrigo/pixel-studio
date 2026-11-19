import { listUploads } from "@/server/catalog/catalog";
import { DomainFailure } from "@/server/errors";
import { api, HttpError, json } from "@/server/http";
import { ingestUpload } from "@/server/services";

export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => json({ uploads: listUploads(studio.db, params.projectId) }));

export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > studio.config.maxUploadBytes + 64 * 1024) throw new HttpError(413, "payload_too_large", "Arquivo maior que o limite");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new DomainFailure("validation_failed", "Envie o arquivo no campo multipart 'file'");
  const result = await ingestUpload(studio, params.projectId, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  return json(result, 202, { location: `/api/v1/projects/${params.projectId}/jobs/${result.job.id}` });
});
