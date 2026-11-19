import { type DomainError, type ErrorCode, HTTP_STATUS_BY_ERROR } from "@/contracts";

/**
 * Erro de domínio com código estável (02a §erros estruturados). Rotas
 * convertem em `{code, message, details, jobId?}` com o status HTTP do código.
 */
export class DomainFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly jobId?: string,
  ) {
    super(message);
    this.name = "DomainFailure";
  }

  get status(): number {
    return HTTP_STATUS_BY_ERROR[this.code];
  }

  toJSON(): DomainError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(this.jobId ? { jobId: this.jobId } : {}),
    };
  }
}

export function toDomainError(err: unknown): DomainFailure {
  if (err instanceof DomainFailure) return err;
  return new DomainFailure("internal", "Erro interno inesperado", { cause: err instanceof Error ? err.message : String(err) });
}
