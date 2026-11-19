"use client";

import { type ReactNode, useState } from "react";
import { apiFetch } from "@/app/client/api";
import { estimateText } from "@/app/client/cost";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { dialogueMessages } from "@/i18n/messages/dialogue";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { JobStatus } from "../world/job-status";
import { errorText, PIXEL, type PlanPreview, type Profile, review, runPlan } from "./dialogue-client";

/** Seletor de perfil: só os que oferecem a operação na rota genérica e estão prontos. */
export function ProfileSelect({ profiles, operation, value, onChange }: { profiles: Profile[]; operation: string; value: string; onChange: (id: string) => void }) {
  const m = useMessages(dialogueMessages).shared;
  const usable = profiles.filter((p) => (p.capabilities[operation]?.length ?? 0) > 0 && !p.unavailable);
  return (
    <label>
      {m.profile}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{usable[0] ? m.defaultProfile(usable[0].name) : m.noProfile}</option>
        {usable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function usableProfile(profiles: Profile[], operation: string, chosen: string): string | undefined {
  return chosen || profiles.find((p) => (p.capabilities[operation]?.length ?? 0) > 0 && !p.unavailable)?.id;
}

/**
 * Prévia do plano (rota rotulada, capacidades, estimativa e restrições)
 * antes de enviar, e acompanhamento do job. O mesmo plano gera o mesmo job.
 */
export function PlanRunner({ projectId, label, body, target, onDone, disabled }: { projectId: string; label: string; body: () => Record<string, unknown> | null; target: () => Promise<string>; onDone: () => void; disabled?: boolean }) {
  const m = useMessages(dialogueMessages).shared;
  const locale = useLocale();
  const text = useText();
  const [preview, setPreview] = useState<(PlanPreview & Record<string, unknown>) | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function plan() {
    setMessage(null);
    setPreview(null);
    const b = body();
    if (!b) return;
    try {
      setPreview(await apiFetch<PlanPreview & Record<string, unknown>>(`/projects/${projectId}/generation-plans`, { method: "POST", json: b }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function send() {
    if (!preview) return;
    setBusy(true);
    try {
      const assetId = (preview.targetAssetId as string | undefined) ?? (await target());
      const { job } = await runPlan(projectId, preview, assetId);
      setJobId(job.id);
      setPreview(null);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  const restrictions = (preview?.restrictions as TextValue[] | undefined) ?? [];
  return (
    <div>
      <button type="button" onClick={plan} disabled={disabled}>
        {m.checkPlan(label)}
      </button>
      {preview && (
        <div className="small" style={{ marginTop: 6 }}>
          <div>
            {m.route} <strong>{preview.routeLabel ? text(preview.routeLabel as TextValue) : preview.plan.operation}</strong> {preview.destination.simulated ? <span className="badge">{m.simulated}</span> : null}
          </div>
          <div className="muted">{m.planDetails(preview.destination.name, preview.plan.requiredCapabilities.join(", "), preview.plan.parts.length, estimateText(preview.plan, locale))}</div>
          {restrictions.map((r, i) => (
            <div key={i} className="muted">
              ⚠ {text(r)}
            </div>
          ))}
          <details>
            <summary>{m.compiledPrompt}</summary>
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

/** Cartão de revisão: imagem em zoom inteiro, rota rotulada, avisos bilíngues e decisão pelo fluxo de pareceres. */
export function RevisionCard({ projectId, asset, revision, src, width, refresh, children }: { projectId: string; asset: AssetView; revision: RevisionView; src: string | null; width?: number; refresh: () => void; children?: ReactNode }) {
  const c = useMessages(commonMessages);
  const text = useText();
  const [message, setMessage] = useState<string | null>(null);
  async function decide(decision: "approve" | "reject") {
    try {
      const reason = decision === "reject" ? (window.prompt(c.rejectReasonPrompt) ?? "").trim() || null : null;
      if (decision === "reject" && !reason) return;
      await review(projectId, asset, revision.id, decision, reason);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  const tr = revision.technicalReport as { routeLabel?: TextValue; warnings?: TextValue[] } | null;
  return (
    <div className="small" style={{ border: "1px solid var(--border, #444)", padding: 8, borderRadius: 6, maxWidth: (width ?? 256) + 24 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && <img src={src} alt={asset.name} className="pixel bg-checker" style={{ ...PIXEL, width: width ?? 256, maxWidth: "100%" }} />}
      <div>
        <strong>{asset.name}</strong> r{revision.number} <span className={`badge state-${revision.status}`}>{labelOf(c.revisionStatus, revision.status)}</span>
      </div>
      {tr?.routeLabel && <div className="muted">{text(tr.routeLabel)}</div>}
      {(tr?.warnings ?? []).slice(0, 4).map((w, i) => (
        <div key={i} className="muted">
          ⚠ {text(w)}
        </div>
      ))}
      {children}
      {revision.status === "candidate" && (
        <div className="row">
          <button type="button" onClick={() => decide("approve")}>
            {c.approve}
          </button>
          <button type="button" className="secondary" onClick={() => decide("reject")}>
            {c.reject}
          </button>
        </div>
      )}
      {message && <p className="error">{message}</p>}
    </div>
  );
}

/** Seletor de zoom inteiro (1×–8×) para inspecionar pixel art sem reamostrar. */
export function ZoomSelect({ value, onChange, max = 8 }: { value: number; onChange: (z: number) => void; max?: number }) {
  const m = useMessages(dialogueMessages).shared;
  return (
    <label>
      {m.zoom}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: max }, (_, i) => i + 1).map((z) => (
          <option key={z} value={z}>
            {z}×
          </option>
        ))}
      </select>
    </label>
  );
}
