import { z } from "zod";
import { type Capability, CostAmount, type CostEstimate, type Direction, type MotionPayload, type PlanOperation, type ProjectionKind, type ReferenceSheet } from "@/contracts";
import { readPngInfo } from "@/lib/media/png";
import { DomainFailure } from "../errors";
import { checkBaseUrl, decodeImage, failOnStatus, providerFetch, resolveSecret, toDataUrl } from "./http";
import { pixelLabInpaintBody, pixelLabRotateBody, pixelLabSkeletonBody, pixelLabTextAnimationBody } from "./mappings";
import { ProviderError, type ProviderAdapter, type ProviderImage, type ProviderResult, type ProviderSubmitRequest, type RemoteStatus, type SubmitOutcome } from "./types";
import { genericWorldCapabilities, isWorldOperation, worldCanvas } from "../world/provider-caps";

/**
 * Adaptadores reais (03 §integrações): API customizada com contrato OpenAI
 * Images, OpenRouter Images e PixelLab REST v2. Capacidades declaradas por
 * operação; segredo resolvido no worker pelo nome da variável de ambiente.
 */

export interface AdapterProfile {
  id: string;
  baseUrl: string;
  secretRef: string | null;
  model: string | null;
}

// ---------------------------------------------------------------------------
// Configurações por transporte (validadas ao salvar o perfil)
// ---------------------------------------------------------------------------

export const OpenAIImagesConfig = z.strictObject({
  size: z.string().regex(/^(auto|\d+x\d+)$/).default("1024x1024"),
  quality: z.enum(["auto", "low", "medium", "high"]).optional(),
  transparent: z.boolean().default(true),
  /** Máximo de imagens de entrada em `images/edits` (0 = sem referências). */
  maxReferences: z.number().int().min(0).max(16).default(16),
  /** Nome do campo multipart: `image[]` (exemplos oficiais) ou `image` (schema). */
  multipartField: z.enum(["image[]", "image"]).default("image[]"),
  supportsMask: z.boolean().default(true),
  /** Hosts dos quais baixar imagens quando o serviço responde com URL. */
  allowedDownloadHosts: z.array(z.string()).default([]),
  /** Preço por imagem informado pelo operador; sem ele o custo é desconhecido. */
  pricePerImage: CostAmount.nullable().default(null),
  timeoutMs: z.number().int().positive().default(180_000),
});

export const OpenRouterConfig = z.strictObject({
  provider: z.strictObject({ only: z.array(z.string()).optional(), allow_fallbacks: z.boolean().optional() }).optional(),
  resolution: z.enum(["512", "768", "1K", "1.5K", "2K", "4K"]).optional(),
  quality: z.enum(["auto", "low", "medium", "high"]).optional(),
  /**
   * Alfa nativo da rota. `single_reference`: só com exatamente uma referência
   * (Seedream 5.0 Flash); nos demais pedidos o plano usa fundo de cor-chave.
   */
  transparent: z.union([z.boolean(), z.literal("single_reference")]).default(false),
  /** `supported_parameters.input_references.max` do endpoint escolhido. */
  maxReferences: z.number().int().min(0).max(16).default(0),
  aspectRatio: z.string().regex(/^(auto|\d+(\.\d+)?:\d+(\.\d+)?)$/).optional(),
  /** Preço por imagem gerada lido do catálogo da rota (USD). */
  pricePerImageUsd: z.number().nonnegative().optional(),
  timeoutMs: z.number().int().positive().default(180_000),
});

export const PixelLabConfig = z.strictObject({
  pollIntervalMs: z.number().int().min(200).default(5_000),
  timeoutMs: z.number().int().positive().default(60_000),
  preferHighTopDown: z.boolean().default(false),
});

const OPENAI_BILLING_CODES = [
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
];

function host(baseUrl: string): string {
  return checkBaseUrl(baseUrl).host;
}

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function unknownCost(reason: string): CostEstimate {
  return { kind: "unknown", reason };
}

function noPolling(): never {
  throw new ProviderError("rejected", "Este transporte responde de forma síncrona; não há job remoto a consultar");
}

// ---------------------------------------------------------------------------
// API customizada com contrato OpenAI Images
// ---------------------------------------------------------------------------

export class OpenAIImagesAdapter implements ProviderAdapter {
  readonly transport = "openai_images" as const;
  readonly idempotentSubmit = false;
  readonly pollIntervalMs = 0;
  /** `/images/edits`: alfa 0 marca a região editável (a convenção interna é convertida, não reinterpretada). */
  readonly maskEncoding = "alpha_zero_edits" as const;
  private readonly config: z.infer<typeof OpenAIImagesConfig>;

  constructor(
    private readonly profile: AdapterProfile,
    config: unknown,
  ) {
    this.config = OpenAIImagesConfig.parse(config ?? {});
    if (!profile.model) throw new DomainFailure("validation_failed", "Perfil OpenAI Images exige o ID do modelo");
    checkBaseUrl(profile.baseUrl);
  }

  capabilities(operation: PlanOperation): Capability[] {
    if (operation === "generate_asset") {
      return [
        "text_to_image",
        ...(this.config.maxReferences > 0 ? (["image_references", "image_edit"] as const) : []),
        ...(this.config.transparent ? (["alpha_output"] as const) : []),
      ];
    }
    if (operation === "inpaint") return this.config.supportsMask ? ["image_edit", "native_mask"] : ["image_edit"];
    return [];
  }

  limits(operation: PlanOperation) {
    return operation === "generate_asset" || operation === "inpaint" ? { maxReferences: this.config.maxReferences } : {};
  }

  estimate(_operation: PlanOperation, parts: number): CostEstimate {
    const price = this.config.pricePerImage;
    return price
      ? { kind: "known", amount: { amount: price.amount * parts, unit: price.unit }, basis: `${parts} imagem(ns) × preço informado no perfil` }
      : unknownCost("A API informa uso em tokens, sem preço; cadastre o preço por imagem no perfil para estimar");
  }

  async submit(req: ProviderSubmitRequest, signal: AbortSignal): Promise<SubmitOutcome> {
    const auth = { authorization: `Bearer ${resolveSecret(this.profile.secretRef)}` };
    const common = { allowedHost: host(this.profile.baseUrl), signal, timeoutMs: this.config.timeoutMs };
    const params = req.params as { transparent?: boolean };
    const options = {
      model: this.profile.model!,
      size: this.config.size,
      output_format: "png",
      ...(this.config.quality ? { quality: this.config.quality } : {}),
      ...(params.transparent && this.config.transparent ? { background: "transparent" } : {}),
    };

    let res;
    if (req.operation === "generate_asset" && req.references.length === 0) {
      res = await providerFetch(join(this.profile.baseUrl, "images/generations"), {
        ...common,
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ ...options, prompt: req.prompt, n: 1 }),
      });
    } else if (req.operation === "generate_asset" || req.operation === "inpaint") {
      const images = req.operation === "inpaint" ? req.references.filter((r) => r.role === "source") : req.references;
      if (images.length === 0 || images.length > Math.max(1, this.config.maxReferences)) {
        throw new DomainFailure("capability_missing", `O perfil aceita até ${this.config.maxReferences} imagens de entrada`);
      }
      const form = new FormData();
      // A ordem das partes é a ordem das referências; a primeira é a base.
      for (const [i, ref] of images.entries()) form.append(this.config.multipartField, new Blob([Buffer.from(ref.bytes)], { type: ref.mime }), `ref-${i}.png`);
      if (req.operation === "inpaint") {
        // Máscara já codificada para este transporte: alfa 0 = área editável (alfa = 255 − E).
        const mask = req.references.find((r) => r.role === "remote_mask");
        if (!mask) throw new DomainFailure("validation_failed", "Inpainting OpenAI exige a máscara codificada como alfa (papel remote_mask)");
        form.append("mask", new Blob([Buffer.from(mask.bytes)], { type: "image/png" }), "mask.png");
      }
      form.append("prompt", req.prompt);
      for (const [k, v] of Object.entries(options)) form.append(k, String(v));
      form.append("n", "1");
      res = await providerFetch(join(this.profile.baseUrl, "images/edits"), { ...common, method: "POST", headers: auth, body: form });
    } else {
      throw new DomainFailure("capability_missing", `Operação ${req.operation} não suportada pela API OpenAI Images`);
    }
    failOnStatus(res, { billingCodes: OPENAI_BILLING_CODES });
    const body = res.json<{ data?: { b64_json?: string; url?: string }[] }>();
    const images: ProviderImage[] = [];
    for (const item of body.data ?? []) {
      if (item.b64_json) images.push(decodeImage(item.b64_json));
      else if (item.url) images.push(await this.download(item.url, signal));
    }
    if (images.length === 0) throw new ProviderError("rejected", "A resposta não trouxe imagem (possível recusa ou resposta só com texto)");
    const price = this.config.pricePerImage;
    return { kind: "sync", images, cost: price ? { amount: price.amount * images.length, unit: price.unit } : null };
  }

  /** URL de resultado: só de host autorizado, sem repassar a credencial. */
  private async download(url: string, signal: AbortSignal): Promise<ProviderImage> {
    let target: URL;
    try {
      target = checkBaseUrl(url); // https, ou http só em loopback
    } catch {
      throw new ProviderError("rejected", `URL de resultado insegura: ${url.slice(0, 80)}`);
    }
    if (!this.config.allowedDownloadHosts.includes(target.host)) {
      throw new ProviderError("rejected", `Resposta aponta para host não autorizado para download: ${target.host}`);
    }
    const res = await providerFetch(url, { allowedHost: target.host, signal, timeoutMs: this.config.timeoutMs });
    failOnStatus(res);
    return decodeImage(Buffer.from(res.bytes).toString("base64"));
  }

  poll(): Promise<RemoteStatus> {
    return Promise.resolve(noPolling());
  }

  fetchResult(): Promise<ProviderResult> {
    return Promise.resolve(noPolling());
  }
}

// ---------------------------------------------------------------------------
// OpenRouter Images
// ---------------------------------------------------------------------------

/** Proporção reduzida, ex.: [128, 96] → "4:3". */
function ratio([w, h]: [number, number]): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly transport = "openrouter_images" as const;
  readonly idempotentSubmit = false;
  readonly pollIntervalMs = 0;
  private readonly config: z.infer<typeof OpenRouterConfig>;

  constructor(
    private readonly profile: AdapterProfile,
    config: unknown,
  ) {
    this.config = OpenRouterConfig.parse(config ?? {});
    if (!profile.model) throw new DomainFailure("validation_failed", "Perfil OpenRouter exige o ID do modelo");
    checkBaseUrl(profile.baseUrl);
  }

  capabilities(operation: PlanOperation): Capability[] {
    // Referência visual ≠ máscara nativa: com fonte + guia como referências, só "candidata + composição local".
    if (operation === "inpaint") return this.config.maxReferences >= 2 ? ["image_edit"] : [];
    // Animação e vistas (S1): só imagem + referências — o modelo desenha uma folha de quadros ou uma vista.
    // Nunca declara animação por texto, esqueleto (keypoints) ou rotação nativos.
    if (SHEET_OPERATIONS.includes(operation)) return this.config.maxReferences >= 1 ? ["text_to_image", "image_references"] : [];
    // Mundo (T1): material e tileset guiado pelo gabarito; nunca tileset/isométrico nativo.
    if (isWorldOperation(operation)) return genericWorldCapabilities(operation, this.config.maxReferences);
    if (operation !== "generate_asset") return [];
    return [
      "text_to_image",
      ...(this.config.maxReferences > 0 ? (["image_references"] as const) : []),
      ...(this.config.transparent ? (["alpha_output"] as const) : []),
    ];
  }

  limits(operation: PlanOperation) {
    if (operation === "inpaint") return { maxReferences: this.config.maxReferences };
    if (SHEET_OPERATIONS.includes(operation)) return { maxReferences: this.config.maxReferences, ...(this.config.transparent === "single_reference" ? { alphaReferences: 1 } : {}) };
    if (isWorldOperation(operation)) return { maxReferences: this.config.maxReferences };
    if (operation !== "generate_asset") return {};
    return { maxReferences: this.config.maxReferences, ...(this.config.transparent === "single_reference" ? { alphaReferences: 1 } : {}) };
  }

  estimate(_operation: PlanOperation, parts: number): CostEstimate {
    const price = this.config.pricePerImageUsd;
    return price !== undefined
      ? { kind: "known", amount: { amount: Math.round(price * parts * 1e6) / 1e6, unit: "USD" }, basis: `${parts} imagem(ns) × US$ ${price} (catálogo da rota)` }
      : unknownCost("Preço da rota não registrado no perfil; o custo real vem em usage.cost");
  }

  async submit(req: ProviderSubmitRequest, signal: AbortSignal): Promise<SubmitOutcome> {
    if (req.operation !== "generate_asset" && req.operation !== "inpaint" && !SHEET_OPERATIONS.includes(req.operation) && !isWorldOperation(req.operation)) {
      throw new DomainFailure("capability_missing", `Operação ${req.operation} não suportada pelo OpenRouter`);
    }
    if (req.references.length > this.config.maxReferences) {
      throw new DomainFailure("capability_missing", `A rota aceita até ${this.config.maxReferences} referências; o pedido tem ${req.references.length}`);
    }
    const params = req.params as { transparent?: boolean; backgroundKey?: string | null; logicalSize?: [number, number] };
    // Com cor-chave no plano, o fundo vem pintado e é removido localmente: não pede alfa.
    const sheet = (req.params as { sheet?: ReferenceSheet }).sheet;
    const sheetAlpha = Boolean(sheet && sheet.backgroundKey === null && (this.config.transparent === true || (this.config.transparent === "single_reference" && req.references.length === 1)));
    const alpha = (req.operation === "generate_asset" && Boolean(params.transparent && !params.backgroundKey && this.config.transparent)) || sheetAlpha;
    // Candidato de edição precisa do mesmo canvas da fonte: proporção da fonte, não a do perfil.
    // Folha de quadros: proporção da grade declarada no plano (colunas × célula : linhas × célula).
    const aspect = sheet
      ? ratio([sheet.columns * sheet.cell[0], sheet.rows * sheet.cell[1]])
      : req.operation === "inpaint" && params.logicalSize
        ? ratio(params.logicalSize)
        : worldCanvas(req) // T1: canvas do atlas do gabarito ou do material
          ? ratio(worldCanvas(req)!)
          : this.config.aspectRatio;
    const res = await providerFetch(join(this.profile.baseUrl, "images"), {
      allowedHost: host(this.profile.baseUrl),
      signal,
      timeoutMs: this.config.timeoutMs,
      method: "POST",
      headers: { authorization: `Bearer ${resolveSecret(this.profile.secretRef)}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.profile.model,
        prompt: req.prompt,
        n: 1,
        output_format: "png",
        ...(alpha ? { background: "transparent" } : {}),
        // T1: material e atlas vão de borda a borda; rota com alfa às vezes devolve fundo transparente se não for pedido opaco.
        ...(!alpha && isWorldOperation(req.operation) && this.config.transparent ? { background: "opaque" } : {}),
        ...(this.config.resolution ? { resolution: this.config.resolution } : {}),
        ...(aspect ? { aspect_ratio: aspect } : {}),
        ...(this.config.quality ? { quality: this.config.quality } : {}),
        ...(this.config.provider ? { provider: this.config.provider } : {}),
        ...(req.references.length
          ? { input_references: req.references.map((r) => ({ type: "image_url", image_url: { url: toDataUrl(r.bytes, r.mime) } })) }
          : {}),
      }),
    });
    failOnStatus(res);
    const body = res.json<{ data?: { b64_json?: string }[]; usage?: { cost?: number | null } }>();
    const images = (body.data ?? []).filter((d) => d.b64_json).map((d) => decodeImage(d.b64_json!));
    if (images.length === 0) throw new ProviderError("rejected", "A resposta não trouxe imagem");
    const cost = typeof body.usage?.cost === "number" ? { amount: body.usage.cost, unit: "USD" } : null;
    return { kind: "sync", images, cost };
  }

  poll(): Promise<RemoteStatus> {
    return Promise.resolve(noPolling());
  }

  fetchResult(): Promise<ProviderResult> {
    return Promise.resolve(noPolling());
  }

  /** Descoberta gratuita: limites e preço da rota do modelo (sem credencial). */
  async discover(signal: AbortSignal) {
    const res = await providerFetch(join(this.profile.baseUrl, `images/models/${this.profile.model}/endpoints`), {
      allowedHost: host(this.profile.baseUrl),
      signal,
      timeoutMs: 30_000,
    });
    failOnStatus(res);
    const body = res.json<{
      endpoints?: { provider_tag: string | null; supported_parameters?: Record<string, { type: string; max?: number; values?: string[] }>; pricing?: unknown[] }[];
    }>();
    return (body.endpoints ?? []).map((e) => ({
      providerTag: e.provider_tag,
      maxReferences: e.supported_parameters?.input_references?.max ?? 0,
      transparent: e.supported_parameters?.background?.values?.includes("transparent") ?? false,
      pricing: e.pricing ?? [],
    }));
  }
}

// ---------------------------------------------------------------------------
// PixelLab REST v2 (especializado, assíncrono)
// ---------------------------------------------------------------------------

interface PixelLabUsage {
  type?: "usd" | "generations";
  usd?: number | null;
  generations?: number | null;
}

function pixelLabCost(usage: PixelLabUsage | null | undefined) {
  if (!usage) return null;
  if (usage.type === "generations" && typeof usage.generations === "number") return { amount: usage.generations, unit: "generations" };
  if (typeof usage.usd === "number") return { amount: usage.usd, unit: "USD" };
  return null;
}

export class PixelLabAdapter implements ProviderAdapter {
  readonly transport = "pixellab_rest_v2" as const;
  /** Sem chave de idempotência nem listagem de jobs: POST perdido é irreconciliável. */
  readonly idempotentSubmit = false;
  readonly pollIntervalMs: number;
  private readonly config: z.infer<typeof PixelLabConfig>;

  constructor(
    private readonly profile: AdapterProfile,
    config: unknown,
  ) {
    this.config = PixelLabConfig.parse(config ?? {});
    this.pollIntervalMs = this.config.pollIntervalMs;
    checkBaseUrl(profile.baseUrl);
  }

  capabilities(operation: PlanOperation): Capability[] {
    switch (operation) {
      case "generate_asset":
        return ["text_to_image", "alpha_output", "seed"];
      case "inpaint":
        return ["image_edit", "native_mask", "seed"];
      case "animate_skeleton":
        return ["skeleton_keypoints", "custom_skeleton", "seed"];
      case "animate_text":
        return ["text_animation", "seed"];
      case "animate_preset":
        return ["text_animation", "skeleton_keypoints", "custom_skeleton", "seed"];
      case "rotate_views":
        // `/rotate`: uma direção por chamada, origem e destino explícitos, flag `isometric` documentada.
        return ["rotation_4", "rotation_8", "isometric_views", "image_references", "seed"];
      default:
        return [];
    }
  }

  estimate(): CostEstimate {
    return unknownCost("O PixelLab informa o custo real (USD ou gerações da assinatura) só no job concluído");
  }

  /** Um job do `/generate-image-v2` já devolve várias candidatas (até 64 conforme o tamanho). */
  submissionsFor(): number {
    return 1;
  }

  private request(path: string, signal: AbortSignal, init: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}) {
    return providerFetch(join(this.profile.baseUrl, path), {
      allowedHost: host(this.profile.baseUrl),
      signal,
      timeoutMs: this.config.timeoutMs,
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${resolveSecret(this.profile.secretRef)}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  async submit(req: ProviderSubmitRequest, signal: AbortSignal): Promise<SubmitOutcome> {
    let path: string;
    let body: unknown;
    if (req.operation === "generate_asset") {
      const params = req.params as { logicalSize: [number, number]; transparent: boolean; seed?: number };
      const [w, h] = params.logicalSize;
      if (w < 16 || h < 16 || w > 792 || h > 688) throw new DomainFailure("capability_missing", "/generate-image-v2 aceita 16–792 × 16–688 px");
      path = "generate-image-v2";
      body = { description: req.prompt, image_size: { width: w, height: h }, no_background: params.transparent, ...(params.seed !== undefined ? { seed: params.seed } : {}) };
    } else if (req.operation === "inpaint") {
      const source = req.references.find((r) => r.role === "source");
      const mask = req.references.find((r) => r.role === "edit_mask");
      if (!source || !mask) throw new DomainFailure("validation_failed", "Inpainting exige fonte e máscara de edição");
      const s = readPngInfo(source.bytes);
      const m = readPngInfo(mask.bytes);
      if (!s || !m) throw new DomainFailure("validation_failed", "Fonte e máscara precisam ser PNG");
      path = "inpaint-v3";
      body = pixelLabInpaintBody({ description: req.prompt, source: { bytes: source.bytes, width: s.width, height: s.height }, editMask: { bytes: mask.bytes, width: m.width, height: m.height } });
    } else if (req.operation === "animate_skeleton" || (req.operation === "animate_preset" && (req.params as { mode?: string }).mode === "skeleton")) {
      const first = req.references.find((r) => r.role === "base");
      // Movimento congelado: nos parâmetros ou como referência de dados (papel `motion`, JSON) montada pelo pipeline.
      const motion = (req.params as { motion?: MotionPayload }).motion ?? motionReference(req.references);
      if (!first || !motion) throw new DomainFailure("validation_failed", "Esqueleto exige o quadro-base e a revisão de movimento");
      path = "animate-with-skeleton-v3";
      body = pixelLabSkeletonBody({ description: req.prompt, firstFrame: first.bytes, motion, preferHighTopDown: this.config.preferHighTopDown });
    } else if (req.operation === "animate_text" || req.operation === "animate_preset") {
      const first = req.references.find((r) => r.role === "base");
      const info = first ? readPngInfo(first.bytes) : null;
      if (!first || !info) throw new DomainFailure("validation_failed", "Texto v3 exige o quadro-base em PNG");
      const durations = (req.params as { durationsMs: number[] }).durationsMs;
      path = "animate-with-text-v3";
      body = pixelLabTextAnimationBody({ action: req.prompt, firstFrame: first.bytes, size: [info.width, info.height], frames: durations.length });
    } else if (req.operation === "rotate_views") {
      const source = req.references.find((r) => r.role === "source");
      const info = source ? readPngInfo(source.bytes) : null;
      const params = req.params as { requestedViews: Direction[]; sourceView?: Direction; projection: ProjectionKind };
      if (!source || !info || !params.sourceView || params.requestedViews.length !== 1) {
        throw new DomainFailure("validation_failed", "/rotate exige a vista de origem e exatamente uma direção pedida por envio");
      }
      const rotate = pixelLabRotateBody({
        source: source.bytes,
        size: [info.width, info.height],
        from: params.sourceView,
        to: params.requestedViews[0]!,
        projection: params.projection,
        preferHighTopDown: this.config.preferHighTopDown,
      });
      // `/rotate` é síncrono: a imagem vem na própria resposta (sem job remoto a consultar).
      const res = await this.request("rotate", signal, { method: "POST", body: rotate });
      failOnStatus(res);
      const out = res.json<{ image?: { base64?: string }; usage?: PixelLabUsage | null }>();
      if (!out.image?.base64) throw new ProviderError("rejected", "Resposta do /rotate sem imagem");
      return { kind: "sync", images: [decodeImage(out.image.base64)], cost: pixelLabCost(out.usage) };
    } else {
      throw new DomainFailure("capability_missing", `Operação ${req.operation} ainda não mapeada para o PixelLab`);
    }
    const res = await this.request(path, signal, { method: "POST", body });
    failOnStatus(res);
    const accepted = res.json<{ background_job_id?: string }>();
    if (!accepted.background_job_id) throw new ProviderError("ambiguous", "Resposta sem background_job_id: o pedido pode ter sido aceito");
    return { kind: "async", remoteId: accepted.background_job_id };
  }

  async poll(remoteId: string, signal: AbortSignal): Promise<RemoteStatus> {
    const res = await this.request(`background-jobs/${encodeURIComponent(remoteId)}`, signal);
    failOnStatus(res);
    const job = res.json<{ status?: string; last_response?: { queue_position?: number; error?: string; message?: string } | null }>();
    if (job.status === "completed") return { state: "succeeded" };
    if (job.status === "failed") return { state: "failed", message: job.last_response?.error ?? job.last_response?.message ?? "O job remoto falhou" };
    return { state: "pending" };
  }

  async fetchResult(remoteId: string, signal: AbortSignal): Promise<ProviderResult> {
    const res = await this.request(`background-jobs/${encodeURIComponent(remoteId)}`, signal);
    failOnStatus(res);
    const job = res.json<{ status?: string; usage?: PixelLabUsage | null; last_response?: Record<string, unknown> | null }>();
    if (job.status !== "completed") throw new ProviderError("unavailable", `Job remoto ainda em ${job.status ?? "estado desconhecido"}`);
    const last = job.last_response ?? {};
    // Formato do resultado não tipado no OpenAPI: aceitar `images[]`, `frames[]` ou `image`.
    const raw = [last.images, last.frames, last.image ? [last.image] : undefined].find((v): v is unknown[] => Array.isArray(v)) ?? [];
    const images = raw
      .map((item) => (typeof item === "string" ? item : (item as { base64?: string })?.base64))
      .filter((b): b is string => typeof b === "string")
      .map(decodeImage);
    if (images.length === 0) throw new ProviderError("rejected", "Job concluído sem imagens reconhecíveis em last_response");
    return { images, cost: pixelLabCost(job.usage) };
  }

  async cancel(remoteId: string): Promise<void> {
    const res = await this.request(`background-jobs/${encodeURIComponent(remoteId)}`, new AbortController().signal, { method: "DELETE" });
    if (res.status !== 400 && res.status !== 409) failOnStatus(res);
  }

  /** Saldo (gratuito): créditos em USD e gerações da assinatura, separados. */
  async balance(signal: AbortSignal) {
    const res = await this.request("balance", signal);
    failOnStatus(res);
    return res.json<{ credits: { usd: number }; subscription: { status: string; plan?: string | null; generations: number; total: number } }>();
  }
}

/** Operações de animação/vistas que uma rota genérica atende só como folha desenhada por imagem + referências. */
const SHEET_OPERATIONS: PlanOperation[] = ["animate_preset", "animate_text", "animate_skeleton", "rotate_views"];

/** Movimento enviado pelo pipeline como referência de dados (JSON), sem passar pelo prompt. */
function motionReference(references: ProviderSubmitRequest["references"]): MotionPayload | undefined {
  const ref = references.find((r) => r.role === "motion" && r.mime === "application/json");
  return ref ? (JSON.parse(new TextDecoder().decode(ref.bytes)) as MotionPayload) : undefined;
}
