import { type DomainError, type ErrorCode, HTTP_STATUS_BY_ERROR } from "@/contracts";
import { type Locale, type LocalizedText, isLocalized } from "@/i18n/locales";

/**
 * Erro de domínio com código estável (02a §erros estruturados). Rotas
 * convertem em `{code, message, messages?, details, jobId?}` com o status HTTP
 * do código. A mensagem pode ser bilíngue (`tx("…", "…")`): a API responde no
 * idioma da requisição e grava os dois idiomas em erros de job. `Error.message`
 * fica em português (logs e testes existentes).
 */
export class DomainFailure extends Error {
  readonly messages: LocalizedText | null;

  constructor(
    readonly code: ErrorCode,
    message: string | LocalizedText,
    readonly details?: Record<string, unknown>,
    readonly jobId?: string,
  ) {
    super(isLocalized(message) ? message["pt-BR"] : message);
    this.messages = isLocalized(message) ? message : null;
    this.name = "DomainFailure";
  }

  get status(): number {
    return HTTP_STATUS_BY_ERROR[this.code];
  }

  /** Sem idioma: português (compatível com o que já estava gravado); com idioma: a mensagem nele. */
  toJSON(locale?: Locale): DomainError {
    return {
      code: this.code,
      message: locale && this.messages ? this.messages[locale] : this.message,
      ...(this.messages ? { messages: this.messages } : {}),
      ...(this.details ? { details: this.details } : {}),
      ...(this.jobId ? { jobId: this.jobId } : {}),
    };
  }
}

export function toDomainError(err: unknown): DomainFailure {
  if (err instanceof DomainFailure) return err;
  return new DomainFailure("internal", { "pt-BR": "Erro interno inesperado", en: "Unexpected internal error" }, { cause: err instanceof Error ? err.message : String(err) });
}
