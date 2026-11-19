import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { tx } from "@/i18n/locales";
import { DomainFailure } from "@/server/errors";
import { exportFilePath, getExport } from "@/server/export/exports";
import { api } from "@/server/http";

export const GET = api<{ projectId: string; exportId: string }>(async (_req, { params, studio }) => {
  const view = getExport(studio.db, params.projectId, params.exportId);
  if (view.state !== "ready") throw new DomainFailure("not_found", tx("Pacote ainda não está pronto", "Package is not ready yet"));
  const file = exportFilePath(studio.config.paths.exports, view);
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, {
    headers: {
      "content-type": "application/zip",
      "content-length": String(view.bytes),
      "content-disposition": `attachment; filename="${view.fileName}"`,
      etag: `"${view.zipSha256}"`,
      "x-content-type-options": "nosniff",
    },
  });
});
