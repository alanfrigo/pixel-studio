import type { CostAmount, JobKind, JobStage, JobState, RemoteSubmission } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { type Clock, iso, newId, parseJson } from "../util";

/**
 * Fila persistida no SQLite (02 §jobs longos, 02a §semântica da fila).
 *
 * - Chave de idempotência + digest do pedido congelado: repetir o envio
 *   idêntico devolve o mesmo job; mesma chave com outro digest é conflito.
 * - Reserva com `BEGIN IMMEDIATE`: grava tentativa, dono e prazo; o worker
 *   renova o prazo enquanto executa. Reserva vencida volta para a fila.
 * - Fencing: só a tentativa atual escreve. Toda escrita confere, na mesma
 *   transação, que a tentativa ainda é a corrente — publicação tardia de uma
 *   tentativa antiga ou cancelada é impossível.
 * - Partes registram o estado do envio remoto ANTES da chamada, o ID remoto
 *   quando aceito e a resposta bruta assim que chega.
 */

export interface QueueOptions {
  leaseMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  defaultMaxAttempts: number;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  leaseMs: 30_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  defaultMaxAttempts: 3,
};

export interface JobRow {
  id: string;
  project_id: string;
  kind: JobKind;
  state: JobState;
  stage: JobStage;
  idempotency_key: string;
  request_digest: string;
  request_json: string;
  current_attempt_id: string | null;
  attempt_count: number;
  max_attempts: number;
  next_run_at: string;
  cancel_requested_at: string | null;
  error_json: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface PartRow {
  job_id: string;
  part_key: string;
  ordinal: number;
  remote_state: RemoteSubmission;
  remote_id: string | null;
  submit_count: number;
  raw_blob_sha256: string | null;
  raw_mime: string | null;
  processed_json: string | null;
  cost_json: string | null;
  error_json: string | null;
  updated_at: string;
}

/** Posse de uma tentativa reservada por um worker. */
export interface Attempt {
  id: string;
  jobId: string;
  number: number;
  workerId: string;
}

export interface Claimed {
  job: JobRow;
  attempt: Attempt;
}

/** A tentativa perdeu a posse (reserva vencida e reassumida, job encerrado). */
export class StaleAttemptError extends Error {
  constructor(attemptId: string) {
    super(`Tentativa ${attemptId} não é mais a corrente`);
    this.name = "StaleAttemptError";
  }
}

/** O artista pediu cancelamento; a tentativa deve parar e reconhecer. */
export class CancelRequestedError extends Error {
  constructor(
    jobId: string,
    /** Situação do custo remoto registrada no resultado do job cancelado. */
    readonly note?: Record<string, unknown>,
  ) {
    super(`Cancelamento solicitado para ${jobId}`);
    this.name = "CancelRequestedError";
  }
}

export type PartPatch = Partial<
  Pick<PartRow, "remote_state" | "remote_id" | "raw_blob_sha256" | "raw_mime" | "processed_json" | "cost_json" | "error_json">
>;

const ACTIVE_STATES: JobState[] = ["queued", "running", "needs_attention"];

export class JobQueue {
  readonly options: QueueOptions;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    options: Partial<QueueOptions> = {},
  ) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };
  }

  private now(): string {
    return iso(this.clock.now());
  }

  private after(ms: number): string {
    return iso(new Date(this.clock.now().getTime() + ms));
  }

  // -------------------------------------------------------------------------
  // Envio e consulta
  // -------------------------------------------------------------------------

  enqueue(input: {
    projectId: string;
    kind: JobKind;
    request: unknown;
    idempotencyKey: string;
    maxAttempts?: number;
    /** Efeitos na mesma transação (ex.: vincular o upload ao job). */
    apply?: (jobId: string) => void;
  }): { job: JobRow; created: boolean } {
    const digest = canonicalDigest({ kind: input.kind, request: input.request });
    return this.db.transaction(() => {
      const existing = this.db.get<JobRow>("SELECT * FROM jobs WHERE project_id = :p AND idempotency_key = :k", {
        p: input.projectId,
        k: input.idempotencyKey,
      });
      if (existing) {
        if (existing.request_digest !== digest) {
          throw new DomainFailure(
            "idempotency_conflict",
            "A mesma chave de idempotência já foi usada com outro pedido",
            { idempotencyKey: input.idempotencyKey },
            existing.id,
          );
        }
        return { job: existing, created: false };
      }
      const id = newId("job");
      const now = this.now();
      this.db.run(
        `INSERT INTO jobs (id, project_id, kind, state, stage, idempotency_key, request_digest, request_json,
           attempt_count, max_attempts, next_run_at, created_at, updated_at)
         VALUES (:id, :p, :kind, 'queued', 'prepare', :key, :digest, :request, 0, :max, :now, :now, :now)`,
        {
          id,
          p: input.projectId,
          kind: input.kind,
          key: input.idempotencyKey,
          digest,
          request: JSON.stringify(input.request),
          max: input.maxAttempts ?? this.options.defaultMaxAttempts,
          now,
        },
      );
      input.apply?.(id);
      return { job: this.mustGet(id), created: true };
    });
  }

  get(jobId: string): JobRow | undefined {
    return this.db.get<JobRow>("SELECT * FROM jobs WHERE id = :id", { id: jobId });
  }

  getForProject(projectId: string, jobId: string): JobRow {
    const job = this.db.get<JobRow>("SELECT * FROM jobs WHERE id = :id AND project_id = :p", { id: jobId, p: projectId });
    if (!job) throw new DomainFailure("not_found", "Job não encontrado neste projeto");
    return job;
  }

  private mustGet(jobId: string): JobRow {
    const job = this.get(jobId);
    if (!job) throw new DomainFailure("not_found", `Job ${jobId} não encontrado`);
    return job;
  }

  list(projectId: string, opts: { active?: boolean; limit?: number } = {}): JobRow[] {
    const states = opts.active ? ACTIVE_STATES : ["queued", "running", "needs_attention", "succeeded", "failed", "cancelled"];
    return this.db.all<JobRow>(
      `SELECT * FROM jobs WHERE project_id = :p AND state IN (${states.map((s) => `'${s}'`).join(",")})
       ORDER BY created_at DESC LIMIT :limit`,
      { p: projectId, limit: opts.limit ?? 50 },
    );
  }

  parts(jobId: string): PartRow[] {
    return this.db.all<PartRow>("SELECT * FROM job_parts WHERE job_id = :id ORDER BY ordinal", { id: jobId });
  }

  // -------------------------------------------------------------------------
  // Reserva e posse
  // -------------------------------------------------------------------------

  /** Reassume reservas vencidas e reserva o próximo job pronto. */
  claim(workerId: string): Claimed | null {
    return this.db.transaction(() => {
      const now = this.now();
      this.recoverExpired(now);
      const job = this.db.get<JobRow>(
        "SELECT * FROM jobs WHERE state = 'queued' AND next_run_at <= :now ORDER BY next_run_at, created_at LIMIT 1",
        { now },
      );
      if (!job) return null;
      const attempt: Attempt = { id: newId("att"), jobId: job.id, number: job.attempt_count + 1, workerId };
      this.db.run(
        `INSERT INTO job_attempts (id, job_id, number, worker_id, lease_expires_at, started_at)
         VALUES (:id, :job, :n, :w, :lease, :now)`,
        { id: attempt.id, job: job.id, n: attempt.number, w: workerId, lease: this.after(this.options.leaseMs), now },
      );
      this.db.run(
        `UPDATE jobs SET state = 'running', current_attempt_id = :a, attempt_count = attempt_count + 1, updated_at = :now
         WHERE id = :id`,
        { a: attempt.id, id: job.id, now },
      );
      return { job: this.mustGet(job.id), attempt };
    });
  }

  private recoverExpired(now: string) {
    const expired = this.db.all<JobRow & { attempt_id: string }>(
      `SELECT j.*, a.id AS attempt_id FROM jobs j JOIN job_attempts a ON a.id = j.current_attempt_id
       WHERE j.state = 'running' AND a.finished_at IS NULL AND a.lease_expires_at <= :now`,
      { now },
    );
    for (const job of expired) {
      this.db.run("UPDATE job_attempts SET outcome = 'lease_expired', finished_at = :now WHERE id = :id", { id: job.attempt_id, now });
      if (job.cancel_requested_at) {
        this.setTerminal(job.id, "cancelled", now);
      } else if (job.attempt_count >= job.max_attempts) {
        // Worker caiu repetidamente neste job: exige decisão explícita em vez de repetir para sempre.
        this.db.run(
          `UPDATE jobs SET state = 'needs_attention', error_json = :err, updated_at = :now WHERE id = :id`,
          {
            id: job.id,
            now,
            err: JSON.stringify({
              code: "internal",
              message: `A execução foi interrompida ${job.attempt_count} vezes; confira o diagnóstico e tente de novo`,
            }),
          },
        );
      } else {
        // Retoma pelo estágio persistido: partes já salvas não são refeitas.
        this.db.run("UPDATE jobs SET state = 'queued', next_run_at = :now, updated_at = :now WHERE id = :id", { id: job.id, now });
      }
    }
  }

  /** Renova o prazo; `false` = posse perdida (a tentativa deve parar sem publicar). */
  heartbeat(attempt: Attempt): boolean {
    const r = this.db.run(
      `UPDATE job_attempts SET lease_expires_at = :lease
       WHERE id = :id AND finished_at IS NULL AND id = (SELECT current_attempt_id FROM jobs WHERE id = :job AND state = 'running')`,
      { id: attempt.id, job: attempt.jobId, lease: this.after(this.options.leaseMs) },
    );
    return r.changes === 1;
  }

  isCancelRequested(jobId: string): boolean {
    return this.get(jobId)?.cancel_requested_at != null;
  }

  /** Confere a posse dentro da transação corrente. */
  assertCurrent(attempt: Attempt, opts: { allowCancelRequested?: boolean } = {}): JobRow {
    const job = this.db.get<JobRow & { attempt_finished_at: string | null }>(
      `SELECT j.*, a.finished_at AS attempt_finished_at FROM jobs j JOIN job_attempts a ON a.id = :a WHERE j.id = :job`,
      { a: attempt.id, job: attempt.jobId },
    );
    if (!job || job.current_attempt_id !== attempt.id || job.state !== "running" || job.attempt_finished_at) {
      throw new StaleAttemptError(attempt.id);
    }
    if (job.cancel_requested_at && !opts.allowCancelRequested) throw new CancelRequestedError(attempt.jobId);
    return job;
  }

  /** Executa `fn` numa transação somente se a tentativa ainda for a corrente. */
  fenced<T>(attempt: Attempt, fn: (job: JobRow) => T, opts: { allowCancelRequested?: boolean } = {}): T {
    return this.db.transaction(() => fn(this.assertCurrent(attempt, opts)));
  }

  setStage(attempt: Attempt, stage: JobStage): void {
    this.fenced(attempt, () => {
      this.db.run("UPDATE jobs SET stage = :stage, updated_at = :now WHERE id = :id", { stage, id: attempt.jobId, now: this.now() });
    });
  }

  // -------------------------------------------------------------------------
  // Partes (unidades com estado de envio remoto)
  // -------------------------------------------------------------------------

  ensureParts(attempt: Attempt, parts: { partKey: string }[]): PartRow[] {
    return this.fenced(attempt, () => {
      parts.forEach((p, ordinal) =>
        this.db.run(
          `INSERT OR IGNORE INTO job_parts (job_id, part_key, ordinal, remote_state, updated_at)
           VALUES (:job, :key, :ordinal, 'not_sent', :now)`,
          { job: attempt.jobId, key: p.partKey, ordinal, now: this.now() },
        ),
      );
      return this.parts(attempt.jobId);
    });
  }

  updatePart(attempt: Attempt, partKey: string, patch: PartPatch, opts: { countSubmission?: boolean } = {}): PartRow {
    return this.fenced(
      attempt,
      () => {
        const sets = Object.keys(patch).map((k) => `${k} = :${k}`);
        if (opts.countSubmission) sets.push("submit_count = submit_count + 1");
        sets.push("updated_at = :now");
        const r = this.db.run(`UPDATE job_parts SET ${sets.join(", ")} WHERE job_id = :job AND part_key = :key`, {
          ...(patch as Record<string, string | null>),
          now: this.now(),
          job: attempt.jobId,
          key: partKey,
        });
        if (r.changes !== 1) throw new Error(`Parte ${partKey} inexistente em ${attempt.jobId}`);
        return this.db.get<PartRow>("SELECT * FROM job_parts WHERE job_id = :job AND part_key = :key", { job: attempt.jobId, key: partKey })!;
      },
      { allowCancelRequested: true },
    );
  }

  // -------------------------------------------------------------------------
  // Encerramento da tentativa
  // -------------------------------------------------------------------------

  private closeAttempt(attempt: Attempt, outcome: string, error: DomainFailure | null) {
    this.db.run("UPDATE job_attempts SET outcome = :o, finished_at = :now, error_json = :err WHERE id = :id", {
      id: attempt.id,
      o: outcome,
      now: this.now(),
      err: error ? JSON.stringify(error.toJSON()) : null,
    });
  }

  private setTerminal(jobId: string, state: "succeeded" | "failed" | "cancelled", now: string) {
    this.db.run("UPDATE jobs SET state = :state, finished_at = :now, updated_at = :now WHERE id = :id", { state, id: jobId, now });
  }

  /**
   * Publica e conclui na MESMA transação, só se a tentativa for a corrente.
   * O valor devolvido por `publish` vira o resultado do job.
   */
  succeed<T>(attempt: Attempt, publish: () => T): T {
    return this.fenced(attempt, () => {
      const result = publish();
      this.closeAttempt(attempt, "succeeded", null);
      this.db.run("UPDATE jobs SET result_json = :r, error_json = NULL WHERE id = :id", { r: JSON.stringify(result ?? null), id: attempt.jobId });
      this.setTerminal(attempt.jobId, "succeeded", this.now());
      return result;
    });
  }

  fail(attempt: Attempt, error: DomainFailure, opts: { retryable: boolean; retryAfterMs?: number; apply?: () => void }): JobState {
    return this.fenced(
      attempt,
      (job) => {
        opts.apply?.();
        const now = this.now();
        const errJson = JSON.stringify(error.toJSON());
        if (job.cancel_requested_at) {
          this.closeAttempt(attempt, "cancelled", error);
          this.db.run("UPDATE jobs SET error_json = :e WHERE id = :id", { e: errJson, id: job.id });
          this.setTerminal(job.id, "cancelled", now);
          return "cancelled";
        }
        if (opts.retryable && job.attempt_count < job.max_attempts) {
          const backoff = Math.min(this.options.backoffBaseMs * 2 ** (job.attempt_count - 1), this.options.backoffMaxMs);
          const wait = Math.max(backoff, opts.retryAfterMs ?? 0);
          this.closeAttempt(attempt, "retry", error);
          this.db.run(
            "UPDATE jobs SET state = 'queued', next_run_at = :next, error_json = :e, updated_at = :now WHERE id = :id",
            { next: this.after(wait), e: errJson, now, id: job.id },
          );
          return "queued";
        }
        this.closeAttempt(attempt, "failed", error);
        this.db.run("UPDATE jobs SET error_json = :e WHERE id = :id", { e: errJson, id: job.id });
        this.setTerminal(job.id, "failed", now);
        return "failed";
      },
      { allowCancelRequested: true },
    );
  }

  /** Resultado remoto ambíguo: para e pede decisão do artista. */
  needsAttention(attempt: Attempt, error: DomainFailure): void {
    this.fenced(
      attempt,
      () => {
        this.closeAttempt(attempt, "needs_attention", error);
        this.db.run("UPDATE jobs SET state = 'needs_attention', error_json = :e, updated_at = :now WHERE id = :id", {
          e: JSON.stringify(error.toJSON()),
          now: this.now(),
          id: attempt.jobId,
        });
      },
      { allowCancelRequested: true },
    );
  }

  /** O worker reconhece o cancelamento pedido. */
  acknowledgeCancel(attempt: Attempt, note?: Record<string, unknown>): void {
    this.fenced(
      attempt,
      () => {
        this.closeAttempt(attempt, "cancelled", null);
        if (note) this.db.run("UPDATE jobs SET result_json = :r WHERE id = :id", { r: JSON.stringify(note), id: attempt.jobId });
        this.setTerminal(attempt.jobId, "cancelled", this.now());
      },
      { allowCancelRequested: true },
    );
  }

  // -------------------------------------------------------------------------
  // Ações do artista
  // -------------------------------------------------------------------------

  requestCancel(projectId: string, jobId: string): JobRow {
    return this.db.transaction(() => {
      const job = this.getForProject(projectId, jobId);
      const now = this.now();
      if (job.state === "queued" || job.state === "needs_attention") {
        this.setTerminal(job.id, "cancelled", now);
      } else if (job.state === "running" && !job.cancel_requested_at) {
        this.db.run("UPDATE jobs SET cancel_requested_at = :now, updated_at = :now WHERE id = :id", { now, id: job.id });
      }
      return this.mustGet(job.id);
    });
  }

  /**
   * Nova tentativa explícita. Partes com envio incerto só voltam a ser enviadas
   * se o artista reconhecer a possível nova cobrança.
   */
  retry(projectId: string, jobId: string, opts: { acknowledgePossibleCharge?: boolean } = {}): JobRow {
    return this.db.transaction(() => {
      const job = this.getForProject(projectId, jobId);
      if (job.state !== "failed" && job.state !== "needs_attention") {
        throw new DomainFailure("validation_failed", `Job em estado ${job.state} não pode ser retomado`, undefined, job.id);
      }
      const risky = this.parts(job.id).filter((p) => p.remote_state === "uncertain" || p.remote_state === "sending");
      if (risky.length > 0 && !opts.acknowledgePossibleCharge) {
        throw new DomainFailure(
          "submission_uncertain",
          "Há envios cujo resultado e cobrança são desconhecidos; confirme que aceita uma possível nova cobrança",
          { parts: risky.map((p) => p.part_key) },
          job.id,
        );
      }
      const now = this.now();
      this.db.run(
        `UPDATE job_parts SET remote_state = 'not_sent', remote_id = NULL, updated_at = :now
         WHERE job_id = :id AND remote_state IN ('uncertain', 'sending', 'rejected')`,
        { id: job.id, now },
      );
      this.db.run(
        `UPDATE jobs SET state = 'queued', next_run_at = :now, max_attempts = attempt_count + :extra,
           cancel_requested_at = NULL, finished_at = NULL, updated_at = :now WHERE id = :id`,
        { id: job.id, now, extra: this.options.defaultMaxAttempts },
      );
      return this.mustGet(job.id);
    });
  }
}

// ---------------------------------------------------------------------------
// Visão para a API e a interface
// ---------------------------------------------------------------------------

export interface JobView {
  id: string;
  projectId: string;
  kind: JobKind;
  state: JobState;
  stage: JobStage;
  attemptCount: number;
  maxAttempts: number;
  cancelRequested: boolean;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: unknown;
  result: unknown;
  /** Pedido congelado (plano, receita local ou upload). */
  request: unknown;
  parts: {
    partKey: string;
    remoteState: RemoteSubmission;
    remoteId: string | null;
    submitCount: number;
    rawSaved: boolean;
    processed: boolean;
    cost: CostAmount | null;
  }[];
  summary: {
    /** Chamadas efetivamente despachadas ao provedor. */
    submissions: number;
    /** Custo conhecido por unidade; nunca convertido entre unidades. */
    cost: CostAmount[];
    uncertainParts: number;
  };
  actions: { canCancel: boolean; canRetry: boolean; retryMayCharge: boolean };
}

export function toJobView(job: JobRow, parts: PartRow[]): JobView {
  const costs = new Map<string, number>();
  for (const p of parts) {
    const c = parseJson<CostAmount>(p.cost_json);
    if (c) costs.set(c.unit, (costs.get(c.unit) ?? 0) + c.amount);
  }
  const uncertain = parts.filter((p) => p.remote_state === "uncertain" || p.remote_state === "sending").length;
  return {
    id: job.id,
    projectId: job.project_id,
    kind: job.kind,
    state: job.state,
    stage: job.stage,
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
    cancelRequested: job.cancel_requested_at !== null,
    nextRunAt: job.next_run_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    finishedAt: job.finished_at,
    error: parseJson(job.error_json),
    result: parseJson(job.result_json),
    request: parseJson(job.request_json),
    parts: parts.map((p) => ({
      partKey: p.part_key,
      remoteState: p.remote_state,
      remoteId: p.remote_id,
      submitCount: p.submit_count,
      rawSaved: p.raw_blob_sha256 !== null,
      processed: p.processed_json !== null,
      cost: parseJson<CostAmount>(p.cost_json),
    })),
    summary: {
      submissions: parts.reduce((n, p) => n + p.submit_count, 0),
      cost: [...costs].map(([unit, amount]) => ({ unit, amount })),
      uncertainParts: uncertain,
    },
    actions: {
      canCancel: ACTIVE_STATES.includes(job.state) && job.cancel_requested_at === null,
      canRetry: job.state === "failed" || job.state === "needs_attention",
      retryMayCharge: uncertain > 0,
    },
  };
}
