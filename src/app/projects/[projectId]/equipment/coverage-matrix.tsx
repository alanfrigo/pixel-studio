"use client";

import { useState } from "react";
import { STATUS_LABEL, type View } from "./shared";

/**
 * Matriz de cobertura peça × clipe × frame × parte (04 §caso de ponta a
 * ponta). Cada célula é clicável e mostra as ações possíveis: criar cobertura
 * só das lacunas, marcar vazia explícita, remover (lacuna), revincular à nova
 * revisão do clipe, posicionar/ocultar a vista rígida.
 */

export interface CellTarget {
  overlayRevisionId: string;
  overlayName: string;
  partId: string;
  kind: "part" | "rigid";
  clipRevisionId: string;
  frameId: string;
  action: string;
  direction: string;
  state: string;
}

export function CoverageMatrix({
  view,
  onAction,
  rigidViews,
}: {
  view: View;
  onAction: (action: "create_coverage" | "mark_empty" | "remove_cell" | "rebind" | "place" | "create_for_base", cell: CellTarget, extra?: { viewId: string; anchorSocketId: string; drawIndex: number; mirrored: boolean }) => Promise<void>;
  rigidViews: Record<string, { viewId: string; grips: { socketId: string }[] }[]>;
}) {
  const m = view.matrix;
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [place, setPlace] = useState({ viewId: "", drawIndex: 0, mirrored: false });
  if (m.rows.length === 0) return <p className="small muted">Nenhuma peça no conjunto.</p>;
  const groups: { label: string; start: number; count: number }[] = [];
  m.columns.forEach((col, i) => {
    const label = `${col.action} · ${col.direction}`;
    const last = groups.at(-1);
    if (last && last.label === label) last.count += 1;
    else groups.push({ label, start: i, count: 1 });
  });
  const cell: CellTarget | null = selected
    ? {
        overlayRevisionId: m.rows[selected.r]!.overlayRevisionId,
        overlayName: m.rows[selected.r]!.overlayName,
        partId: m.rows[selected.r]!.partId,
        kind: m.rows[selected.r]!.kind,
        clipRevisionId: m.columns[selected.c]!.clipRevisionId,
        frameId: m.columns[selected.c]!.frameId,
        action: m.columns[selected.c]!.action,
        direction: m.columns[selected.c]!.direction,
        state: m.cells[selected.r]![selected.c]!,
      }
    : null;
  const run = async (action: Parameters<typeof onAction>[0], extra?: Parameters<typeof onAction>[2]) => {
    if (!cell) return;
    setBusy(true);
    try {
      await onAction(action, cell, extra);
    } finally {
      setBusy(false);
    }
  };
  const views = cell ? (rigidViews[cell.overlayRevisionId] ?? []) : [];

  return (
    <div>
      <div className="eq-scroll">
        <table className="eq-matrix">
          <thead>
            <tr>
              <th rowSpan={2}>Peça · parte</th>
              {groups.map((g) => (
                <th key={g.label} colSpan={g.count}>
                  {g.label}
                </th>
              ))}
              <th rowSpan={2}>cobertas / total</th>
            </tr>
            <tr>
              {m.columns.map((c, i) => (
                <th key={`${c.clipRevisionId}-${c.frameId}-${i}`} title={c.clipName}>
                  {c.frameId}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((row, r) => (
              <tr key={`${row.overlayRevisionId}-${row.partId}`}>
                <th style={{ textAlign: "left" }}>
                  {row.overlayName} · {row.partId === "rigid" ? "vista rígida" : row.partId}
                </th>
                {m.cells[r]!.map((state, c) => (
                  <td
                    key={c}
                    className={`cell ${state}${selected?.r === r && selected.c === c ? " selected" : ""}`}
                    title={`${row.overlayName} · ${row.partId} · ${m.columns[c]!.action}/${m.columns[c]!.direction} · ${m.columns[c]!.frameId}: ${STATUS_LABEL[state]}`}
                    onClick={() => setSelected({ r, c })}
                  >
                    {state === "missing" ? "✕" : state === "stale" ? "↻" : state === "empty" ? "∅" : state === "incompatible" ? "–" : ""}
                  </td>
                ))}
                <td>
                  {m.counts[r]!.covered + m.counts[r]!.empty}/{m.counts[r]!.total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Total: {m.totals.covered} coberta(s), {m.totals.empty} vazia(s) explícita(s), {m.totals.missing} lacuna(s), {m.totals.stale} a revisar, {m.totals.incompatible} de outra base. Clique numa célula para agir.
      </p>
      {cell && (
        <div className="row small" style={{ alignItems: "center" }}>
          <strong>
            {cell.overlayName} · {cell.partId} · {cell.action}/{cell.direction} · {cell.frameId}
          </strong>
          <span className="muted">{STATUS_LABEL[cell.state]}</span>
          {cell.state === "incompatible" && (
            <button type="button" disabled={busy} onClick={() => run("create_for_base")}>
              Criar cobertura para esta base
            </button>
          )}
          {cell.state === "stale" && (
            <button type="button" disabled={busy} onClick={() => run("rebind")}>
              Revincular cobertura (digest)
            </button>
          )}
          {cell.state === "missing" && cell.kind === "part" && (
            <button type="button" disabled={busy} onClick={() => run("create_coverage")}>
              Criar cobertura (só lacunas)
            </button>
          )}
          {cell.state === "missing" && cell.kind === "rigid" && (
            <>
              <select value={place.viewId} onChange={(e) => setPlace((p) => ({ ...p, viewId: e.target.value }))}>
                <option value="">vista…</option>
                {views.map((v) => (
                  <option key={v.viewId} value={v.viewId}>
                    {v.viewId}
                  </option>
                ))}
              </select>
              <label>
                ordem
                <input type="number" value={place.drawIndex} style={{ width: 56 }} onChange={(e) => setPlace((p) => ({ ...p, drawIndex: Math.round(Number(e.target.value) || 0) }))} />
              </label>
              <label style={{ flexDirection: "row", gap: 4 }}>
                <input type="checkbox" checked={place.mirrored} onChange={(e) => setPlace((p) => ({ ...p, mirrored: e.target.checked }))} /> espelhada
              </label>
              <button
                type="button"
                disabled={busy || !place.viewId}
                onClick={() => {
                  const v = views.find((x) => x.viewId === place.viewId)!;
                  return run("place", { viewId: v.viewId, anchorSocketId: v.grips[0]!.socketId, drawIndex: place.drawIndex, mirrored: place.mirrored });
                }}
              >
                Posicionar vista
              </button>
            </>
          )}
          {(cell.state === "missing" || cell.state === "covered") && (
            <button type="button" className="secondary" disabled={busy} onClick={() => run("mark_empty")}>
              {cell.kind === "rigid" ? "Ocultar neste frame (vazia explícita)" : "Marcar célula vazia"}
            </button>
          )}
          {(cell.state === "covered" || cell.state === "empty") && (
            <button type="button" className="secondary" disabled={busy} onClick={() => run("remove_cell")}>
              Remover (vira lacuna)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
