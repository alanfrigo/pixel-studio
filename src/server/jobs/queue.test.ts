import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { makeTestStudio, type TestStudio } from "../testing";
import { StaleAttemptError } from "./queue";

let studio: TestStudio;
afterEach(() => studio?.cleanup());

function setup() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Fila" });
  const enqueue = (key: string, request: unknown = { uploadId: "upl_x" }) =>
    studio.queue.enqueue({ projectId: project.id, kind: "ingest", request, idempotencyKey: key });
  return { project, enqueue };
}

describe("idempotência", () => {
  it("mesmo envio com a mesma chave devolve o mesmo job (duplo clique)", () => {
    const { enqueue } = setup();
    const a = enqueue("k1");
    const b = enqueue("k1");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")?.n).toBe(1);
  });

  it("mesma chave com pedido diferente é conflito 409", () => {
    const { enqueue } = setup();
    enqueue("k1", { uploadId: "upl_a" });
    try {
      enqueue("k1", { uploadId: "upl_b" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainFailure);
      expect((err as DomainFailure).code).toBe("idempotency_conflict");
      expect((err as DomainFailure).status).toBe(409);
    }
  });

  it("chaves iguais em projetos diferentes são independentes", () => {
    const { enqueue } = setup();
    enqueue("k1");
    const other = createProject(studio.db, studio.clock, { name: "Outro" });
    const r = studio.queue.enqueue({ projectId: other.id, kind: "ingest", request: { uploadId: "upl_x" }, idempotencyKey: "k1" });
    expect(r.created).toBe(true);
  });
});

describe("reserva e posse", () => {
  it("reserva vencida volta para a fila e a tentativa antiga perde a posse", () => {
    const { enqueue } = setup();
    const { job } = enqueue("k1");
    const first = studio.queue.claim("w1")!;
    expect(first.attempt.number).toBe(1);
    expect(studio.queue.claim("w2")).toBeNull();

    studio.clock.advance(31_000);
    const second = studio.queue.claim("w2")!;
    expect(second.job.id).toBe(job.id);
    expect(second.attempt.number).toBe(2);

    expect(studio.queue.heartbeat(first.attempt)).toBe(false);
    expect(() => studio.queue.succeed(first.attempt, () => "publicação tardia")).toThrow(StaleAttemptError);
    studio.queue.succeed(second.attempt, () => "ok");
    expect(studio.queue.get(job.id)?.state).toBe("succeeded");
    const outcomes = studio.db.all<{ outcome: string }>("SELECT outcome FROM job_attempts ORDER BY number").map((r) => r.outcome);
    expect(outcomes).toEqual(["lease_expired", "succeeded"]);
  });

  it("batimento mantém a posse além do prazo original", () => {
    const { enqueue } = setup();
    enqueue("k1");
    const c = studio.queue.claim("w1")!;
    studio.clock.advance(20_000);
    expect(studio.queue.heartbeat(c.attempt)).toBe(true);
    studio.clock.advance(20_000);
    expect(studio.queue.claim("w2")).toBeNull();
  });

  it("worker que cai repetidamente leva o job a needs_attention, não a um laço infinito", () => {
    const { enqueue } = setup();
    const { job } = enqueue("k1");
    for (let i = 0; i < 3; i++) {
      expect(studio.queue.claim(`w${i}`)).not.toBeNull();
      studio.clock.advance(31_000);
    }
    expect(studio.queue.claim("w9")).toBeNull();
    expect(studio.queue.get(job.id)?.state).toBe("needs_attention");
  });
});

describe("falhas e novas tentativas", () => {
  it("falha retentável espera progressivamente e esgota em failed", () => {
    const { enqueue } = setup();
    const { job } = enqueue("k1");
    const err = new DomainFailure("provider_unavailable", "fora do ar");

    let c = studio.queue.claim("w")!;
    expect(studio.queue.fail(c.attempt, err, { retryable: true })).toBe("queued");
    expect(studio.queue.claim("w")).toBeNull(); // ainda em espera
    studio.clock.advance(1_000);
    c = studio.queue.claim("w")!;
    expect(studio.queue.fail(c.attempt, err, { retryable: true })).toBe("queued");
    studio.clock.advance(1_999);
    expect(studio.queue.claim("w")).toBeNull(); // segunda espera = 2 s
    studio.clock.advance(1);
    c = studio.queue.claim("w")!;
    expect(studio.queue.fail(c.attempt, err, { retryable: true })).toBe("failed");
    expect(studio.queue.get(job.id)).toMatchObject({ state: "failed", attempt_count: 3 });

    const retried = studio.queue.retry(job.project_id, job.id);
    expect(retried.state).toBe("queued");
    expect(studio.queue.claim("w")?.attempt.number).toBe(4);
  });

  it("Retry-After do provedor prevalece sobre a espera padrão", () => {
    const { enqueue } = setup();
    enqueue("k1");
    const c = studio.queue.claim("w")!;
    studio.queue.fail(c.attempt, new DomainFailure("provider_unavailable", "limite"), { retryable: true, retryAfterMs: 10_000 });
    studio.clock.advance(9_999);
    expect(studio.queue.claim("w")).toBeNull();
    studio.clock.advance(1);
    expect(studio.queue.claim("w")).not.toBeNull();
  });
});

describe("cancelamento", () => {
  it("job na fila é cancelado na hora", () => {
    const { project, enqueue } = setup();
    const { job } = enqueue("k1");
    expect(studio.queue.requestCancel(project.id, job.id).state).toBe("cancelled");
    expect(studio.queue.claim("w")).toBeNull();
  });

  it("job em execução recebe o pedido e não consegue publicar depois dele", () => {
    const { project, enqueue } = setup();
    const { job } = enqueue("k1");
    const c = studio.queue.claim("w")!;
    studio.queue.requestCancel(project.id, job.id);
    expect(studio.queue.get(job.id)?.state).toBe("running");
    expect(() => studio.queue.succeed(c.attempt, () => "x")).toThrow(/Cancelamento/);
    studio.queue.acknowledgeCancel(c.attempt);
    expect(studio.queue.get(job.id)?.state).toBe("cancelled");
  });

  it("não encontra job de outro projeto", () => {
    const { enqueue } = setup();
    const { job } = enqueue("k1");
    const other = createProject(studio.db, studio.clock, { name: "Outro" });
    expect(() => studio.queue.requestCancel(other.id, job.id)).toThrow(/não encontrado/);
  });
});
