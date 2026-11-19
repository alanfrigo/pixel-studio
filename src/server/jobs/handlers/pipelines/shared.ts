import { tx } from "@/i18n/locales";
import type { TextValue } from "@/i18n/locales";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type BlobRecord, getBlob } from "../../../catalog/catalog";
import type { Db } from "../../../db/connection";
import { DomainFailure } from "../../../errors";
import { runPython } from "../../../python/bridge";
import type { HandlerContext } from "../../context";

/**
 * Peças comuns aos pipelines de geração (ícone, inpainting, animação, mundo):
 * resultado processado, linhas de resultado por parte, ponte Python e blobs.
 */

export interface ProcessedPart {
  normalizedSha256: string;
  width: number;
  height: number;
  rgbaSha256?: string;
  partialAlpha?: boolean;
  receivedSize?: [number, number];
  /** Relatório da redução para a escala lógica, quando houve. */
  fit?: Record<string, unknown> | null;
  /** Etapas locais aplicadas (grade, remoção da cor-chave, ajuste), com seus relatórios. */
  steps?: Record<string, unknown>[];
  warnings: TextValue[];
  /** Inpainting: candidato na grade da fonte (antes da proteção) e relatório da composição. */
  candidateSha256?: string;
  composite?: Record<string, unknown>;
  /** Dados próprios de cada operação (frames, tiles, guias...), lidos pelo `publish` do pipeline. */
  details?: Record<string, unknown>;
}

export interface PartResultRow {
  part_key: string;
  idx: number;
  blob_sha256: string;
  mime: string;
  processed_json: string | null;
}

export function partResults(ctx: HandlerContext, partKey: string): PartResultRow[] {
  return ctx.db.all<PartResultRow>("SELECT * FROM job_part_results WHERE job_id = :job AND part_key = :part ORDER BY idx", {
    job: ctx.job.id,
    part: partKey,
  });
}

/** O mínimo que o pipeline local precisa; o handler passa o contexto do job, scripts passam o seu. */
export interface PipelineEnv {
  blobs: HandlerContext["blobs"];
  config: HandlerContext["config"];
  jobId: string;
  attemptId: string;
  signal: AbortSignal;
}

export async function python(env: PipelineEnv, dir: string, operation: "ingest_inspect" | "fit_logical" | "unzoom" | "remove_background_flood", sha256: string, recipe: Record<string, unknown>) {
  await mkdir(path.join(dir, "in"), { recursive: true });
  await writeFile(path.join(dir, "in", "source"), await env.blobs.read(sha256));
  return runPython(
    { protocolVersion: 1, jobId: env.jobId, attemptId: env.attemptId, operation, inputs: [{ ordinal: 0, role: "source", sha256, relPath: "in/source" }], recipe } as never,
    { python: env.config.python, workDir: dir, timeoutMs: env.config.pythonTimeoutMs, signal: env.signal },
  );
}

/** Ambiente do pipeline a partir do contexto do job. */
export function envOf(ctx: HandlerContext): PipelineEnv {
  return { blobs: ctx.blobs, config: ctx.config, jobId: ctx.job.id, attemptId: ctx.attempt.id, signal: ctx.signal };
}

/** Operação Python com várias entradas por papel (fonte, candidato, máscara...). */
export async function pythonWith(env: PipelineEnv, dir: string, operation: string, inputs: { role: string; sha256: string }[], recipe: Record<string, unknown>) {
  await mkdir(path.join(dir, "in"), { recursive: true });
  const entries = [];
  for (const [ordinal, input] of inputs.entries()) {
    const rel = `in/${ordinal}-${input.role}`;
    await writeFile(path.join(dir, rel), await env.blobs.read(input.sha256));
    entries.push({ ordinal, role: input.role, sha256: input.sha256, relPath: rel });
  }
  return runPython(
    { protocolVersion: 1, jobId: env.jobId, attemptId: env.attemptId, operation, inputs: entries, recipe } as never,
    { python: env.config.python, workDir: dir, timeoutMs: env.config.pythonTimeoutMs, signal: env.signal },
  );
}

export function mustBlob(db: Db, sha256: string): BlobRecord {
  const blob = getBlob(db, sha256);
  if (!blob) throw new DomainFailure("internal", tx(`Blob ${sha256} sem registro`, `Blob ${sha256} has no record`));
  return blob;
}
