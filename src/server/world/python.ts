import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PythonOperation } from "@/contracts";
import { type BlobRecord, recordBlob } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { runPython } from "../python/bridge";
import type { Studio } from "../studio";
import { newId } from "../util";

/**
 * Processamento local síncrono do mundo (validação de emendas, gabaritos,
 * losangos): roda numa pasta própria em staging, lê as saídas e apaga a
 * pasta. Nada é enviado a provedor; resultado determinístico pela receita.
 */

export interface WorldOutput {
  role: string;
  key?: string;
  sha256: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export interface WorldRun {
  status: "ok" | "needs_review";
  report: Record<string, unknown>;
  warnings: string[];
  outputs: WorldOutput[];
}

export async function runWorldPython(
  studio: Pick<Studio, "config" | "blobs">,
  operation: PythonOperation,
  inputs: { role: string; sha256: string }[],
  recipe: Record<string, unknown>,
): Promise<WorldRun> {
  const dir = path.join(studio.config.paths.staging, "world", newId("wrk"));
  try {
    await mkdir(path.join(dir, "in"), { recursive: true });
    const entries = [];
    for (const [ordinal, input] of inputs.entries()) {
      const rel = `in/${ordinal}-${input.role}.png`;
      await writeFile(path.join(dir, rel), await studio.blobs.read(input.sha256));
      entries.push({ ordinal, role: input.role, sha256: input.sha256, relPath: rel });
    }
    const result = await runPython(
      { protocolVersion: 1, jobId: "world", attemptId: "world", operation, inputs: entries, recipe: { version: 1, ...recipe } } as never,
      { python: studio.config.python, workDir: dir, timeoutMs: studio.config.pythonTimeoutMs, signal: AbortSignal.timeout(studio.config.pythonTimeoutMs) },
    );
    if (result.status === "error") throw new DomainFailure("validation_failed", result.message, { code: result.code, operation });
    const outputs: WorldOutput[] = [];
    for (const out of result.outputs) {
      outputs.push({
        role: out.role,
        ...(out.key ? { key: out.key } : {}),
        sha256: out.sha256,
        width: out.width ?? 0,
        height: out.height ?? 0,
        bytes: new Uint8Array(await readFile(out.absolutePath)),
      });
    }
    return { status: result.status, report: result.report, warnings: result.warnings, outputs };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function outputOf(run: WorldRun, role: string): WorldOutput {
  const out = run.outputs.find((o) => o.role === role);
  if (!out) throw new DomainFailure("internal", `Processador não devolveu a saída ${role}`);
  return out;
}

/** Guarda uma saída como blob raster registrado (para virar arquivo de revisão). */
export async function storeOutput(studio: Pick<Studio, "db" | "clock" | "blobs">, out: WorldOutput): Promise<BlobRecord> {
  const stored = await studio.blobs.putBytes(out.bytes);
  const record: BlobRecord = { sha256: stored.sha256, bytes: stored.bytes, mime: "image/png", modality: "raster", metadata: { width: out.width, height: out.height } };
  recordBlob(studio.db, studio.clock, record);
  return record;
}

/** Prévia pequena embutida na resposta JSON (não vira arquivo de projeto). */
export function dataUrl(out: WorldOutput): string {
  return `data:image/png;base64,${Buffer.from(out.bytes).toString("base64")}`;
}
