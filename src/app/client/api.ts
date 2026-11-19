"use client";

import { isLocalized, type Locale, type TextValue } from "@/i18n/locales";

/** Cliente das rotas `/api/v1` com erros estruturados `{code, message, details}`. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api/v1${path}`, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(body.code ?? "error"), String(body.message ?? res.statusText), body.details as Record<string, unknown>);
  }
  return body as T;
}

export function newKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function formatBytes(n: number, locale: Locale): string {
  const one = (v: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${one(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${one(n / 1024 / 1024)} MB`;
  return `${one(n / 1024 ** 3)} GB`;
}

/**
 * Mensagem de um erro gravado (job, upload, exportação): `messages[idioma]`
 * quando o servidor gravou os dois idiomas, senão `message` (dado antigo).
 */
export function errorMessage(error: unknown, locale: Locale): string | null {
  if (typeof error === "string") return error;
  if (error === null || typeof error !== "object") return null;
  const e = error as { message?: unknown; messages?: unknown };
  if (isLocalized(e.messages)) return e.messages[locale];
  if (isLocalized(e.message)) return e.message[locale];
  return typeof e.message === "string" ? e.message : null;
}

export interface Health {
  ok: boolean;
  sqlite: { version: string; schemaVersion: number; latest: number };
  storage: { dataDir: string; freeBytes: number };
  python: { ok: boolean; pillow?: string; python?: string; error?: TextValue };
  worker: { online: boolean; workers: { worker_id: string; current_job_id: string | null }[] };
}
