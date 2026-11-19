import { afterEach, describe, expect, it } from "vitest";
import * as jobRoute from "@/app/api/v1/projects/[projectId]/jobs/[jobId]/route";
import * as projectRoute from "@/app/api/v1/projects/[projectId]/route";
import { DomainError } from "@/contracts";
import { MemorySimulatedStore, SimulatedProvider } from "./providers/simulated";
import { makeTestStudio, seedIconJob, type TestStudio } from "./testing";

/**
 * Erros do servidor nos dois idiomas da interface: a API responde no idioma
 * da requisição (cookie `ps-locale`, senão Accept-Language) e o erro gravado
 * num job guarda os dois, para o cliente escolher ao exibir.
 */

const GLOBAL_KEY = Symbol.for("pixel-studio.web");
let studio: TestStudio;
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
  studio?.cleanup();
});

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function get(handler: unknown, params: Record<string, string>, headers: Record<string, string>) {
  const req = new Request("http://127.0.0.1:3000/api/v1/x", { headers: { host: "127.0.0.1:3000", ...headers } });
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("erros da API no idioma da requisição", () => {
  it("DomainFailure: inglês com ps-locale=en, português com ps-locale=pt-BR, os dois em `messages`", async () => {
    studio = makeTestStudio();
    (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = studio;
    const messages = { "pt-BR": "Projeto não encontrado", en: "Project not found" };

    const en = await get(projectRoute.GET, { projectId: "prj_nao_existe" }, { cookie: "ps-locale=en", "accept-language": "pt-BR" });
    expect(en.status).toBe(404);
    expect(en.body).toMatchObject({ code: "not_found", message: "Project not found", messages });
    expect(DomainError.safeParse(en.body).success).toBe(true);

    const pt = await get(projectRoute.GET, { projectId: "prj_nao_existe" }, { cookie: "ps-locale=pt-BR", "accept-language": "en-US" });
    expect(pt.body).toMatchObject({ code: "not_found", message: "Projeto não encontrado", messages });

    // Sem cookie, vale o Accept-Language do navegador.
    const browser = await get(projectRoute.GET, { projectId: "prj_nao_existe" }, { "accept-language": "pt-BR,pt;q=0.9,en;q=0.8" });
    expect(browser.body.message).toBe("Projeto não encontrado");
  });

  it("HttpError (host fora do loopback) também sai no idioma da requisição", async () => {
    studio = makeTestStudio();
    (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = studio;
    const en = await get(projectRoute.GET, { projectId: "x" }, { host: "evil.example:3000", cookie: "ps-locale=en" });
    expect(en.status).toBe(403);
    expect(en.body).toMatchObject({ code: "forbidden_host", message: "Host not allowed: the Studio only serves its local address" });
    const pt = await get(projectRoute.GET, { projectId: "x" }, { host: "evil.example:3000", cookie: "ps-locale=pt-BR" });
    expect(pt.body.message).toBe("Host não autorizado: o Studio atende apenas no endereço local");
  });
});

describe("erro gravado num job", () => {
  it("guarda português em `message` e os dois idiomas em `messages`, inclusive o texto do provedor interpolado", async () => {
    studio = makeTestStudio({ idempotent: false });
    (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = studio;
    const { project, request } = seedIconJob(studio);
    const job = studio.queue.enqueue({ projectId: project.id, kind: "generation", request, idempotencyKey: "i18n-1" }).job;
    // Conexão cai depois do aceite: envio incerto, o job pede decisão.
    const flaky = new SimulatedProvider(new MemorySimulatedStore(), { delayMs: 0, idempotent: false, failAfterAccept: true });
    await studio.runner("worker-i18n", flaky).runOnce();

    const stored = JSON.parse(studio.queue.get(job.id)!.error_json!) as DomainError;
    expect(DomainError.parse(stored)).toMatchObject({
      code: "submission_uncertain",
      message: expect.stringMatching(/^Envio incerto: Conexão perdida depois do envio \(simulado\)\./),
      messages: {
        "pt-BR": expect.stringMatching(/^Envio incerto: Conexão perdida depois do envio \(simulado\)\. O provedor pode ter recebido e cobrado o pedido\.$/),
        en: "Uncertain submission: Connection lost after submission (simulated). The provider may have received and charged the request.",
      },
    });

    // A rota devolve o erro gravado como está: o cliente escolhe o idioma em `messages`.
    const view = await get(jobRoute.GET, { projectId: project.id, jobId: job.id }, { cookie: "ps-locale=en" });
    expect((view.body.job as { state: string; error: DomainError }).state).toBe("needs_attention");
    expect((view.body.job as { error: DomainError }).error.messages?.en).toMatch(/^Uncertain submission/);
  });
});
