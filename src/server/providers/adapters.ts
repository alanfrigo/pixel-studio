import { type TextValue, tx } from "@/i18n/locales";
import { z } from "zod";
import { type Capability, CostAmount, type CostEstimate, type PlanOperation } from "@/contracts";
import { DomainFailure } from "../errors";
import { checkBaseUrl, decodeImage, failOnStatus, providerFetch, resolveSecret, toDataUrl } from "./http";
import { ProviderError, type ProviderAdapter, type ProviderImage, type ProviderResult, type ProviderSubmitRequest, type RemoteStatus, type SubmitOutcome } from "./types";
import { type GenericRoute, genericCanvas, genericCapabilities, genericLimits, genericSupports, genericWantsAlpha, genericWantsOpaque, ratio } from "./generic-route";

/**
 * Adaptadores reais (03 §integrações): API customizada com contrato OpenAI
 * Images e OpenRouter Images (o Codex CLI local fica em `codex-cli.ts`). Capacidades declaradas por
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

function unknownCost(reason: TextValue): CostEstimate {
  return { kind: "unknown", reason };
}

function noPolling(): never {
  throw new ProviderError("rejected", tx("Este transporte responde de forma síncrona; não há job remoto a consultar", "This transport responds synchronously; there is no remote job to poll"));
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
    if (!profile.model) throw new DomainFailure("validation_failed", tx("Perfil OpenAI Images exige o ID do modelo", "An OpenAI Images profile requires the model ID"));
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
      ? { kind: "known", amount: { amount: price.amount * parts, unit: price.unit }, basis: tx(`${parts} imagem(ns) × preço informado no perfil`, `${parts} image(s) × price set in the profile`) }
      : unknownCost(tx("A API informa uso em tokens, sem preço; cadastre o preço por imagem no perfil para estimar", "The API reports usage in tokens, without a price; set the per-image price in the profile to get an estimate"));
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
        throw new DomainFailure("capability_missing", tx(`O perfil aceita até ${this.config.maxReferences} imagens de entrada`, `The provider profile accepts up to ${this.config.maxReferences} input images`));
      }
      const form = new FormData();
      // A ordem das partes é a ordem das referências; a primeira é a base.
      for (const [i, ref] of images.entries()) form.append(this.config.multipartField, new Blob([Buffer.from(ref.bytes)], { type: ref.mime }), `ref-${i}.png`);
      if (req.operation === "inpaint") {
        // Máscara já codificada para este transporte: alfa 0 = área editável (alfa = 255 − E).
        const mask = req.references.find((r) => r.role === "remote_mask");
        if (!mask) throw new DomainFailure("validation_failed", tx("Inpainting OpenAI exige a máscara codificada como alfa (papel remote_mask)", "OpenAI inpainting requires the mask encoded as alpha (remote_mask role)"));
        form.append("mask", new Blob([Buffer.from(mask.bytes)], { type: "image/png" }), "mask.png");
      }
      form.append("prompt", req.prompt);
      for (const [k, v] of Object.entries(options)) form.append(k, String(v));
      form.append("n", "1");
      res = await providerFetch(join(this.profile.baseUrl, "images/edits"), { ...common, method: "POST", headers: auth, body: form });
    } else {
      throw new DomainFailure("capability_missing", tx(`Operação ${req.operation} não suportada pela API OpenAI Images`, `Operation ${req.operation} is not supported by the OpenAI Images API`));
    }
    failOnStatus(res, { billingCodes: OPENAI_BILLING_CODES });
    const body = res.json<{ data?: { b64_json?: string; url?: string }[] }>();
    const images: ProviderImage[] = [];
    for (const item of body.data ?? []) {
      if (item.b64_json) images.push(decodeImage(item.b64_json));
      else if (item.url) images.push(await this.download(item.url, signal));
    }
    if (images.length === 0) throw new ProviderError("rejected", tx("A resposta não trouxe imagem (possível recusa ou resposta só com texto)", "The response contained no image (possible refusal or a text-only response)"));
    const price = this.config.pricePerImage;
    return { kind: "sync", images, cost: price ? { amount: price.amount * images.length, unit: price.unit } : null };
  }

  /** URL de resultado: só de host autorizado, sem repassar a credencial. */
  private async download(url: string, signal: AbortSignal): Promise<ProviderImage> {
    let target: URL;
    try {
      target = checkBaseUrl(url); // https, ou http só em loopback
    } catch {
      throw new ProviderError("rejected", tx(`URL de resultado insegura: ${url.slice(0, 80)}`, `Unsafe result URL: ${url.slice(0, 80)}`));
    }
    if (!this.config.allowedDownloadHosts.includes(target.host)) {
      throw new ProviderError("rejected", tx(`Resposta aponta para host não autorizado para download: ${target.host}`, `Response points to a host not allowed for download: ${target.host}`));
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

// Defaults for the two reference routes qualified in MODELS.md. Explicit route
// or limit settings and custom endpoints keep their existing configuration.
const knownOpenRouterRoutes: Record<string, z.input<typeof OpenRouterConfig>> = {
  "google/gemini-3.1-flash-image": { maxReferences: 14, provider: { only: ["google-vertex/us"], allow_fallbacks: false } },
  "openai/gpt-image-2.6-flare": { maxReferences: 16, transparent: true, provider: { only: ["openai"], allow_fallbacks: false } },
};

export class OpenRouterAdapter implements ProviderAdapter {
  readonly transport = "openrouter_images" as const;
  readonly idempotentSubmit = false;
  readonly pollIntervalMs = 0;
  private readonly config: z.infer<typeof OpenRouterConfig>;
  private readonly route: GenericRoute;

  constructor(
    private readonly profile: AdapterProfile,
    config: unknown,
  ) {
    if (!profile.model) throw new DomainFailure("validation_failed", tx("Perfil OpenRouter exige o ID do modelo", "An OpenRouter profile requires the model ID"));
    const endpoint = checkBaseUrl(profile.baseUrl);
    const preset = endpoint.origin === "https://openrouter.ai" ? knownOpenRouterRoutes[profile.model] : undefined;
    const input = config ?? {};
    this.config = OpenRouterConfig.parse(preset && typeof input === "object" && !Array.isArray(input) && !("provider" in input) && !("maxReferences" in input)
      ? { ...preset, ...input }
      : input);
    this.route = { maxReferences: this.config.maxReferences, transparent: this.config.transparent };
  }

  capabilities(operation: PlanOperation): Capability[] {
    return genericCapabilities(operation, this.route);
  }

  limits(operation: PlanOperation) {
    return genericLimits(operation, this.route);
  }

  estimate(_operation: PlanOperation, parts: number): CostEstimate {
    const price = this.config.pricePerImageUsd;
    return price !== undefined
      ? { kind: "known", amount: { amount: Math.round(price * parts * 1e6) / 1e6, unit: "USD" }, basis: tx(`${parts} imagem(ns) × US$ ${price} (catálogo da rota)`, `${parts} image(s) × US$ ${price} (route catalog)`) }
      : unknownCost(tx("O provedor informa o valor depois de gerar", "The provider reports the charge after generating"));
  }

  async submit(req: ProviderSubmitRequest, signal: AbortSignal): Promise<SubmitOutcome> {
    if (!genericSupports(req.operation)) {
      throw new DomainFailure("capability_missing", tx(`Operação ${req.operation} não suportada pelo OpenRouter`, `Operation ${req.operation} is not supported by OpenRouter`));
    }
    if (req.references.length > this.config.maxReferences) {
      throw new DomainFailure("capability_missing", tx(`A rota aceita até ${this.config.maxReferences} referências; o pedido tem ${req.references.length}`, `The route accepts up to ${this.config.maxReferences} references; the request has ${req.references.length}`));
    }
    const alpha = genericWantsAlpha(req, this.route);
    // Proporção do canvas fixado pelo plano (folha, fonte do candidato, atlas, cena, tira); senão a do perfil.
    const canvas = genericCanvas(req);
    const aspect = canvas ? ratio(canvas) : this.config.aspectRatio;
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
        ...(genericWantsOpaque(req, alpha, this.route) ? { background: "opaque" } : {}),
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
    if (images.length === 0) throw new ProviderError("rejected", tx("A resposta não trouxe imagem", "The response contained no image"));
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
