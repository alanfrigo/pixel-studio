import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAsset, listRevisions, reviewRevision } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import type { ProviderAdapter } from "../providers/types";
import { makeTestStudio, seedIconJob, type TestStudio } from "../testing";
import { type HandlerContext, makeCheckpoint } from "./context";
import { generationHandler } from "./handlers/generation";

const hasPython = existsSync(`${process.cwd()}/python/.venv/bin/python`);

let studio: TestStudio;
afterEach(() => {
  setWritable(studio.config.paths.blobs, true);
  studio.cleanup();
});

/** Liga/desliga escrita em toda a árvore de diretórios do armazenamento (disco recusando gravação). */
function setWritable(dir: string, writable: boolean) {
  if (!existsSync(dir)) return;
  if (writable) chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) setWritable(path.join(dir, entry.name), writable);
  }
  if (!writable) chmodSync(dir, 0o555);
}

/**
 * Simula a morte do processo num ponto: a chamada nunca retorna, então nada
 * depois dela executa (nenhum catch, nenhuma gravação). `reached` resolve
 * quando o ponto é atingido.
 */
function instrumented(inner: ProviderAdapter, crashAt?: "after-submit" | "poll") {
  const calls = { submit: 0, poll: 0, fetch: 0 };
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const die = () => {
    reach();
    return new Promise<never>(() => undefined);
  };
  const adapter: ProviderAdapter = {
    transport: inner.transport,
    idempotentSubmit: inner.idempotentSubmit,
    pollIntervalMs: 1,
    capabilities: (op) => inner.capabilities(op),
    estimate: (op, n) => inner.estimate(op, n),
    async submit(req, signal) {
      calls.submit++;
      const r = await inner.submit(req, signal);
      if (crashAt === "after-submit") return die();
      return r;
    },
    async poll(id, signal) {
      calls.poll++;
      if (crashAt === "poll") return die();
      return inner.poll(id, signal);
    },
    async fetchResult(id, signal) {
      calls.fetch++;
      return inner.fetchResult(id, signal);
    },
    cancel: (id) => inner.cancel!(id),
  };
  return { adapter, calls, reached };
}

/** Reserva o job e executa o handler sem o runner, como um worker que morre no meio. */
async function startDoomedWorker(adapter: ProviderAdapter, opts: { python?: string; reached?: Promise<void> } = {}) {
  const claimed = studio.queue.claim("worker-que-morre")!;
  const deps = studio.depsFor(adapter);
  const controller = new AbortController();
  const ctx: HandlerContext = {
    ...deps,
    config: { ...deps.config, ...(opts.python ? { python: opts.python } : {}) },
    job: claimed.job,
    attempt: claimed.attempt,
    signal: controller.signal,
    workDir: `${studio.config.paths.staging}/${claimed.job.id}/${claimed.attempt.id}`,
    checkpoint: makeCheckpoint(studio.queue, claimed.attempt, controller.signal),
  };
  const running = generationHandler(ctx);
  if (opts.reached) {
    await opts.reached; // o processo "morre" aqui; a promessa nunca termina
  } else {
    await expect(running).rejects.toBeInstanceOf(DomainFailure); // falha sem o runner registrar nada
  }
  return claimed;
}

function enqueue(request: unknown, projectId: string, key = "clique-1") {
  return studio.queue.enqueue({ projectId, kind: "generation", request, idempotencyKey: key }).job;
}

describe.skipIf(!hasPython)("geração com provedor simulado", () => {
  it("duplo clique gera um job, uma chamada por parte e uma publicação", async () => {
    studio = makeTestStudio();
    const { project, asset, request } = seedIconJob(studio, { variants: 2 });
    const a = enqueue(request, project.id);
    const b = enqueue(request, project.id);
    expect(b.id).toBe(a.id);

    expect(await studio.runner().runOnce()).toBe(true);
    expect(await studio.runner().runOnce()).toBe(false);

    const job = studio.queue.get(a.id)!;
    expect(job.state).toBe("succeeded");
    expect(studio.simulatedStore.read().charged).toBe(2);
    const revisions = listRevisions(studio.db, project.id, asset.id);
    expect(revisions).toHaveLength(2);
    expect(revisions.every((r) => r.status === "candidate" && r.origin === "generation")).toBe(true);
    expect(revisions[0]!.files.map((f) => f.role).sort()).toEqual(["normalized", "raw"]);
    expect(JSON.parse(job.result_json!).cost).toEqual([{ unit: "generations", amount: 2 }]);
  });

  it("worker morre esperando o provedor: a retomada consulta o job remoto, sem reenviar", async () => {
    studio = makeTestStudio();
    const { project, asset, request } = seedIconJob(studio);
    const job = enqueue(request, project.id);
    const crashing = instrumented(studio.simulated, "poll");
    await startDoomedWorker(crashing.adapter, { reached: crashing.reached });
    expect(studio.queue.parts(job.id)[0]).toMatchObject({ remote_state: "accepted", submit_count: 1 });

    studio.clock.advance(31_000); // reserva vence
    const healthy = instrumented(studio.simulated);
    await studio.runner("worker-novo", healthy.adapter).runOnce();

    expect(studio.queue.get(job.id)?.state).toBe("succeeded");
    expect(healthy.calls.submit).toBe(0);
    expect(healthy.calls.poll).toBeGreaterThan(0);
    expect(studio.simulatedStore.read().charged).toBe(1);
    expect(listRevisions(studio.db, project.id, asset.id)).toHaveLength(1);
  });

  it("resposta bruta já salva: a retomada só refaz o processamento local", async () => {
    studio = makeTestStudio();
    const { project, request } = seedIconJob(studio);
    const job = enqueue(request, project.id);
    const first = instrumented(studio.simulated);
    // Python indisponível na primeira tentativa: a falha acontece depois de salvar a resposta bruta.
    await startDoomedWorker(first.adapter, { python: "/nao/existe/python" });
    expect(studio.queue.parts(job.id)[0]).toMatchObject({ remote_state: "completed" });
    expect(studio.queue.parts(job.id)[0]!.raw_blob_sha256).toMatch(/^[0-9a-f]{64}$/);

    studio.clock.advance(31_000);
    const second = instrumented(studio.simulated);
    await studio.runner("worker-novo", second.adapter).runOnce();
    expect(studio.queue.get(job.id)?.state).toBe("succeeded");
    expect(second.calls).toEqual({ submit: 0, poll: 0, fetch: 0 });
  });

  it("queda entre a intenção e o aceite, sem idempotência remota: pede decisão e só reenvia com confirmação", async () => {
    studio = makeTestStudio({ idempotent: false });
    const { project, asset, request } = seedIconJob(studio);
    const job = enqueue(request, project.id);
    const dying = instrumented(studio.simulated, "after-submit");
    await startDoomedWorker(dying.adapter, { reached: dying.reached });
    expect(studio.queue.parts(job.id)[0]?.remote_state).toBe("sending");

    studio.clock.advance(31_000);
    await studio.runner().runOnce();
    const attention = studio.queue.get(job.id)!;
    expect(attention.state).toBe("needs_attention");
    expect(JSON.parse(attention.error_json!).code).toBe("submission_uncertain");
    expect(studio.simulatedStore.read().charged).toBe(1);

    expect(() => studio.queue.retry(project.id, job.id)).toThrow(/possível nova cobrança/);
    studio.queue.retry(project.id, job.id, { acknowledgePossibleCharge: true });
    await studio.runner().runOnce();
    expect(studio.queue.get(job.id)?.state).toBe("succeeded");
    expect(studio.simulatedStore.read().charged).toBe(2); // a cobrança extra foi consentida
    expect(listRevisions(studio.db, project.id, asset.id)).toHaveLength(1);
  });

  it("mesma queda com provedor idempotente: reenvio seguro pela chave, sem nova cobrança", async () => {
    studio = makeTestStudio({ idempotent: true });
    const { project, request } = seedIconJob(studio);
    const job = enqueue(request, project.id);
    const dying = instrumented(studio.simulated, "after-submit");
    await startDoomedWorker(dying.adapter, { reached: dying.reached });
    studio.clock.advance(31_000);
    await studio.runner().runOnce();
    expect(studio.queue.get(job.id)?.state).toBe("succeeded");
    expect(studio.simulatedStore.read()).toMatchObject({ submissions: 2, charged: 1 });
  });

  it("falha de gravação conserva a revisão aprovada anterior e retoma sem reenviar", async () => {
    studio = makeTestStudio();
    const { project, asset, plan, request } = seedIconJob(studio);
    enqueue(request, project.id, "v1");
    await studio.runner().runOnce();
    const [v1] = listRevisions(studio.db, project.id, asset.id);
    reviewRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: asset.id,
      revisionId: v1!.id,
      decision: "approve",
      reason: null,
      expectedActiveRevisionId: null,
    });

    const plan2 = { ...plan, prompt: { ...plan.prompt, compiled: "Ícone de inventário: poção azul" } };
    const { canonicalDigest } = await import("@/domain/canonical-json");
    const job2 = enqueue({ ...request, plan: plan2, planDigest: canonicalDigest(plan2) }, project.id, "v2");
    setWritable(studio.config.paths.blobs, false); // disco recusa escrita
    await studio.runner().runOnce();

    const failed = studio.queue.get(job2.id)!;
    expect(failed.state).toBe("queued"); // storage_failed é retentável
    expect(JSON.parse(failed.error_json!).code).toBe("storage_failed");
    expect(getAsset(studio.db, project.id, asset.id).approvedRevisionId).toBe(v1!.id);
    expect(listRevisions(studio.db, project.id, asset.id)).toHaveLength(1);

    setWritable(studio.config.paths.blobs, true);
    studio.clock.advance(1_000);
    await studio.runner().runOnce();
    expect(studio.queue.get(job2.id)?.state).toBe("succeeded");
    expect(studio.simulatedStore.read().charged).toBe(2); // v1 + v2, sem reenvio da v2
    expect(getAsset(studio.db, project.id, asset.id).approvedRevisionId).toBe(v1!.id);
    expect(listRevisions(studio.db, project.id, asset.id)).toHaveLength(2);
  });

  it("cancelar durante a espera para a consulta, pede cancelamento remoto e não publica", async () => {
    studio = makeTestStudio({ delayMs: 60_000 });
    const { project, asset, request } = seedIconJob(studio);
    const job = enqueue(request, project.id);
    const run = studio.runner().runOnce();
    await new Promise((r) => setTimeout(r, 50));
    studio.queue.requestCancel(project.id, job.id);
    await run;
    const final = studio.queue.get(job.id)!;
    expect(final.state).toBe("cancelled");
    expect(JSON.parse(final.result_json!)).toMatchObject({ remoteCancelRequested: true });
    expect(Object.values(studio.simulatedStore.read().jobs)[0]?.cancelled).toBe(true);
    expect(listRevisions(studio.db, project.id, asset.id)).toHaveLength(0);
  });

  it("perfil sem a capacidade exigida bloqueia antes de qualquer envio", async () => {
    studio = makeTestStudio();
    const { project, plan, request } = seedIconJob(studio);
    const plan2 = { ...plan, requiredCapabilities: [...plan.requiredCapabilities, "native_mask" as const] };
    const { canonicalDigest } = await import("@/domain/canonical-json");
    const job = enqueue({ ...request, plan: plan2, planDigest: canonicalDigest(plan2) }, project.id);
    await studio.runner().runOnce();
    const final = studio.queue.get(job.id)!;
    expect(final.state).toBe("failed");
    expect(JSON.parse(final.error_json!)).toMatchObject({ code: "capability_missing", details: { missing: ["native_mask"] } });
    expect(studio.simulatedStore.read().submissions).toBe(0);
  });

  it("plano alterado depois de congelado é recusado", async () => {
    studio = makeTestStudio();
    const { project, request } = seedIconJob(studio);
    const job = enqueue({ ...request, planDigest: "0".repeat(64) }, project.id);
    await studio.runner().runOnce();
    expect(JSON.parse(studio.queue.get(job.id)!.error_json!).message).toMatch(/recalcule/);
    expect(studio.simulatedStore.read().submissions).toBe(0);
  });
});
