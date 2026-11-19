"use client";

import { useRef } from "react";
import type { JobView } from "@/server/jobs/queue";
import { apiFetch, errorMessage } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { useLocale, useMessages } from "@/i18n/client";
import { commonMessages, labelOf } from "@/i18n/messages/common";

/** Acompanha um job de geração até concluir e avisa o painel para recarregar o catálogo. */
export function JobStatus({ projectId, jobId, onDone }: { projectId: string; jobId: string; onDone: () => void }) {
  const locale = useLocale();
  const c = useMessages(commonMessages);
  const notified = useRef(false);
  const { data } = usePoll(
    async () => {
      const { job } = await apiFetch<{ job: JobView }>(`/projects/${projectId}/jobs/${jobId}`);
      if ((job.state === "succeeded" || job.state === "failed") && !notified.current) {
        notified.current = true;
        onDone();
      }
      return job;
    },
    { active: (job) => job.state === "queued" || job.state === "running", fastMs: 800, slowMs: 30_000 },
  );
  if (!data) return <p className="small muted">Job {jobId}…</p>;
  const error = errorMessage(data.error, locale);
  return (
    <p className="small">
      Job {data.id}: <span className={`badge state-${data.state}`}>{labelOf(c.jobState, data.state)}</span> {data.stage ? `· ${c.stage(data.stage)}` : ""}
      {error ? <span className="error"> · {error}</span> : null}
    </p>
  );
}
