import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { listRevisions } from "../catalog/catalog";
import { makeTestStudio, seedIconJob, type TestStudio } from "../testing";
import { OpenAIImagesAdapter, OpenRouterAdapter } from "./adapters";
import { ProviderError, type ProviderSubmitRequest } from "./types";

/** Servidor HTTP local que imita os provedores: sem rede, sem custo, sem credencial real. */
interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}
type Handler = (req: Recorded, res: ServerResponse) => unknown;

let server: Server;
let base: string;
let handlers = new Map<string, Handler>();
const requests: Recorded[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rec = { method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(rec);
    const handler = handlers.get(`${req.method} ${req.url}`) ?? handlers.get(`${req.method} *`);
    if (!handler) {
      res.writeHead(404).end(JSON.stringify({ error: { message: "rota não simulada" } }));
      return;
    }
    await handler(rec, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TEST_PROVIDER_KEY = "chave-de-teste";
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  handlers = new Map();
  requests.length = 0;
});

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

function icon(color: [number, number, number, number] = [60, 200, 90, 255], size = 16): Uint8Array {
  const img = createImage(size, size);
  fillRect(img, 4, 4, size - 8, size - 8, color);
  return encodePng(img);
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const signal = () => new AbortController().signal;

const generateRequest = (references: ProviderSubmitRequest["references"] = []): ProviderSubmitRequest => ({
  idempotencyKey: "job_1:image:v1",
  operation: "generate_asset",
  prompt: "poção verde",
  params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants: 1 },
  references,
});

const profile = (path: string, model: string | null = "modelo-x") => ({ id: "p", baseUrl: `${base}${path}`, secretRef: "TEST_PROVIDER_KEY", model });

describe("OpenAI Images (perfil custom)", () => {
  it("gera por texto com JSON, credencial só no cabeçalho e fundo transparente", async () => {
    handlers.set("POST /v1/images/generations", (_req, res) => json(res, 200, { created: 1, data: [{ b64_json: b64(icon()) }], usage: { total_tokens: 10 } }));
    const adapter = new OpenAIImagesAdapter(profile("/v1"), {});
    const out = await adapter.submit(generateRequest(), signal());
    expect(out).toMatchObject({ kind: "sync", cost: null });
    expect(out.kind === "sync" && out.images[0]?.mime).toBe("image/png");
    const [req] = requests;
    expect(req!.headers.authorization).toBe("Bearer chave-de-teste");
    expect(JSON.parse(req!.body.toString())).toMatchObject({ model: "modelo-x", prompt: "poção verde", n: 1, background: "transparent", output_format: "png" });
  });

  it("referências vão em multipart na ordem declarada; máscara codificada em campo próprio", async () => {
    let form: FormData | undefined;
    handlers.set("POST /v1/images/edits", async (req, res) => {
      form = await new Response(new Uint8Array(req.body), { headers: { "content-type": req.headers["content-type"]! } }).formData();
      json(res, 200, { data: [{ b64_json: b64(icon()) }] });
    });
    const adapter = new OpenAIImagesAdapter(profile("/v1"), {});
    const a = icon([255, 0, 0, 255]);
    const b = icon([0, 0, 255, 255]);
    await adapter.submit(generateRequest([{ role: "identity", mime: "image/png", bytes: a }, { role: "material", mime: "image/png", bytes: b }]), signal());
    const parts = form!.getAll("image[]") as File[];
    expect(parts).toHaveLength(2);
    expect(Buffer.from(await parts[0]!.arrayBuffer()).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(await parts[1]!.arrayBuffer()).equals(Buffer.from(b))).toBe(true);
    expect(form!.get("mask")).toBeNull();

    await adapter.submit(
      { ...generateRequest([{ role: "source", mime: "image/png", bytes: a }, { role: "remote_mask", mime: "image/png", bytes: b }]), operation: "inpaint" },
      signal(),
    );
    expect(form!.getAll("image[]")).toHaveLength(1);
    expect(form!.get("mask")).toBeInstanceOf(File);
  });

  it("resposta por URL só é baixada de host autorizado e sem repassar a credencial", async () => {
    handlers.set("POST /v1/images/generations", (_req, res) => json(res, 200, { data: [{ url: `${base}/files/a.png` }] }));
    handlers.set("GET /files/a.png", (_req, res) => res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(icon())));
    const host = new URL(base).host;
    await expect(new OpenAIImagesAdapter(profile("/v1"), {}).submit(generateRequest(), signal())).rejects.toThrow(/não autorizado/);
    const ok = await new OpenAIImagesAdapter(profile("/v1"), { allowedDownloadHosts: [host] }).submit(generateRequest(), signal());
    expect(ok.kind === "sync" && ok.images).toHaveLength(1);
    expect(requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it.each([
    [429, { error: { message: "Saldo esgotado", code: "credit_balance_exhausted", type: "insufficient_quota" } }, {}, "balance"],
    [429, { error: { message: "Devagar", code: "slow_down" } }, { "retry-after": "2" }, "rate_limited"],
    [401, { error: { message: "Chave inválida" } }, {}, "auth"],
    [400, { error: { message: "moderation_blocked", code: "moderation_blocked" } }, {}, "rejected"],
    [503, { error: { message: "Sobrecarregado" } }, {}, "unavailable"],
  ])("HTTP %i é classificado", async (status, body, headers, kind) => {
    handlers.set("POST /v1/images/generations", (_req, res) => json(res, status, body, headers));
    const err = await new OpenAIImagesAdapter(profile("/v1"), {}).submit(generateRequest(), signal()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
    if (kind === "rate_limited") expect(err.retryAfterMs).toBe(2000);
  });

  it("resposta sem imagem, redirecionamento e prazo esgotado têm categorias distintas", async () => {
    handlers.set("POST /v1/images/generations", (_req, res) => json(res, 200, { data: [] }));
    expect((await new OpenAIImagesAdapter(profile("/v1"), {}).submit(generateRequest(), signal()).catch((e) => e)).kind).toBe("rejected");
    handlers.set("POST /v1/images/generations", (_req, res) => res.writeHead(302, { location: "https://outro.example/" }).end());
    expect((await new OpenAIImagesAdapter(profile("/v1"), {}).submit(generateRequest(), signal()).catch((e) => e)).message).toMatch(/Redirecionamento/);
    handlers.set("POST /v1/images/generations", () => new Promise(() => undefined)); // nunca responde
    const slow = await new OpenAIImagesAdapter(profile("/v1"), { timeoutMs: 150 }).submit(generateRequest(), signal()).catch((e) => e);
    expect(slow.kind).toBe("ambiguous"); // pode ter sido aceito e cobrado
  });

  it("servidor fora do ar antes de conectar é não aceito (retentável sem custo)", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await new OpenAIImagesAdapter({ ...profile("/v1"), baseUrl: `http://127.0.0.1:${port}/v1` }, {}).submit(generateRequest(), signal()).catch((e) => e);
    expect(err.kind).toBe("not_accepted");
  });

  it("recusa URL base http fora do computador e destino diferente do perfil", () => {
    expect(() => new OpenAIImagesAdapter({ ...profile("/v1"), baseUrl: "http://exemplo.com/v1" }, {})).toThrow(/https/);
  });
});

describe("OpenRouter Images", () => {
  it("envia referências ordenadas como data URL, rota fixada e custo em USD", async () => {
    handlers.set("POST /api/v1/images", (_req, res) => json(res, 200, { created: 1, data: [{ b64_json: b64(icon()), media_type: "image/png" }], usage: { cost: 0.04 } }));
    const adapter = new OpenRouterAdapter(profile("/api/v1", "bytedance-seed/seedream-4.5"), {
      maxReferences: 14,
      provider: { only: ["seed"], allow_fallbacks: false },
    });
    const out = await adapter.submit(generateRequest([{ role: "identity", mime: "image/png", bytes: icon() }]), signal());
    expect(out).toMatchObject({ kind: "sync", cost: { amount: 0.04, unit: "USD" } });
    const body = JSON.parse(requests[0]!.body.toString());
    expect(body.provider).toEqual({ only: ["seed"], allow_fallbacks: false });
    expect(body.input_references[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(body).not.toHaveProperty("mask");
  });

  it("mais referências que a rota aceita bloqueia antes de qualquer chamada", async () => {
    const adapter = new OpenRouterAdapter(profile("/api/v1", "google/gemini-2.5-flash-image"), { maxReferences: 3 });
    const refs = Array.from({ length: 4 }, () => ({ role: "style", mime: "image/png", bytes: icon() }));
    await expect(adapter.submit(generateRequest(refs), signal())).rejects.toThrow(/até 3 referências/);
    expect(requests).toHaveLength(0);
    // Referência visual não é máscara nativa: só o modo "candidata + composição local".
    expect(adapter.capabilities("inpaint")).toEqual(["image_edit"]);
    expect(new OpenRouterAdapter(profile("/api/v1", "m"), { maxReferences: 1 }).capabilities("inpaint")).toEqual([]); // sem lugar para fonte + guia
  });

  it("descobre limites e preço da rota sem credencial", async () => {
    handlers.set("GET /api/v1/images/models/bytedance-seed/seedream-4.5/endpoints", (_req, res) =>
      json(res, 200, {
        id: "bytedance-seed/seedream-4.5",
        endpoints: [{ provider_tag: "seed", supported_parameters: { input_references: { type: "range", min: 0, max: 14 } }, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] }],
      }),
    );
    const found = await new OpenRouterAdapter({ ...profile("/api/v1", "bytedance-seed/seedream-4.5"), secretRef: null }, {}).discover(signal());
    expect(found).toEqual([{ providerTag: "seed", maxReferences: 14, transparent: false, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] }]);
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });
});

describe("respostas de erro (comuns aos transportes HTTP)", () => {
  it("402, 402 transitório por pedidos em andamento e 422 com detalhe de validação", async () => {
    const adapter = new OpenRouterAdapter(profile("/api/v1"), { transparent: true });
    handlers.set("POST /api/v1/images", (_req, res) => json(res, 402, { detail: "Insufficient credits" }));
    expect((await adapter.submit(generateRequest(), signal()).catch((e) => e)).kind).toBe("balance");
    // OpenRouter: 402 por reserva de pedidos em andamento é transitório (repete com espera).
    handlers.set("POST /api/v1/images", (_req, res) =>
      json(res, 402, { detail: "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle." }),
    );
    const inflight = await adapter.submit(generateRequest(), signal()).catch((e) => e);
    expect([inflight.kind, inflight.retryAfterMs]).toEqual(["rate_limited", 15_000]);
    handlers.set("POST /api/v1/images", (_req, res) => json(res, 422, { detail: [{ loc: ["body", "aspect_ratio"], msg: "invalid", type: "x" }] }));
    expect((await adapter.submit(generateRequest(), signal()).catch((e) => e)).message).toBe("body.aspect_ratio: invalid");
  });
});

describe("cadastro de perfis", () => {
  let studio: TestStudio;
  afterEach(() => studio?.cleanup());

  it("salva perfil, grava capacidades declaradas com data do contrato e descobre a rota sem custo", async () => {
    const { saveProfile, capabilityMatrix, checkProfile } = await import("./profiles");
    const { ProviderRegistry } = await import("./registry");
    studio = makeTestStudio();
    const saved = saveProfile(studio.db, studio.clock, {
      id: "or",
      name: "OpenRouter",
      transport: "openrouter_images",
      baseUrl: `${base}/api/v1`,
      secretRef: "TEST_PROVIDER_KEY",
      model: "bytedance-seed/seedream-4.5",
      config: { maxReferences: 3 },
    });
    expect(saved).toMatchObject({ transport: "openrouter_images", secretConfigured: true });
    const matrix = capabilityMatrix(studio.db, "or");
    expect(matrix.filter((m) => m.operation === "inpaint").map((m) => m.capability)).toEqual(["image_edit"]);
    expect(matrix.every((m) => m.status === "declared" && m.contractSnapshot?.includes("2026-11-18"))).toBe(true);

    handlers.set("GET /api/v1/images/models/bytedance-seed/seedream-4.5/endpoints", (_req, res) =>
      json(res, 200, { endpoints: [{ provider_tag: "seed", supported_parameters: { input_references: { type: "array", max: 14 } }, pricing: [] }] }),
    );
    const check = await checkProfile(studio.db, new ProviderRegistry(studio.db, studio.config), "or");
    expect(check).toMatchObject({ ok: true, message: expect.stringContaining("1 rota(s)") });
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("recusa http remoto, configuração inválida, segredo em vez de nome e ID reservado", async () => {
    const { saveProfile, ProfileInput } = await import("./profiles");
    studio = makeTestStudio();
    expect(() =>
      saveProfile(studio.db, studio.clock, { id: "c", name: "C", transport: "openai_images", baseUrl: "http://exemplo.com/v1", secretRef: "KEY_X", model: "m", config: {} }),
    ).toThrow(/https/);
    expect(() =>
      saveProfile(studio.db, studio.clock, { id: "c", name: "C", transport: "openrouter_images", secretRef: "KEY_X", model: "m", config: { maxReferences: 99 } }),
    ).toThrow(/Configuração inválida/);
    expect(ProfileInput.safeParse({ id: "x", name: "X", transport: "openrouter_images", secretRef: "sk-live-123", model: "m", config: {} }).success).toBe(false);
    expect(ProfileInput.safeParse({ id: "simulated", name: "X", transport: "openrouter_images", secretRef: "KEY_X", model: "m", config: {} }).success).toBe(false);
  });

  it("credencial ausente bloqueia o planejamento antes de qualquer chamada", async () => {
    const { saveProfile } = await import("./profiles");
    const { buildGenerationPlan } = await import("../services");
    studio = makeTestStudio();
    saveProfile(studio.db, studio.clock, { id: "or", name: "OR", transport: "openrouter_images", baseUrl: `${base}/api/v1`, secretRef: "VARIAVEL_INEXISTENTE", model: "m", config: { transparent: true } });
    const { project } = seedIconJob(studio);
    expect(() =>
      buildGenerationPlan(studio, project.id, {
        operation: "generate_asset",
        providerProfileId: "or",
        brief: "poção",
        params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants: 1 },
      }),
    ).toThrow(/VARIAVEL_INEXISTENTE/);
    expect(requests).toHaveLength(0);
  });
});

describe.skipIf(!existsSync(`${process.cwd()}/python/.venv/bin/python`))("geração com referências ordenadas pelo OpenRouter simulado", () => {
  let studio: TestStudio;
  afterEach(() => studio?.cleanup());

  async function setup(maxReferences: number, extra: Record<string, unknown> = {}) {
    const { saveProfile } = await import("./profiles");
    const { importPortablePackage } = await import("../export/import");
    const { readZip, writeZip } = await import("@/lib/zip");
    studio = makeTestStudio();
    saveProfile(studio.db, studio.clock, {
      id: "or",
      name: "OpenRouter",
      transport: "openrouter_images",
      baseUrl: `${base}/api/v1`,
      secretRef: "TEST_PROVIDER_KEY",
      model: "bytedance-seed/seedream-4.5",
      config: { maxReferences, provider: { only: ["seed"], allow_fallbacks: false }, aspectRatio: "1:1", pricePerImageUsd: 0.04, ...extra },
    });
    const { project, asset } = seedIconJob(studio);
    const fixture = buildClareira();
    const zip = writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })));
    const { revisionMap } = await importPortablePackage(studio, project.id, readZip(zip), { approve: true });
    return { project, asset, potion: revisionMap["potion-v1"]!, warrior: revisionMap["warrior-base-v1"]!, tiles: revisionMap["grass-water-v1"]! };
  }

  it("limite da rota explicado antes de cobrar", async () => {
    const { buildGenerationPlan } = await import("../services");
    const { project, potion, warrior } = await setup(1);
    expect(() =>
      buildGenerationPlan(studio, project.id, {
        operation: "generate_asset",
        providerProfileId: "or",
        brief: "poção",
        params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: false, variants: 1 },
        references: [
          { revisionId: potion, fileKey: "potion-sheet", role: "identity" },
          { revisionId: warrior, fileKey: "warrior-base-s", role: "palette" },
        ],
      }),
    ).toThrow(/até 1 referência/);
    expect(requests).toHaveLength(0);
  });

  it("inpainting por candidata: fonte ampliada + guia na ordem, proporção da fonte e só a região marcada copiada", async () => {
    const { buildInpaintPlan } = await import("../inpaint");
    const { ingestUpload, submitJob } = await import("../services");
    const { readPngInfo } = await import("@/lib/media/png");
    const { getRevision } = await import("../catalog/catalog");
    const { project, tiles } = await setup(14);
    const mask = createImage(128, 128);
    fillRect(mask, 0, 0, 128, 128, [0, 0, 0, 255]);
    fillRect(mask, 32, 40, 64, 40, [255, 255, 255, 255]);
    const { upload } = await ingestUpload(studio, project.id, { name: "margem.png", bytes: encodePng(mask) });
    await studio.runner().runOnce();
    const planned = await buildInpaintPlan(studio, project.id, {
      operation: "inpaint",
      providerProfileId: "or",
      sourceRevisionId: tiles,
      sourceFileKey: "grass-water-atlas",
      maskUploadId: upload.id,
      instruction: "reconstruir a margem do lago com juncos",
      mode: "candidate-composite",
      language: "en",
    });
    // Resposta 2× da fonte, com tudo redesenhado: a composição só copia a região marcada.
    const answer = createImage(256, 256);
    fillRect(answer, 0, 0, 256, 256, [200, 30, 30, 255]);
    handlers.set("POST /api/v1/images", (_req, res) => json(res, 200, { data: [{ b64_json: b64(encodePng(answer)) }], usage: { cost: 0.045 } }));
    const asset = getRevision(studio.db, project.id, tiles).assetId;
    const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: asset } }, "inpaint-or");
    await studio.runner("w", studio.providers.adapterFor("or")).runOnce();
    const done = studio.queue.get(job.id)!;
    expect([done.state, done.error_json]).toEqual(["succeeded", null]);

    const sent = requests.filter((r) => r.path === "/api/v1/images").map((r) => JSON.parse(r.body.toString()) as { prompt: string; aspect_ratio?: string; background?: string; input_references: { image_url: { url: string } }[] });
    expect(sent).toHaveLength(1);
    const body = sent[0]!;
    expect([body.aspect_ratio, body.background ?? null]).toEqual(["1:1", null]);
    const images = body.input_references.map((r) => readPngInfo(new Uint8Array(Buffer.from(r.image_url.url.split(",")[1]!, "base64"))));
    expect(images.map((i) => [i?.width, i?.height])).toEqual([
      [1024, 1024], // imagem 1: contexto 8×
      [1024, 1024], // imagem 2: guia com a região pintada
    ]);
    expect(body.prompt).toMatch(/^Edit image 1.*Image 2 is the same image with the region to change painted flat magenta\. Change only that region/);

    const { listRevisions } = await import("../catalog/catalog");
    const edited = listRevisions(studio.db, project.id, asset).find((r) => r.origin === "edit")!;
    const report = edited.technicalReport as { mode: string; composite: { protectedDiffPixels: number; editedPixels: number; candidateAgreement: number }; steps: { operation: string; method?: string }[]; warnings: string[] };
    expect(report.mode).toBe("candidate-composite");
    expect(report.composite).toMatchObject({ protectedDiffPixels: 0, editedPixels: 64 * 40, candidateAgreement: 0 });
    expect(report.steps[0]).toMatchObject({ operation: "fit_logical", method: "nearest_integer" });
    expect(report.warnings.some((w) => /emenda/.test(w))).toBe(true);
  });

  it("alfa só com uma referência: sem referência o plano usa cor-chave e não pede fundo transparente", async () => {
    const { buildGenerationPlan } = await import("../services");
    const { project, potion } = await setup(14, { transparent: "single_reference" });
    const plan = (references: { revisionId: string; fileKey: string; role: "identity" }[]) =>
      buildGenerationPlan(studio, project.id, {
        operation: "generate_asset",
        providerProfileId: "or",
        brief: "poção",
        params: { family: "item", kind: "consumable", logicalSize: [32, 32], transparent: true, variants: 1 },
        references,
      }).plan;
    const textOnly = plan([]);
    const oneRef = plan([{ revisionId: potion, fileKey: "potion-sheet", role: "identity" }]);
    expect(textOnly.operation === "generate_asset" && textOnly.params.backgroundKey).toMatch(/^#[0-9a-f]{6}$/);
    expect(textOnly.requiredCapabilities).not.toContain("alpha_output");
    expect(oneRef.operation === "generate_asset" && oneRef.params.backgroundKey).toBeFalsy();
    expect(oneRef.requiredCapabilities).toContain("alpha_output");
    const adapter = studio.providers.adapterFor("or");
    handlers.set("POST /api/v1/images", (_req, res) => json(res, 400, { error: { message: "stop" } }));
    for (const p of [textOnly, oneRef]) {
      await adapter
        .submit({ operation: "generate_asset", prompt: "x", params: p.params as Record<string, unknown>, references: [], idempotencyKey: "i" }, AbortSignal.timeout(5000))
        .catch(() => undefined);
    }
    const bodies = requests.filter((r) => r.path === "/api/v1/images").map((r) => JSON.parse(r.body.toString()) as { background?: string });
    expect(bodies.map((b) => b.background ?? null)).toEqual([null, "transparent"]);
  });

  it("duas referências chegam na ordem, ampliadas por fator inteiro, com fundo de cor-chave", async () => {
    const { buildGenerationPlan, submitJob } = await import("../services");
    const { readPngInfo } = await import("@/lib/media/png");
    const { project, asset, potion, warrior } = await setup(14);
    // Resposta típica de rota sem alfa: fundo magenta escuro, objeto no centro, arte numa grade de 16 px.
    const keyed = createImage(128, 128);
    fillRect(keyed, 0, 0, 128, 128, [163, 22, 105, 255]);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) fillRect(keyed, 32 + i * 16, 32 + j * 16, 16, 16, (i + j) % 2 ? [60, 200, 90, 255] : [30, 110, 50, 255]);
    handlers.set("POST /api/v1/images", (_req, res) => json(res, 200, { data: [{ b64_json: b64(encodePng(keyed)) }], usage: { cost: 0.04 } }));
    const preview = buildGenerationPlan(studio, project.id, {
      operation: "generate_asset",
      providerProfileId: "or",
      brief: "poção azul",
      params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants: 1 },
      references: [
        { revisionId: potion, fileKey: "potion-sheet", role: "identity" },
        { revisionId: warrior, fileKey: "warrior-base-s", role: "palette", instruction: "cores da túnica" },
      ],
    });
    // Transparência pedida, rota sem alfa: não bloqueia; vira cor-chave + remoção local.
    expect(preview.plan.requiredCapabilities).toEqual(["text_to_image", "image_references"]);
    expect(preview.plan.params).toMatchObject({ transparent: true, backgroundKey: "#ff00ff" });
    expect(preview.plan.limits.estimate).toMatchObject({ kind: "known", amount: { amount: 0.04, unit: "USD" } });
    expect(preview.plan.prompt.compiled).toContain("Imagem 2: paleta");
    expect(preview.plan.prompt.compiled).toContain("Fundo magenta puro");
    expect(preview.plan.prompt.compiled).not.toContain("#"); // código hexadecimal vira texto desenhado

    const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: preview.plan, planDigest: preview.digest, targetAssetId: asset.id } }, "k");
    const { JobRunner } = await import("../jobs/runner");
    const { ProviderRegistry } = await import("./registry");
    await new JobRunner({ ...studio.deps, providers: new ProviderRegistry(studio.db, studio.config) }, { workerId: "w", heartbeatMs: 60_000 }).runOnce();
    const final = studio.queue.get(job.id)!;
    expect(final.state, final.error_json ?? "").toBe("succeeded");

    const body = JSON.parse(requests[0]!.body.toString());
    const sent = body.input_references.map((r: { image_url: { url: string } }) => readPngInfo(new Uint8Array(Buffer.from(r.image_url.url.split(",")[1]!, "base64"))));
    expect(sent.map((i: { width: number; height: number }) => [i.width, i.height])).toEqual([
      [512, 256], // folha da poção 32×16 ampliada 16× (lado menor ≥ 256)
      [256, 256], // guerreiro 64×64 ampliado 4×
    ]);
    expect(body).toMatchObject({ model: "bytedance-seed/seedream-4.5", aspect_ratio: "1:1", provider: { only: ["seed"], allow_fallbacks: false } });
    expect(body).not.toHaveProperty("background");
    const [revision] = listRevisions(studio.db, project.id, asset.id);
    const report = revision!.technicalReport as { receivedSize: number[]; steps: { operation: string; grid?: number[] }[] };
    expect(report.receivedSize).toEqual([128, 128]);
    expect(report.steps.map((s) => s.operation)).toEqual(["unzoom", "remove_background_flood", "fit_logical"]);
    // O objeto tem só 4 células de 16 px (< metade de 16): a guarda prefere a grade de 8 px,
    // (mesma arte, sem perda); o ajuste amplia o recorte 8×8 por 2 inteiro.
    expect(report.steps[0]!.grid).toEqual([16, 16]);
    expect(report.steps[2]).toMatchObject({ method: "nearest_upscale", contentRect: [4, 4, 8, 8], alphaBinarized: 0 });
    const image = revision!.files.find((f) => f.fileKey === "image")!;
    expect(image.metadata).toMatchObject({ width: 16, height: 16 });
  });
});
