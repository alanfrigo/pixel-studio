import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest } from "@/domain/canonical-json";
import { type BlobRecord, recordBlob } from "../../catalog/catalog";
import { DomainFailure } from "../../errors";
import { pythonInfo, runPython } from "../../python/bridge";
import { iso } from "../../util";
import { type HandlerContext, JobRequests, type LocalProcessRequest } from "../context";

/**
 * Processamento local com cache por conteúdo (05 §repetição e recuperação).
 * Chave = operação + receita canônica + entradas ordenadas (papel, hash) +
 * versões do processador. Cache válido devolve os mesmos blobs sem rodar o
 * Python; o original nunca é alterado.
 */

export interface LocalOutput {
  index: number;
  role: string;
  key?: string;
  sha256: string;
  width?: number;
  height?: number;
  rgbaSha256?: string;
}

export interface LocalProcessResult {
  cacheKey: string;
  cacheHit: boolean;
  operation: string;
  status: "ok" | "needs_review";
  outputs: LocalOutput[];
  report: Record<string, unknown>;
  warnings: string[];
}

const processorCache = new Map<string, Promise<{ pipeline: string; pillow: string }>>();

function processorVersion(python: string) {
  let cached = processorCache.get(python);
  if (!cached) {
    cached = pythonInfo(python).then((info) => {
      if (!info.ok || !info.pipeline || !info.pillow) {
        processorCache.delete(python);
        throw new DomainFailure("internal", `Processador Python indisponível: ${info.error ?? "versão desconhecida"}`);
      }
      return { pipeline: info.pipeline, pillow: info.pillow };
    });
    processorCache.set(python, cached);
  }
  return cached;
}

export function localCacheKey(request: LocalProcessRequest, processor: { pipeline: string; pillow: string }): string {
  return canonicalDigest({
    operation: request.operation,
    recipe: request.recipe,
    inputs: request.inputs.map((input, ordinal) => ({ ordinal, role: input.role, sha256: input.sha256 })),
    processor: { protocol: 1, ...processor },
  });
}

interface CacheRow {
  status: "ok" | "needs_review";
  outputs_json: string;
  report_json: string;
  warnings_json: string;
}

export async function localProcessHandler(ctx: HandlerContext): Promise<void> {
  const request = JobRequests.local_process.parse(JSON.parse(ctx.job.request_json));
  const processor = await processorVersion(ctx.config.python);
  const cacheKey = localCacheKey(request, processor);

  const cached = ctx.db.get<CacheRow>("SELECT status, outputs_json, report_json, warnings_json FROM process_results WHERE cache_key = :k", { k: cacheKey });
  if (cached) {
    const outputs = JSON.parse(cached.outputs_json) as LocalOutput[];
    const present = await Promise.all(outputs.map((o) => ctx.blobs.verify(o.sha256)));
    if (present.every(Boolean)) {
      ctx.queue.succeed(ctx.attempt, (): LocalProcessResult => ({
        cacheKey,
        cacheHit: true,
        operation: request.operation,
        status: cached.status,
        outputs,
        report: JSON.parse(cached.report_json),
        warnings: JSON.parse(cached.warnings_json),
      }));
      return;
    }
  }

  ctx.queue.setStage(ctx.attempt, "process");
  const inDir = path.join(ctx.workDir, "in");
  await mkdir(inDir, { recursive: true });
  const inputs = [];
  for (const [ordinal, input] of request.inputs.entries()) {
    const relPath = `in/${ordinal}-${input.role}.png`;
    await writeFile(path.join(ctx.workDir, relPath), await ctx.blobs.read(input.sha256));
    inputs.push({ ordinal, role: input.role, sha256: input.sha256, relPath });
  }
  const result = await runPython(
    { protocolVersion: 1, jobId: ctx.job.id, attemptId: ctx.attempt.id, operation: request.operation, inputs, recipe: request.recipe } as never,
    { python: ctx.config.python, workDir: ctx.workDir, timeoutMs: ctx.config.pythonTimeoutMs, signal: ctx.signal },
  );
  ctx.checkpoint();
  if (result.status === "error") {
    // Geometria, máscara ou entrada inválida: o artista corrige a receita; repetir não ajuda.
    throw new DomainFailure("validation_failed", result.message, { code: result.code, operation: request.operation });
  }

  const outputs: LocalOutput[] = [];
  const records: BlobRecord[] = [];
  for (const [index, out] of result.outputs.entries()) {
    const stored = await ctx.blobs.putFile(out.absolutePath);
    records.push({
      sha256: stored.sha256,
      bytes: stored.bytes,
      mime: out.mime,
      modality: out.mime === "image/png" ? "raster" : "data",
      metadata: { width: out.width, height: out.height, rgbaSha256: out.rgbaSha256, producedBy: request.operation },
    });
    outputs.push({
      index,
      role: out.role,
      ...(out.key ? { key: out.key } : {}),
      sha256: stored.sha256,
      ...(out.width ? { width: out.width, height: out.height } : {}),
      ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}),
    });
  }

  ctx.queue.setStage(ctx.attempt, "publish");
  ctx.queue.succeed(ctx.attempt, (): LocalProcessResult => {
    for (const r of records) recordBlob(ctx.db, ctx.clock, r);
    ctx.db.run(
      `INSERT OR REPLACE INTO process_results (cache_key, operation, status, outputs_json, report_json, warnings_json, processor_json, created_at)
       VALUES (:k, :op, :status, :outputs, :report, :warnings, :processor, :now)`,
      {
        k: cacheKey,
        op: request.operation,
        status: result.status,
        outputs: JSON.stringify(outputs),
        report: JSON.stringify(result.report),
        warnings: JSON.stringify(result.warnings),
        processor: JSON.stringify(processor),
        now: iso(ctx.clock.now()),
      },
    );
    return { cacheKey, cacheHit: false, operation: request.operation, status: result.status, outputs, report: result.report, warnings: result.warnings };
  });
}
