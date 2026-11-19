import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type BlobRecord, getUpload, markUploadReady, markUploadRejected } from "../../catalog/catalog";
import { DomainFailure } from "../../errors";
import { inspectAudio, inspectFont } from "../../media/inspect";
import { runPython } from "../../python/bridge";
import { readZip, ZipError } from "@/lib/zip";
import { commitPortableImport, preparePortableImport } from "../../export/import";
import { type HandlerContext, JobRequests } from "../context";

/**
 * Ingestão de upload por modalidade. O original fica intacto; raster ganha um
 * derivado de trabalho sRGB RGBA normalizado pelo Python.
 */
export async function ingestHandler(ctx: HandlerContext): Promise<void> {
  const { uploadId } = JobRequests.ingest.parse(JSON.parse(ctx.job.request_json));
  const upload = getUpload(ctx.db, ctx.job.project_id, uploadId);
  ctx.queue.setStage(ctx.attempt, "process");
  const bytes = await ctx.blobs.read(upload.sha256);
  const format = String(upload.metadata?.format ?? "");

  const reject = (code: string, message: string) =>
    ctx.queue.fail(ctx.attempt, new DomainFailure("validation_failed", message, { code, uploadId }), {
      retryable: false,
      apply: () => markUploadRejected(ctx.db, uploadId, { code, message }),
    });

  if (upload.modality === "raster") {
    const inDir = path.join(ctx.workDir, "in");
    await mkdir(inDir, { recursive: true });
    await writeFile(path.join(inDir, "source"), bytes);
    const result = await runPython(
      {
        protocolVersion: 1,
        jobId: ctx.job.id,
        attemptId: ctx.attempt.id,
        operation: "ingest_inspect",
        inputs: [{ ordinal: 0, role: "source", sha256: upload.sha256, relPath: "in/source" }],
        recipe: { version: 1, limits: ctx.config.rasterLimits },
      },
      { python: ctx.config.python, workDir: ctx.workDir, timeoutMs: ctx.config.pythonTimeoutMs, signal: ctx.signal },
    );
    ctx.checkpoint();
    if (result.status === "error") {
      reject(result.code, result.message);
      return;
    }
    const out = result.outputs.find((o) => o.role === "normalized");
    if (!out) throw new DomainFailure("internal", "Processador não devolveu o derivado normalizado");
    const stored = await ctx.blobs.putFile(out.absolutePath);
    const normalized: BlobRecord = {
      sha256: stored.sha256,
      bytes: stored.bytes,
      mime: "image/png",
      modality: "raster",
      metadata: { width: out.width, height: out.height, rgbaSha256: out.rgbaSha256 },
    };
    ctx.queue.setStage(ctx.attempt, "publish");
    ctx.queue.succeed(ctx.attempt, () => {
      markUploadReady(ctx.db, ctx.clock, uploadId, normalized, {
        ...upload.metadata,
        ...result.report,
        width: out.width,
        height: out.height,
        warnings: result.warnings,
      });
      return { uploadId, normalizedSha256: stored.sha256, reviewNeeded: result.status === "needs_review" };
    });
    return;
  }

  if (upload.modality === "audio") {
    const audio = inspectAudio(bytes, format);
    if (!audio) {
      reject("decode_failed", "Áudio ilegível ou formato ainda não suportado (esta versão lê WAV PCM)");
      return;
    }
    ctx.queue.succeed(ctx.attempt, () => {
      markUploadReady(ctx.db, ctx.clock, uploadId, null, { ...upload.metadata, ...audio });
      return { uploadId };
    });
    return;
  }

  if (upload.modality === "font") {
    const font = inspectFont(bytes);
    if (!font) {
      reject("decode_failed", "Fonte ilegível: tabelas maxp/head ausentes");
      return;
    }
    ctx.queue.succeed(ctx.attempt, () => {
      markUploadReady(ctx.db, ctx.clock, uploadId, null, { ...upload.metadata, ...font });
      return { uploadId };
    });
    return;
  }

  if (upload.modality === "data" && format === "zip") {
    // Reabrir pacote portátil: valida tudo antes de gravar; revisões entram como candidatas.
    let prepared;
    try {
      prepared = await preparePortableImport(ctx, readZip(bytes));
    } catch (err) {
      if (err instanceof ZipError || (err instanceof DomainFailure && err.code === "validation_failed")) {
        reject("invalid_package", err.message);
        return;
      }
      throw err;
    }
    ctx.checkpoint();
    ctx.queue.setStage(ctx.attempt, "publish");
    ctx.queue.succeed(ctx.attempt, () => {
      const result = commitPortableImport(ctx, ctx.job.project_id, prepared);
      markUploadReady(ctx.db, ctx.clock, uploadId, null, {
        ...upload.metadata,
        package: { projectId: prepared.manifest.projectId, profile: prepared.manifest.profile, revisions: Object.keys(result.revisionMap).length, assets: result.assetIds.length },
      });
      return { uploadId, ...result };
    });
    return;
  }

  reject("unsupported_input", `Modalidade ${upload.modality} sem ingestão nesta versão`);
}
