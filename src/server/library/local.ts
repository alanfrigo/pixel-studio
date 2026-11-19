import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type BlobRecord, recordBlob } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { runPython, type VerifiedOutput } from "../python/bridge";
import type { Studio } from "../studio";
import { newId } from "../util";

/**
 * Processamento local síncrono ao pedido (biblioteca e prévias): espelho,
 * canvas, composição de quadros, inspeção de máscara. Nenhum provedor é
 * chamado; as saídas PNG viram blobs registrados, prontos para publicar.
 */

export interface LocalOutput extends VerifiedOutput {
  blob: BlobRecord;
}

export async function runLocal(studio: Studio, operation: string, inputs: { role: string; sha256: string }[], recipe: Record<string, unknown>) {
  const dir = path.join(studio.config.paths.staging, "library", newId("loc"));
  try {
    await mkdir(path.join(dir, "in"), { recursive: true });
    const entries = [];
    for (const [ordinal, input] of inputs.entries()) {
      const rel = `in/${ordinal}-${input.role}`;
      await writeFile(path.join(dir, rel), await studio.blobs.read(input.sha256));
      entries.push({ ordinal, role: input.role, sha256: input.sha256, relPath: rel });
    }
    const result = await runPython({ protocolVersion: 1, jobId: "local", attemptId: "local", operation, inputs: entries, recipe } as never, {
      python: studio.config.python,
      workDir: dir,
      timeoutMs: studio.config.pythonTimeoutMs,
      signal: AbortSignal.timeout(studio.config.pythonTimeoutMs),
    });
    if (result.status === "error") throw new DomainFailure(result.code === "geometry_mismatch" ? "validation_failed" : "validation_failed", result.message, { code: result.code });
    const outputs: LocalOutput[] = [];
    for (const out of result.outputs) {
      const stored = await studio.blobs.putFile(out.absolutePath);
      const blob: BlobRecord = { sha256: stored.sha256, bytes: stored.bytes, mime: "image/png", modality: "raster", metadata: { width: out.width, height: out.height, ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}) } };
      recordBlob(studio.db, studio.clock, blob);
      outputs.push({ ...out, blob });
    }
    return { report: result.report, warnings: result.warnings, outputs };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
