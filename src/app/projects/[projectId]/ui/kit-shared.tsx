"use client";

import { type ReactNode, useState } from "react";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import type { TextValue } from "@/i18n/locales";
import { useMessages, useText } from "@/i18n/client";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { errorText, PIXEL, type Profile, review } from "./ui-client";

/** Peças comuns às abas do kit de UI: perfil de geração, decisão de revisão, imagem ampliada e avisos. */

export function ProfileSelect({ profiles, value, onChange }: { profiles: Profile[]; value: string; onChange: (id: string) => void }) {
  const m = useMessages(uiKitMessages).shared;
  return (
    <label>
      {m.profile}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {profiles.map((p) => (
          <option key={p.id} value={p.id} disabled={Boolean(p.unavailable)}>
            {p.name}
            {p.unavailable ? ` — ${m.unavailable}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function defaultProfile(profiles: Profile[]): string {
  return (profiles.find((p) => !p.unavailable && p.transport === "simulated") ?? profiles.find((p) => !p.unavailable) ?? profiles[0])?.id ?? "";
}

/** Imagem em zoom inteiro (pixel art sem suavização). */
export function Zoomed({ src, size, zoom, alt }: { src: string | null; size: [number, number]; zoom: number; alt: string }) {
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className="pixel bg-checker" style={{ ...PIXEL, width: size[0] * zoom, height: size[1] * zoom }} />;
}

export function Warnings({ items }: { items: TextValue[] | undefined }) {
  const text = useText();
  if (!items?.length) return null;
  return (
    <>
      {items.map((w, i) => (
        <div key={i} className="muted small">
          ⚠ {text(w)}
        </div>
      ))}
    </>
  );
}

/** Status, rota (rótulo honesto do relatório técnico), avisos e Aprovar/Reprovar pelo fluxo existente. */
export function ReviewBar({ projectId, asset, revision, refresh, children }: { projectId: string; asset: AssetView; revision: RevisionView; refresh: () => void; children?: ReactNode }) {
  const m = useMessages(uiKitMessages).shared;
  const text = useText();
  const [message, setMessage] = useState<string | null>(null);
  const report = revision.technicalReport as { routeLabel?: TextValue; warnings?: TextValue[] } | null;
  async function decide(decision: "approve" | "reject") {
    try {
      const reason = decision === "reject" ? (window.prompt(m.rejectReason) ?? "").trim() || null : null;
      if (decision === "reject" && !reason) return;
      await review(projectId, asset, revision.id, decision, reason);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <div className="small">
      <div>
        <strong>{asset.name}</strong> r{revision.number} <span className={`badge state-${revision.status}`}>{m.status[revision.status]}</span>
        {asset.approvedRevisionId === revision.id ? <span className="badge"> {m.active}</span> : null}
      </div>
      {report?.routeLabel ? <div className="muted">{text(report.routeLabel)}</div> : null}
      <Warnings items={report?.warnings?.slice(0, 4)} />
      {children}
      {revision.status === "candidate" && (
        <div className="row">
          <button type="button" onClick={() => decide("approve")}>
            {m.approve}
          </button>
          <button type="button" className="secondary" onClick={() => decide("reject")}>
            {m.reject}
          </button>
        </div>
      )}
      {message && <p className="error">{message}</p>}
    </div>
  );
}

export function Card({ children, width }: { children: ReactNode; width?: number }) {
  return <div style={{ border: "1px solid var(--border)", padding: 8, borderRadius: 6, maxWidth: width ?? 360 }}>{children}</div>;
}
