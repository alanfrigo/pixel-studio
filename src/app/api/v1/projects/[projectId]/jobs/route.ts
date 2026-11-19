import { tx } from "@/i18n/locales";
import { DomainFailure } from "@/server/errors";
import { api, json, readJson } from "@/server/http";
import { jobView, submitJob, SubmitJobInput } from "@/server/services";

export const GET = api<{ projectId: string }>(async (req, { params, studio }) => {
  const active = new URL(req.url).searchParams.get("active") === "true";
  return json({ jobs: studio.queue.list(params.projectId, { active }).map((j) => jobView(studio, j)) });
});

/** Responde 202 com o job; o mesmo envio com a mesma Idempotency-Key devolve o mesmo job. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200) throw new DomainFailure("validation_failed", tx("Cabeçalho Idempotency-Key obrigatório (até 200 caracteres)", "Idempotency-Key header is required (up to 200 characters)"));
  const body = await readJson(req, SubmitJobInput);
  const { job, created } = submitJob(studio, params.projectId, body, key);
  return json({ job, created }, 202, { location: `/api/v1/projects/${params.projectId}/jobs/${job.id}` });
});
