import type { TextValue } from "@/i18n/locales";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PythonOperation } from "@/contracts";
import { type BlobRecord, recordBlob } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { runPython } from "../python/bridge";
import type { BlobStore } from "../storage/blob-store";
import type { Clock } from "../util";
import { newId } from "../util";
import type { StudioConfig } from "../config";

/**
 * Processamento local do cartão S2 (`equipment.py`): pasta própria em
 * staging, saídas lidas em memória e pasta apagada. Determinístico pela
 * receita; nada sai para provedor.
 */

export interface EquipmentOutput {
  role: string;
  key?: string;
  sha256: string;
  rgbaSha256?: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export interface EquipmentRun {
  status: "ok" | "needs_review";
  report: Record<string, unknown>;
  warnings: TextValue[];
  outputs: EquipmentOutput[];
}

export interface EquipmentEnv {
  config: StudioConfig;
  blobs: BlobStore;
  signal?: AbortSignal;
}

export async function runEquipmentPython(
  env: EquipmentEnv,
  operation: Extract<PythonOperation, `equipment_${string}`>,
  inputs: { role: "layer" | "candidate"; sha256: string; bytes?: Uint8Array }[],
  recipe: Record<string, unknown>,
): Promise<EquipmentRun> {
  const dir = path.join(env.config.paths.staging, "equipment", newId("eqp"));
  try {
    await mkdir(path.join(dir, "in"), { recursive: true });
    const entries = [];
    for (const [ordinal, input] of inputs.entries()) {
      const rel = `in/${ordinal}-${input.role}.png`;
      await writeFile(path.join(dir, rel), input.bytes ?? (await env.blobs.read(input.sha256)));
      entries.push({ ordinal, role: input.role, sha256: input.sha256, relPath: rel });
    }
    const signal = env.signal ?? AbortSignal.timeout(env.config.pythonTimeoutMs);
    const result = await runPython(
      { protocolVersion: 1, jobId: "equipment", attemptId: "equipment", operation, inputs: entries, recipe: { version: 1, ...recipe } } as never,
      { python: env.config.python, workDir: dir, timeoutMs: env.config.pythonTimeoutMs, signal },
    );
    if (result.status === "error") throw new DomainFailure("validation_failed", result.message, { code: result.code, operation });
    const outputs: EquipmentOutput[] = [];
    for (const out of result.outputs) {
      outputs.push({
        role: out.role,
        ...(out.key ? { key: out.key } : {}),
        sha256: out.sha256,
        ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}),
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

/** Guarda a saída como blob (fora de transação); o registro no catálogo vem com a publicação. */
export async function storeOutput(blobs: BlobStore, out: EquipmentOutput): Promise<BlobRecord> {
  const stored = await blobs.putBytes(out.bytes);
  return { sha256: stored.sha256, bytes: stored.bytes, mime: "image/png", modality: "raster", metadata: { width: out.width, height: out.height, ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}) } };
}

export function registerBlob(db: Db, clock: Clock, blob: BlobRecord) {
  recordBlob(db, clock, blob);
  return blob;
}

export function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Índices de arquivo únicos por papel (a revisão guarda `(papel, idx)` único):
 * arquivos herdados da revisão de origem e novos se renumeram na ordem dada,
 * e a chave repetida fica com o arquivo mais novo.
 */
export function uniqueFiles<T extends { fileKey: string; role: string; idx: number }>(files: readonly T[]): T[] {
  const byKey = [...new Map(files.map((f) => [f.fileKey, f])).values()];
  const next = new Map<string, number>();
  return byKey.map((f) => {
    const idx = next.get(f.role) ?? 0;
    next.set(f.role, idx + 1);
    return { ...f, idx };
  });
}
