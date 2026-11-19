import { LocalizedText } from "@/i18n/locales";
import { z } from "zod";
import { Id } from "./common";

/**
 * Fila e erros (02a §semântica da fila, §erros estruturados).
 * `queued → running → succeeded | failed | cancelled`; resultado remoto ambíguo
 * leva `running → needs_attention`. A etapa local fica em campo separado.
 */

export const JobState = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "needs_attention"]);
export type JobState = z.infer<typeof JobState>;

export const JobStage = z.enum(["prepare", "submit", "download", "process", "publish"]);
export type JobStage = z.infer<typeof JobStage>;

export const JobKind = z.enum(["generation", "local_process", "export", "ingest"]);
export type JobKind = z.infer<typeof JobKind>;

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "needs_attention", "queued"],
  needs_attention: ["queued", "failed", "cancelled", "succeeded"],
  succeeded: [],
  failed: ["queued"],
  cancelled: [],
};

/** `running → queued` = reserva vencida; `failed → queued` = nova tentativa explícita. */
export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: JobState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Estado do envio remoto de uma parte; `uncertain` = pode ter sido aceito e cobrado. */
export const RemoteSubmission = z.enum(["not_sent", "sending", "accepted", "uncertain", "completed", "rejected"]);
export type RemoteSubmission = z.infer<typeof RemoteSubmission>;

export const ErrorCode = z.enum([
  "validation_failed",
  "capability_missing",
  "coverage_incomplete",
  "not_found",
  "cross_project_reference",
  "revision_conflict",
  "idempotency_conflict",
  "source_not_approved",
  "budget_exceeded",
  "provider_auth",
  "provider_balance",
  "provider_rejected",
  "provider_unavailable",
  "submission_uncertain",
  "storage_failed",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const HTTP_STATUS_BY_ERROR: Record<ErrorCode, number> = {
  validation_failed: 422,
  capability_missing: 422,
  coverage_incomplete: 422,
  source_not_approved: 422,
  budget_exceeded: 422,
  not_found: 404,
  // Recurso de outro projeto é inacessível: não revelar que existe.
  cross_project_reference: 404,
  revision_conflict: 409,
  idempotency_conflict: 409,
  provider_auth: 502,
  provider_balance: 502,
  provider_rejected: 502,
  provider_unavailable: 503,
  submission_uncertain: 409,
  storage_failed: 507,
  internal: 500,
};

export const DomainError = z.strictObject({
  code: ErrorCode,
  message: z.string().min(1),
  /** Mensagem nos dois idiomas da interface, quando o servidor a fornece. */
  messages: LocalizedText.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  jobId: Id.optional(),
});
export type DomainError = z.infer<typeof DomainError>;
