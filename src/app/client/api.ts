"use client";

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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export interface Health {
  ok: boolean;
  sqlite: { version: string; schemaVersion: number; latest: number };
  storage: { dataDir: string; freeBytes: number };
  python: { ok: boolean; pillow?: string; python?: string; error?: string };
  worker: { online: boolean; workers: { worker_id: string; current_job_id: string | null }[] };
}
