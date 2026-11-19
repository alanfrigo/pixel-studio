"use client";

import { useState } from "react";
import type { BasePayload, Direction, WorldToViewMap } from "@/contracts";
import { viewSet } from "@/domain/animation/directions";
import type { RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { type AssetEntry, DIR_LABEL, DIRS, errorText, review, viewUrl } from "./shared";

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
    if (approvedViews.has(d)) list.push({ revision: approved, label: `aprovada r${approved.number}` });
    for (const r of candidates) {
      const v = (r.payload as BasePayload).views.find((x) => x.direction === d);
      const file = v && r.files.find((f) => f.fileKey === v.fileId);
      const approvedFile = approvedViews.has(d) ? approved.files.find((f) => f.fileKey === (approved.payload as BasePayload).views.find((x) => x.direction === d)!.fileId) : undefined;
      if (file && file.sha256 !== approvedFile?.sha256) list.push({ revision: r, label: `candidata r${r.number}` });
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
      setMessage(`Base r${res.revision.number} publicada como candidata com ${chosen.length} vista(s), sem chamada paga.`);
      props.onChanged();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <div>
      <div className="row">
        <label>
          Conjunto
          <select value={count} onChange={(e) => setCount(Number(e.target.value) as 4 | 8)}>
            <option value={4}>4 vistas</option>
            <option value={8}>8 vistas</option>
          </select>
        </label>
        <span className="small muted">
          Projeção do projeto: {props.projection}
          {props.rotationLabel ? ` · rota: ${props.rotationLabel}` : ""}
        </span>
      </div>
      {isometric && (
        <table className="anim-timeline small" style={{ marginTop: 8 }}>
          <caption className="muted">Movimento no mundo → vista desenhada na tela (orientação de referência; girar o mapa recalcula a tabela, não gira o bitmap)</caption>
          <tbody>
            <tr>
              <th>Mundo</th>
              {DIRS.map((d) => (
                <td key={d}>{d}</td>
              ))}
            </tr>
            <tr>
              <th>Vista</th>
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
                <strong>{d}</strong> · {DIR_LABEL[d]}
              </figcaption>
              {opts.length === 0 ? (
                <p className="small error">Falta arte desta vista (sem espelho implícito).</p>
              ) : (
                opts.map((o) => {
                  const src = viewUrl(projectId, o.revision, d);
                  return (
                    <label key={o.revision.id} className="anim-view-option">
                      <input type="radio" name={`view-${d}`} checked={pick === o.revision.id} onChange={() => setPicks((p) => ({ ...p, [d]: o.revision.id }))} />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {src && <img className="pixel" alt={`Vista ${d} ${o.label}`} src={src} width={96} height={96} />}
                      <span className="small">{o.label}</span>
                    </label>
                  );
                })
              )}
              {opts.length > 0 && (
                <label className="small" style={{ flexDirection: "row", gap: 4 }}>
                  <input type="radio" name={`view-${d}`} checked={pick === "none"} onChange={() => setPicks((p) => ({ ...p, [d]: "none" }))} /> não usar
                </label>
              )}
              {!approvedViews.has(d) && (
                <button type="button" className="secondary" onClick={() => props.onGenerate([d], asym)}>
                  {opts.length ? "Gerar de novo" : "Gerar vista"}
                </button>
              )}
            </figure>
          );
        })}
      </div>
      <label style={{ marginTop: 8 }}>
        Assimetrias a manter no lado anatômico (uma por linha)
        <textarea value={asymmetries} onChange={(e) => setAsymmetries(e.target.value)} placeholder={"escudo no braço esquerdo\nespada na mão direita"} />
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" disabled={missing.length === 0} onClick={() => props.onGenerate(missing, asym)}>
          Gerar {missing.length} vista(s) que faltam
        </button>
        <button type="button" className="secondary" onClick={compose}>
          Publicar vistas escolhidas
        </button>
        {composed && (
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              try {
                await review(projectId, base.asset.id, composed.id, "approve", base.asset.approvedRevisionId);
                setMessage(`Base r${composed.number} aprovada.`);
                setComposed(null);
                props.onChanged();
              } catch (err) {
                setMessage(errorText(err));
              }
            }}
          >
            Aprovar r{composed.number}
          </button>
        )}
      </div>
      <p className="small muted">Cada vista é um job próprio (uma direção por plano): reprovar uma não refaz as outras nem dispara o lote inteiro.</p>
      {message && <p className="small">{message}</p>}
    </div>
  );
}
