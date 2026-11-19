import { z } from "zod";
import { GenerationPlan, Id, NonNegInt, PythonInputRole, Sha256Hex } from "@/contracts";
import type { StudioConfig } from "../config";
import type { Db } from "../db/connection";
import type { ProviderRegistry } from "../providers/registry";
import type { BlobStore } from "../storage/blob-store";
import type { Clock } from "../util";
import { type Attempt, CancelRequestedError, type JobQueue, type JobRow } from "./queue";

/** Operações locais expostas pela oficina (ingestão tem fluxo próprio). */
export const LocalOperation = z.enum([
  "slice_grid",
  "remove_background_flood",
  "crop_to_content",
  "make_thumbnail",
  "apply_palette",
  "compose_layers",
  "composite_protected",
]);

/** Origem de uma entrada local: upload normalizado, arquivo de revisão ou saída de outro job. */
export const LocalInputRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upload"), uploadId: Id }),
  z.strictObject({ kind: z.literal("revision"), revisionId: Id, fileKey: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal("job_output"), jobId: Id, outputIndex: NonNegInt }),
]);
export type LocalInputRef = z.infer<typeof LocalInputRef>;

/** Pedidos aceitos por tipo de job (validados no envio e de novo no worker). */
export const JobRequests = {
  ingest: z.strictObject({ uploadId: Id }),
  generation: z.strictObject({
    plan: GenerationPlan,
    /** Digest do plano exibido ao artista; mudança de entrada exige recalcular. */
    planDigest: Sha256Hex,
    targetAssetId: Id,
  }),
  /** Receita congelada: entradas resolvidas para hashes no envio. */
  local_process: z.strictObject({
    operation: LocalOperation,
    inputs: z.array(z.strictObject({ role: PythonInputRole, ref: LocalInputRef, sha256: Sha256Hex })).min(1).max(32),
    recipe: z.record(z.string(), z.unknown()),
  }),
} as const;

export type IngestRequest = z.infer<typeof JobRequests.ingest>;
export type GenerationRequest = z.infer<typeof JobRequests.generation>;
export type LocalProcessRequest = z.infer<typeof JobRequests.local_process>;

export interface WorkerDeps {
  db: Db;
  clock: Clock;
  queue: JobQueue;
  blobs: BlobStore;
  config: StudioConfig;
  providers: ProviderRegistry;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

export interface HandlerContext extends WorkerDeps {
  job: JobRow;
  attempt: Attempt;
  /** Abortado quando a posse da tentativa é perdida. */
  signal: AbortSignal;
  /** Pasta exclusiva da tentativa em `staging/<job>/<attempt>/`. */
  workDir: string;
  /** Lança se a posse foi perdida ou se o artista pediu cancelamento. */
  checkpoint(): void;
}

export type JobHandler = (ctx: HandlerContext) => Promise<void>;

export function makeCheckpoint(queue: JobQueue, attempt: Attempt, signal: AbortSignal) {
  return () => {
    if (signal.aborted) throw signal.reason;
    if (queue.isCancelRequested(attempt.jobId)) throw new CancelRequestedError(attempt.jobId);
  };
}
