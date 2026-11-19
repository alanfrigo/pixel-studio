import { Readable } from "node:stream";
import { tx } from "@/i18n/locales";
import { DomainFailure } from "@/server/errors";
import { api } from "@/server/http";
import { jobOutput } from "@/server/services";

/** Bytes de uma saída de processamento local, para comparar antes/depois. */
export const GET = api<{ projectId: string; jobId: string; index: string }>(async (req, { params, studio }) => {
  const index = Number(params.index);
  if (!Number.isInteger(index) || index < 0) throw new DomainFailure("validation_failed", tx("Índice inválido", "Invalid index"));
  const output = jobOutput(studio, params.projectId, params.jobId, index);
  const etag = `"${output.sha256}"`;
  const headers = { etag, "cache-control": "private, max-age=31536000, immutable", "content-type": "image/png", "x-content-type-options": "nosniff" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Readable.toWeb(studio.blobs.stream(output.sha256)) as ReadableStream<Uint8Array>, { headers });
});
