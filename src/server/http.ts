import { z } from "zod";
import { DomainFailure, toDomainError } from "./errors";
import { type Studio, webStudio } from "./studio";

/**
 * Infra comum das rotas `/api/v1` (02 §configuração, privacidade):
 * - acesso por loopback: Host fora da lista é recusado (defesa contra DNS rebinding);
 * - mutações validam a origem (Origin/Sec-Fetch-Site) contra CSRF;
 * - erros estruturados `{code, message, details, jobId?}` com status do código.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_JSON_BYTES = 1024 * 1024;

function allowedHosts(): Set<string> {
  const extra = (process.env.PIXEL_STUDIO_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return new Set([...LOOPBACK_HOSTS, ...extra]);
}

function hostname(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
}

export function checkRequestOrigin(req: Request, mutation: boolean): void {
  const host = req.headers.get("host") ?? "";
  if (!allowedHosts().has(hostname(host))) {
    throw new HttpError(403, "forbidden_host", "Host não autorizado: o Studio atende apenas no endereço local");
  }
  if (!mutation) return;
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "forbidden_origin", "Requisição de outra origem recusada");
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      /* origem malformada */
    }
    if (originHost !== host) throw new HttpError(403, "forbidden_origin", "Requisição de outra origem recusada");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_JSON_BYTES) throw new HttpError(413, "payload_too_large", "Corpo da requisição grande demais");
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, "payload_too_large", "Corpo da requisição grande demais");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new DomainFailure("validation_failed", "Corpo não é JSON válido");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new DomainFailure("validation_failed", "Campos inválidos", {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  return parsed.data;
}

export interface ApiContext<P> {
  params: P;
  studio: Studio;
}

/** Envolve um handler de rota com validação de origem e conversão de erros. */
export function api<P extends Record<string, string> = Record<string, never>>(
  handler: (req: Request, ctx: ApiContext<P>) => Promise<Response>,
  opts: { mutation?: boolean } = {},
) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      checkRequestOrigin(req, opts.mutation ?? req.method !== "GET");
      const params = await ctx.params;
      return await handler(req, { params, studio: webStudio() });
    } catch (err) {
      if (err instanceof HttpError) return json({ code: err.code, message: err.message }, err.status);
      const failure = toDomainError(err);
      if (failure.code === "internal") console.error("[api]", req.method, new URL(req.url).pathname, err);
      // Recurso de outro projeto responde como inexistente.
      const body = failure.code === "cross_project_reference" ? { ...failure.toJSON(), code: "not_found" } : failure.toJSON();
      return json(body, failure.status);
    }
  };
}
