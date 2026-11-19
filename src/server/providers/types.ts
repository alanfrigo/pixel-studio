import type { TextValue } from "@/i18n/locales";
import type { Capability, CostAmount, CostEstimate, PlanOperation, ProviderTransport } from "@/contracts";

/**
 * Contrato dos adaptadores de geração (03 §contrato lógico do worker). O
 * worker grava a intenção de envio ANTES de `submit`, o ID remoto logo após o
 * aceite e a resposta bruta assim que `fetchResult` devolve bytes. HTTP 200
 * com job remoto não significa mídia pronta.
 */

export interface ProviderSubmitRequest {
  /** Chave estável por parte; adaptadores com idempotência remota a repassam ao provedor. */
  idempotencyKey: string;
  operation: PlanOperation;
  prompt: string;
  params: Record<string, unknown>;
  /** Referências ordenadas já resolvidas em bytes verificados. */
  references: { role: string; mime: string; bytes: Uint8Array }[];
}

export type RemoteStatus =
  | { state: "pending"; progress?: number }
  | { state: "succeeded" }
  | { state: "failed"; message: TextValue };

export interface ProviderImage {
  bytes: Uint8Array;
  mime: string;
}

/** Resultado de uma parte: uma ou mais imagens (o provedor pode devolver menos ou mais que o pedido). */
export interface ProviderResult {
  images: ProviderImage[];
  /** Custo informado pelo provedor, com unidade; `null` = desconhecido. */
  cost: CostAmount | null;
}

/**
 * Envio aceito: job remoto a consultar (assíncrono) ou imagens na própria
 * resposta (síncrono, sem ID remoto — salvar imediatamente).
 */
export type SubmitOutcome = { kind: "async"; remoteId: string } | ({ kind: "sync" } & ProviderResult);

export interface ProviderAdapter {
  readonly transport: ProviderTransport | "simulated";
  /** O provedor deduplica pela chave: reenviar após falha ambígua é seguro. */
  readonly idempotentSubmit: boolean;
  /** Intervalo sugerido entre consultas. */
  readonly pollIntervalMs: number;
  /** Como a máscara de inpainting nativo vai ao provedor (padrão: branco edita, preto preserva). */
  readonly maskEncoding?: "white_edits_black_preserves" | "alpha_zero_edits";
  /** Capacidades declaradas por operação (testadas ficam na matriz do perfil). */
  capabilities(operation: PlanOperation): Capability[];
  estimate(operation: PlanOperation, parts: number): CostEstimate;
  /** Limites declarados por operação (ex.: máximo de referências), conferidos antes de cobrar. */
  limits?(operation: PlanOperation): { maxReferences?: number; /** Alfa nativo só com exatamente N referências. */ alphaReferences?: number };
  /** Quantos envios produzem `variants` candidatas (há provedores que devolvem várias por job). Padrão: um por variante. */
  submissionsFor?(operation: PlanOperation, variants: number): number;
  submit(request: ProviderSubmitRequest, signal: AbortSignal): Promise<SubmitOutcome>;
  poll(remoteId: string, signal: AbortSignal): Promise<RemoteStatus>;
  fetchResult(remoteId: string, signal: AbortSignal): Promise<ProviderResult>;
  cancel?(remoteId: string): Promise<void>;
}

/**
 * Falha de provedor classificada. `not_accepted` = comprovadamente antes da
 * aceitação (pode retentar); `ambiguous` = pode ter sido aceito e cobrado.
 */
export class ProviderError extends Error {
  /** Texto bilíngue quando a mensagem é nossa; texto cru (como veio do provedor) fica string. `Error.message` é o português. */
  readonly text: TextValue;

  constructor(
    readonly kind: "not_accepted" | "ambiguous" | "auth" | "balance" | "rejected" | "rate_limited" | "unavailable",
    message: TextValue,
    readonly retryAfterMs?: number,
  ) {
    super(typeof message === "string" ? message : message["pt-BR"]);
    this.text = message;
    this.name = "ProviderError";
  }
}
