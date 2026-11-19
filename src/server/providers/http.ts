import { tx } from "@/i18n/locales";
import { DomainFailure } from "../errors";
import { sniff } from "../media/inspect";
import { ProviderError, type ProviderImage } from "./types";

/**
 * Cliente HTTP dos adaptadores (03 §credenciais e arquivos):
 * - fala só com o host cadastrado no perfil (nem o modelo, nem uma URL de
 *   resposta redirecionam a chamada autenticada);
 * - recusa redirecionamentos; aplica prazo e limite de bytes;
 * - classifica falhas: antes de conectar = `not_accepted` (retentável sem
 *   custo); depois de enviar = `ambiguous` (pode ter sido cobrado).
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "ERR_TLS_CERT_ALTNAME_INVALID"]);

export interface HttpOptions {
  /** Host autorizado (inclui porta quando houver). */
  allowedHost: string;
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: string | FormData;
  signal: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  json<T = unknown>(): T;
}

/** Base aceita: https, ou http apenas em loopback (API customizada local explicitamente cadastrada). */
export function checkBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DomainFailure("validation_failed", tx(`URL base inválida: ${baseUrl}`, `Invalid base URL: ${baseUrl}`));
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  throw new DomainFailure("validation_failed", tx("A URL base precisa usar https (http só para um servidor no próprio computador)", "The base URL must use https (http only for a server on this computer)"));
}

function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (err as { code?: string })?.code;
}

export async function providerFetch(url: string, opts: HttpOptions): Promise<HttpResponse> {
  const target = new URL(url);
  if (target.host !== opts.allowedHost) {
    throw new DomainFailure("validation_failed", tx(`Destino ${target.host} não é o host autorizado do perfil (${opts.allowedHost})`, `Destination ${target.host} is not the profile's allowed host (${opts.allowedHost})`));
  }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const signal = AbortSignal.any([opts.signal, timeout]);
  let res: Response;
  try {
    res = await fetch(target, { method: opts.method ?? "GET", headers: opts.headers, body: opts.body, signal, redirect: "manual" });
  } catch (err) {
    if (opts.signal.aborted) throw opts.signal.reason;
    if (timeout.aborted) throw new ProviderError("ambiguous", tx("Sem resposta do provedor dentro do prazo", "No response from the provider within the time limit"));
    const code = errorCode(err);
    if (code && NOT_SENT_CODES.has(code)) throw new ProviderError("not_accepted", tx(`Não foi possível conectar ao provedor (${code})`, `Could not connect to the provider (${code})`));
    throw new ProviderError("ambiguous", tx(`Conexão interrompida com o provedor${code ? ` (${code})` : ""}`, `Connection to the provider was interrupted${code ? ` (${code})` : ""}`));
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ProviderError("rejected", tx(`Redirecionamento recusado (${res.status} → ${res.headers.get("location") ?? "?"})`, `Redirect refused (${res.status} → ${res.headers.get("location") ?? "?"})`));
  }
  const max = opts.maxBytes ?? 64 * 1024 * 1024;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new ProviderError("rejected", tx(`Resposta de ${declared} bytes excede o limite`, `Response of ${declared} bytes exceeds the limit`));
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      total += chunk.length;
      if (total > max) throw new ProviderError("rejected", tx("Resposta excede o limite de bytes", "Response exceeds the byte limit"));
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (opts.signal.aborted) throw opts.signal.reason;
    throw new ProviderError("ambiguous", tx("Resposta interrompida durante o download", "Response interrupted during download"));
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return {
    status: res.status,
    headers: res.headers,
    bytes,
    json<T>() {
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      } catch {
        throw new ProviderError("rejected", tx(`Resposta ${res.status} não é JSON`, `Response ${res.status} is not JSON`));
      }
    },
  };
}

/** Mensagem legível do corpo de erro: `{error:{message}}`, `{detail}` ou `{detail:[{msg}]}`. */
export function errorMessage(res: HttpResponse): string {
  try {
    const body = res.json<{ error?: { message?: string; code?: string | number }; detail?: unknown; message?: string }>();
    if (body.error?.message) return body.error.message;
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d: { msg?: string; loc?: unknown[] }) => `${(d.loc ?? []).join(".")}: ${d.msg}`).join("; ");
    if (body.message) return body.message;
  } catch {
    /* corpo não JSON */
  }
  return `HTTP ${res.status}`;
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Converte status HTTP não-2xx em `ProviderError` com a categoria do worker. */
export function failOnStatus(res: HttpResponse, opts: { billingCodes?: string[] } = {}): void {
  if (res.status >= 200 && res.status < 300) return;
  const message = errorMessage(res);
  const code = (() => {
    try {
      const b = res.json<{ error?: { code?: unknown; type?: unknown } }>();
      return [b.error?.code, b.error?.type].filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  })();
  switch (res.status) {
    case 401:
      throw new ProviderError("auth", message);
    case 402:
      // OpenRouter reserva o custo máximo dos pedidos em andamento: recusa transitória, sem cobrança.
      if (/in-flight/i.test(message)) throw new ProviderError("rate_limited", message, retryAfterMs(res.headers) ?? 15_000);
      throw new ProviderError("balance", message);
    case 403:
      throw new ProviderError(/policy|refus|moderat/i.test(message + code.join(" ")) ? "rejected" : "auth", message);
    case 429:
      if (code.some((c) => (opts.billingCodes ?? []).includes(c))) throw new ProviderError("balance", message);
      throw new ProviderError("rate_limited", message, retryAfterMs(res.headers));
    default:
      if (res.status >= 500) throw new ProviderError("unavailable", message, retryAfterMs(res.headers));
      throw new ProviderError("rejected", message);
  }
}

/** Decodifica base64 (com ou sem prefixo data URL) e confere que é imagem raster. */
export function decodeImage(value: string): ProviderImage {
  const raw = value.replace(/^data:[^;,]+;base64,/, "");
  const bytes = new Uint8Array(Buffer.from(raw, "base64"));
  const kind = sniff(bytes);
  if (!kind || kind.modality !== "raster") throw new ProviderError("rejected", tx("Resposta contém dados que não são imagem", "Response contains data that is not an image"));
  return { bytes, mime: kind.mime };
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Resolve o segredo pelo nome da variável de ambiente, só no processo que chama o provedor. */
export function resolveSecret(secretRef: string | null): string {
  if (!secretRef) throw new DomainFailure("capability_missing", tx("Perfil sem referência de credencial", "Provider profile has no credential reference"));
  const value = process.env[secretRef];
  if (!value) throw new DomainFailure("capability_missing", tx(`Credencial ausente: defina a variável de ambiente ${secretRef} no servidor`, `Missing credential: set the ${secretRef} environment variable on the server`));
  return value;
}
