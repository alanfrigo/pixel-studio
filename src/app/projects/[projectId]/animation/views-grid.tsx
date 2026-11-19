"use client";

import { useState } from "react";
import type { BasePayload, Direction, WorldToViewMap } from "@/contracts";
import { viewSet } from "@/domain/animation/directions";
import type { RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { useMessages } from "@/i18n/client";
import { animationMessages } from "@/i18n/messages/animation";
import { commonMessages } from "@/i18n/messages/common";
import { type AssetEntry, DIRS, errorText, review, viewUrl } from "./shared";

/**
 * Grade de vistas 4/8 (04 §vistas): cada direção é candidata independente.
 * Falta é falta — nenhuma vista é preenchida por espelho. Escolhe-se uma vista
 * por direção (aprovada ou candidata) e publica-se a seleção; as aprovadas
 * mantêm blobs e IDs. No isométrico, a tabela mundo → vista diz quais vistas
 * da tela cada movimento usa.
 */

export function ViewsGrid(props: {
  projectId: string;
  base: AssetEntry;
  approved: RevisionView;
  projection: string;
  worldToView: WorldToViewMap;
  rotationLabel: string | null;
  onGenerate: (views: Direction[], asymmetries: string[]) => Promise<void>;
  onChanged: () => void;
}) {
  const { projectId, base, approved } = props;
  const am = useMessages(animationMessages);
  const t = am.viewsGrid;
  const c = useMessages(commonMessages);
  const [count, setCount] = useState<4 | 8>(4);
  const [asymmetries, setAsymmetries] = useState("");
  const [picks, setPicks] = useState<Partial<Record<Direction, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [composed, setComposed] = useState<RevisionView | null>(null);
  const isometric = props.projection === "isometric";
  const wanted = viewSet(count, isometric ? "isometric" : "top_down");
  const approvedViews = new Set((approved.payload as BasePayload).views.map((v) => v.direction));
  const candidates = base.revisions.filter((r) => r.status === "candidate" && r.id !== approved.id);
  const missing = wanted.filter((d) => !approvedViews.has(d));
  const asym = asymmetries
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const options = (d: Direction) => {
    const list: { revision: RevisionView; label: string }[] = [];
    if (approvedViews.has(d)) list.push({ revision: approved, label: t.approvedRev(approved.number) });
    for (const r of candidates) {
      const v = (r.payload as BasePayload).views.find((x) => x.direction === d);
      const file = v && r.files.find((f) => f.fileKey === v.fileId);
      const approvedFile = approvedViews.has(d) ? approved.files.find((f) => f.fileKey === (approved.payload as BasePayload).views.find((x) => x.direction === d)!.fileId) : undefined;
      if (file && file.sha256 !== approvedFile?.sha256) list.push({ revision: r, label: t.candidateRev(r.number) });
    }
    return list;
  };

  async function compose() {
    setMessage(null);
    const chosen = DIRS.flatMap((d) => {
      const opts = options(d);
      const id = picks[d] ?? opts[0]?.revision.id;
      return id && id !== "none" ? [{ direction: d, revisionId: id }] : [];
    });
    try {
      const res = await apiFetch<{ revision: RevisionView }>(`/projects/${projectId}/animation/views`, { method: "POST", json: { baseAssetId: base.asset.id, picks: chosen } });
      setComposed(res.revision);
      setMessage(t.composed(res.revision.number, chosen.length));
      props.onChanged();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <div>
      <div className="row">
        <label>
          {t.set}
          <select value={count} onChange={(e) => setCount(Number(e.target.value) as 4 | 8)}>
            <option value={4}>{t.viewsCount(4)}</option>
            <option value={8}>{t.viewsCount(8)}</option>
          </select>
        </label>
        <span className="small muted">
          {t.projection(props.projection)}
          {props.rotationLabel ? t.route(props.rotationLabel) : ""}
        </span>
      </div>
      {isometric && (
        <table className="anim-timeline small" style={{ marginTop: 8 }}>
          <caption className="muted">{t.isoCaption}</caption>
          <tbody>
            <tr>
              <th>{t.world}</th>
              {DIRS.map((d) => (
                <td key={d}>{d}</td>
              ))}
            </tr>
            <tr>
              <th>{t.view}</th>
              {DIRS.map((d) => (
                <td key={d}>{props.worldToView[d]}</td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
      <div className="anim-views">
        {wanted.map((d) => {
          const opts = options(d);
          const pick = picks[d] ?? opts[0]?.revision.id ?? "none";
          return (
            <figure key={d} className={`anim-view${opts.length === 0 ? " missing" : ""}`}>
              <figcaption>
                <strong>{d}</strong> · {c.directions[d]}
              </figcaption>
              {opts.length === 0 ? (
                <p className="small error">{t.missingArt}</p>
              ) : (
                opts.map((o) => {
                  const src = viewUrl(projectId, o.revision, d);
                  return (
                    <label key={o.revision.id} className="anim-view-option">
                      <input type="radio" name={`view-${d}`} checked={pick === o.revision.id} onChange={() => setPicks((p) => ({ ...p, [d]: o.revision.id }))} />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {src && <img className="pixel" alt={t.viewAlt(d, o.label)} src={src} width={96} height={96} />}
                      <span className="small">{o.label}</span>
                    </label>
                  );
                })
              )}
              {opts.length > 0 && (
                <label className="small" style={{ flexDirection: "row", gap: 4 }}>
                  <input type="radio" name={`view-${d}`} checked={pick === "none"} onChange={() => setPicks((p) => ({ ...p, [d]: "none" }))} /> {t.dontUse}
                </label>
              )}
              {!approvedViews.has(d) && (
                <button type="button" className="secondary" onClick={() => props.onGenerate([d], asym)}>
                  {opts.length ? t.regenerate : t.generateView}
                </button>
              )}
            </figure>
          );
        })}
      </div>
      <label style={{ marginTop: 8 }}>
        {t.asymmetries}
        <textarea value={asymmetries} onChange={(e) => setAsymmetries(e.target.value)} placeholder={t.asymmetriesPlaceholder} />
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" disabled={missing.length === 0} onClick={() => props.onGenerate(missing, asym)}>
          {t.generateMissing(missing.length)}
        </button>
        <button type="button" className="secondary" onClick={compose}>
          {t.publishChosen}
        </button>
        {composed && (
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              try {
                await review(projectId, base.asset.id, composed.id, "approve", base.asset.approvedRevisionId);
                setMessage(t.baseApproved(composed.number));
                setComposed(null);
                props.onChanged();
              } catch (err) {
                setMessage(errorText(err));
              }
            }}
          >
            {am.shared.approveRev(composed.number)}
          </button>
        )}
      </div>
      <p className="small muted">{t.perViewNote}</p>
      {message && <p className="small">{message}</p>}
    </div>
  );
}
