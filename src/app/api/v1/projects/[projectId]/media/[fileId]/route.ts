import { Readable } from "node:stream";
import { resolveMedia } from "@/server/catalog/catalog";
import { api } from "@/server/http";

/** Bytes de um vínculo autorizado do projeto, com cache pelo hash do conteúdo. */
export const GET = api<{ projectId: string; fileId: string }>(async (req, { params, studio }) => {
  const variant = new URL(req.url).searchParams.get("variant") === "original" ? "original" : "default";
  const media = resolveMedia(studio.db, params.projectId, params.fileId, variant);
  const etag = `"${media.sha256}"`;
  const headers = {
    etag,
    "cache-control": "private, max-age=31536000, immutable",
    "content-type": media.mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const stream = Readable.toWeb(studio.blobs.stream(media.sha256)) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 200, headers });
});
