import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ErrorCode, JobKind } from "@/contracts";
import { DomainFailure, toDomainError } from "../errors";
import { exportHandler } from "../export/exports";
import { iso, sleep } from "../util";
import { type HandlerContext, type JobHandler, makeCheckpoint, type WorkerDeps } from "./context";
import { generationHandler } from "./handlers/generation";
import { ingestHandler } from "./handlers/ingest";
import { localProcessHandler } from "./handlers/local-process";
import { CancelRequestedError, StaleAttemptError } from "./queue";

/**
 * Executor de jobs (02 §jobs longos). Um consumidor por processo no início;
 * concorrência remota por perfil fica para depois de medir.
 */

export const DEFAULT_HANDLERS: Partial<Record<JobKind, JobHandler>> = {
  ingest: ingestHandler,
  generation: generationHandler,
  export: exportHandler,
  local_process: localProcessHandler,
};

/** Falhas que valem nova tentativa automática (antes da aceitação remota ou locais idempotentes). */
const RETRYABLE: ErrorCode[] = ["provider_unavailable", "storage_failed", "internal"];

export interface RunnerOptions {
  workerId: string;
  heartbeatMs: number;
  handlers?: Partial<Record<JobKind, JobHandler>>;
}

export class JobRunner {
  private readonly handlers: Partial<Record<JobKind, JobHandler>>;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly options: RunnerOptions,
  ) {
    this.handlers = options.handlers ?? DEFAULT_HANDLERS;
  }

  /** Reserva e executa um job. `false` quando a fila está vazia. */
  async runOnce(): Promise<boolean> {
    const { queue, log } = this.deps;
    const claimed = queue.claim(this.options.workerId);
    if (!claimed) return false;
    const { job, attempt } = claimed;
    const controller = new AbortController();
    const workDir = path.join(this.deps.config.paths.staging, job.id, attempt.id);
    this.setCurrentJob(job.id);

    const timer = setInterval(() => {
      try {
        if (!queue.heartbeat(attempt)) controller.abort(new StaleAttemptError(attempt.id));
      } catch (err) {
        log("Falha ao renovar reserva", { jobId: job.id, error: String(err) });
      }
    }, this.options.heartbeatMs);

    const ctx: HandlerContext = {
      ...this.deps,
      job,
      attempt,
      signal: controller.signal,
      workDir,
      checkpoint: makeCheckpoint(queue, attempt, controller.signal),
    };

    log("Job reservado", { jobId: job.id, kind: job.kind, attempt: attempt.number, stage: job.stage });
    try {
      const handler = this.handlers[job.kind];
      if (!handler) throw new DomainFailure("capability_missing", `Nenhum executor para jobs do tipo ${job.kind}`);
      await mkdir(workDir, { recursive: true });
      await handler(ctx);
      const after = queue.get(job.id);
      if (after?.state === "running" && after.current_attempt_id === attempt.id) {
        throw new DomainFailure("internal", "O executor terminou sem concluir o job");
      }
    } catch (err) {
      this.handleError(ctx, err);
    } finally {
      clearInterval(timer);
      controller.abort(new StaleAttemptError(attempt.id));
      this.setCurrentJob(null);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const final = queue.get(job.id);
    log("Job processado", { jobId: job.id, state: final?.state, stage: final?.stage });
    return true;
  }

  private handleError(ctx: HandlerContext, err: unknown) {
    const { queue, log } = this.deps;
    try {
      if (err instanceof StaleAttemptError || (ctx.signal.aborted && ctx.signal.reason instanceof StaleAttemptError)) {
        // Outro worker assumiu ou o job foi encerrado: nada a publicar.
        log("Tentativa perdeu a posse; resultado descartado", { jobId: ctx.job.id, attempt: ctx.attempt.number });
        return;
      }
      if (err instanceof CancelRequestedError) {
        queue.acknowledgeCancel(ctx.attempt, err.note);
        return;
      }
      const failure = toDomainError(err);
      const retryAfterMs = typeof failure.details?.retryAfterMs === "number" ? failure.details.retryAfterMs : undefined;
      const state = queue.fail(ctx.attempt, failure, { retryable: RETRYABLE.includes(failure.code), ...(retryAfterMs ? { retryAfterMs } : {}) });
      log("Job falhou", { jobId: ctx.job.id, code: failure.code, message: failure.message, next: state });
    } catch (inner) {
      if (inner instanceof StaleAttemptError) return;
      log("Falha ao registrar erro do job", { jobId: ctx.job.id, error: String(inner) });
    }
  }

  private setCurrentJob(jobId: string | null) {
    this.deps.db.run("UPDATE worker_heartbeats SET current_job_id = :job WHERE worker_id = :w", { job: jobId, w: this.options.workerId });
  }

  registerHeartbeat(pid: number) {
    const now = iso(this.deps.clock.now());
    this.deps.db.run(
      `INSERT INTO worker_heartbeats (worker_id, pid, started_at, last_seen_at) VALUES (:w, :pid, :now, :now)
       ON CONFLICT (worker_id) DO UPDATE SET pid = :pid, last_seen_at = :now`,
      { w: this.options.workerId, pid, now },
    );
  }

  beat() {
    this.deps.db.run("UPDATE worker_heartbeats SET last_seen_at = :now WHERE worker_id = :w", {
      now: iso(this.deps.clock.now()),
      w: this.options.workerId,
    });
  }

  /** Laço principal: espera curta quando a fila está vazia. */
  async loop(stop: AbortSignal, idleMs = 500): Promise<void> {
    while (!stop.aborted) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (err) {
        this.deps.log("Erro no laço do worker", { error: String(err) });
      }
      if (!worked) await sleep(idleMs, stop).catch(() => undefined);
    }
  }
}

/**
 * Reconciliação na inicialização (02 §persistência, item 3): remove pastas de
 * staging de tentativas encerradas. Reservas vencidas são reassumidas pela
 * própria fila no próximo `claim`.
 */
export async function reconcileStaging(deps: WorkerDeps): Promise<number> {
  const root = deps.config.paths.staging;
  let removed = 0;
  const jobs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const jobDir of jobs) {
    if (!jobDir.isDirectory() || jobDir.name === "tmp") continue;
    const attempts = await readdir(path.join(root, jobDir.name), { withFileTypes: true }).catch(() => []);
    for (const attemptDir of attempts) {
      const live = deps.db.get<{ id: string }>(
        `SELECT a.id FROM job_attempts a JOIN jobs j ON j.current_attempt_id = a.id
         WHERE a.id = :id AND a.finished_at IS NULL AND j.state = 'running'`,
        { id: attemptDir.name },
      );
      if (!live) {
        await rm(path.join(root, jobDir.name, attemptDir.name), { recursive: true, force: true });
        removed++;
      }
    }
    await rm(path.join(root, jobDir.name)).catch(() => undefined);
  }
  return removed;
}
