"use client";

import { useState } from "react";
import type { LocalizedText } from "@/i18n/locales";
import { useLocale, useMessages, useText } from "@/i18n/client";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { apiFetch } from "@/app/client/api";
import { estimateText } from "@/app/client/cost";
import { JobStatus } from "../world/job-status";
import { errorText, type PlanPreview, runPlan } from "./ui-client";

type Preview = PlanPreview & { routeLabel?: LocalizedText; restrictions?: LocalizedText[]; targetAssetId?: string };

/**
 * Prévia do plano (rota honesta, capacidades, partes, estimativa e o que a
 * rota NÃO faz) antes de enviar; o mesmo plano gera o mesmo job.
 */
export function PlanRunner({ projectId, label, body, target, onDone, disabled }: { projectId: string; label: string; body: () => Record<string, unknown> | null; target: () => Promise<string>; onDone: () => void; disabled?: boolean }) {
  const m = useMessages(uiKitMessages).plan;
  const text = useText();
  const locale = useLocale();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function plan() {
    setMessage(null);
    setPreview(null);
    const b = body();
    if (!b) return;
    try {
      setPreview(await apiFetch<Preview>(`/projects/${projectId}/generation-plans`, { method: "POST", json: b }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function send() {
    if (!preview) return;
    setBusy(true);
    try {
      const assetId = preview.targetAssetId ?? (await target());
      const { job } = await runPlan(projectId, preview, assetId);
      setJobId(job.id);
      setPreview(null);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button type="button" onClick={plan} disabled={disabled}>
        {m.check(label)}
      </button>
      {preview && (
        <div className="small" style={{ marginTop: 6 }}>
          <div>
            {m.route} <strong>{text(preview.routeLabel ?? preview.plan.operation)}</strong>
            {preview.destination.simulated ? <span className="badge"> {m.simulated}</span> : null}
          </div>
          <div className="muted">{m.details(preview.destination.name, preview.plan.requiredCapabilities.join(", "), preview.plan.parts.length, estimateText(preview.plan, locale))}</div>
          {(preview.restrictions ?? []).map((r) => (
            <div key={r.en} className="muted">
              ⚠ {text(r)}
            </div>
          ))}
          <details>
            <summary>{m.prompt}</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{preview.plan.prompt.compiled}</pre>
          </details>
          <button type="button" onClick={send} disabled={busy}>
            {m.send}
          </button>
        </div>
      )}
      {jobId && <JobStatus projectId={projectId} jobId={jobId} onDone={onDone} />}
      {message && <p className="error">{message}</p>}
    </div>
  );
}
