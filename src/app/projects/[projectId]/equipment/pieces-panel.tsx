"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { equipmentMessages } from "@/i18n/messages/equipment";
import { ResolvedPlayer } from "./resolved-player";
import { errorText, mediaUrl, type Overview, type OverlayRev, resolve, review, type RigInfo, type View } from "./shared";

/**
 * Peças (04 §criar uma roupa, itens 2–3): peça isolada sobre fundos
 * diferentes e sobreposta à base com transparência alternável, vistas rígidas
 * com as empunhaduras (dupla empunhadura marca duas) e aprovação no fluxo de
 * revisão existente.
 */

const BGS = ["checker", "dark", "light", "green"] as const;

export function PiecesPanel({ projectId, overview, rig, refresh }: { projectId: string; overview: Overview; rig: RigInfo; refresh: () => void }) {
  const m = useMessages(equipmentMessages).pieces;
  const c = useMessages(commonMessages);
  const groups = overview.overlays;
  const [selected, setSelected] = useState<string | null>(groups[0]?.activeRevisionId ?? groups[0]?.revisions[0]?.revisionId ?? null);
  const rev = groups.flatMap((g) => g.revisions).find((r) => r.revisionId === selected) ?? null;
  const group = rev ? groups.find((g) => g.assetId === rev.assetId)! : null;
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="eq-layout">
      <section>
        <h2>{m.title}</h2>
        <ul className="list small">
          {groups.map((g) => (
            <li key={g.assetId}>
              <strong>{g.name}</strong>
              <div className="row">
                {g.revisions.map((r) => (
                  <button key={r.revisionId} type="button" className={selected === r.revisionId ? "" : "secondary"} onClick={() => (setSelected(r.revisionId), setMessage(null))}>
                    r{r.number} <span className={`badge state-${r.status}`}>{r.active ? c.revisionStatus.active : r.status === "approved" ? c.revisionStatus.approved : r.status === "candidate" ? c.revisionStatus.candidate : c.revisionStatus.rejected}</span>
                    {r.rigRevisionId !== rig.revisionId ? m.otherBase : ""}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        {rev && group ? (
          <PieceInspector key={rev.revisionId} projectId={projectId} rev={rev} activeRevisionId={group.activeRevisionId} rig={rig} items={overview.items} message={message} setMessage={setMessage} refresh={refresh} />
        ) : (
          <p className="muted">{m.empty}</p>
        )}
      </section>
    </div>
  );
}

function PieceInspector({
  projectId,
  rev,
  activeRevisionId,
  rig,
  items,
  message,
  setMessage,
  refresh,
}: {
  projectId: string;
  rev: OverlayRev;
  activeRevisionId: string | null;
  rig: RigInfo;
  items: Overview["items"];
  message: string | null;
  setMessage: (m: string | null) => void;
  refresh: () => void;
}) {
  const locale = useLocale();
  const m = useMessages(equipmentMessages).pieces;
  const c = useMessages(commonMessages);
  const [stance, setStance] = useState(rev.stances.find((s) => rig.stances.includes(s)) ?? rev.stances[0]!);
  const [view, setView] = useState<View | null>(null);
  const [comboKey, setComboKey] = useState<string | null>(null);
  const compatible = rev.rigRevisionId === rig.revisionId;
  const request = { config: { rigRevisionId: rig.revisionId, overlayRevisionIds: [rev.revisionId], stance } };

  useEffect(() => {
    if (!compatible) return;
    resolve(projectId, request)
      .then((r) => setView(r.view))
      .catch((err) => setMessage(errorText(err, locale)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, rev.revisionId, stance, compatible]);

  const combo = view?.combos.find((c) => c.key === comboKey) ?? view?.combos.find((c) => c.clip && c.frames.some((f) => f.layers.some((l) => l.overlayRevisionId === rev.revisionId))) ?? view?.combos.find((c) => c.clip) ?? null;

  async function decide(decision: "approve" | "reject") {
    setMessage(null);
    try {
      await review(projectId, rev.assetId, rev.revisionId, decision, activeRevisionId, decision === "reject" ? m.rejectReason : null);
      setMessage(decision === "approve" ? m.approved(rev.number) : m.rejected(rev.number));
      refresh();
    } catch (err) {
      setMessage(errorText(err, locale));
    }
  }

  return (
    <>
      <h2>
        {rev.name} r{rev.number} <span className={`badge state-${rev.status}`}>{labelOf(c.revisionStatus, rev.status)}</span>
      </h2>
      <p className="small muted">
        {m.info(rev.slots.join(", "), rev.stances.join(", "))}
        {rev.parts.length > 0 && m.parts(rev.parts.map((p) => m.partCells(p.partId, p.cells, p.empty)).join(", "))}
        {rev.rigidViews.length > 0 && m.rigidInfo(rev.rigidViews.length, rev.placements)}
      </p>
      <div className="row">
        {rev.status === "candidate" && (
          <>
            <button type="button" onClick={() => decide("approve")}>
              {c.approve}
            </button>
            <button type="button" className="secondary" onClick={() => decide("reject")}>
              {c.reject}
            </button>
          </>
        )}
      </div>
      {message && <p className="small">{message}</p>}
      <ItemLink projectId={projectId} rev={rev} items={items} onSaved={(m) => (setMessage(m), refresh())} onError={setMessage} />
      {!compatible && <p className="small error">{m.foreign(rev.rigRevisionId)}</p>}

      {rev.rigidViews.length > 0 && <RigidViews projectId={projectId} rev={rev} rig={rig} onSaved={(m) => (setMessage(m), refresh())} onError={(m) => setMessage(m)} />}

      {compatible && view && (
        <>
          <h3 className="small">{m.overlaidTitle}</h3>
          <div className="row small">
            <label>
              {m.stance}
              <select value={stance} onChange={(e) => setStance(e.target.value)}>
                {rev.stances.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            {view.combos
              .filter((c) => c.clip)
              .map((c) => (
                <button key={c.key} type="button" className={combo?.key === c.key ? "" : "secondary"} onClick={() => setComboKey(c.key)}>
                  {c.action} · {c.direction}
                </button>
              ))}
          </div>
          {combo?.clip && <ResolvedPlayer key={combo.key} projectId={projectId} combo={combo} request={request} />}
        </>
      )}
    </>
  );
}

function RigidViews({ projectId, rev, rig, onSaved, onError }: { projectId: string; rev: OverlayRev; rig: RigInfo; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const locale = useLocale();
  const m = useMessages(equipmentMessages).pieces;
  const text = useText();
  const [editing, setEditing] = useState<{ viewId: string; grips: { socketId: string; at: [number, number] }[] } | null>(null);
  const [socket, setSocket] = useState(rig.sockets.find((s) => s.purpose === "grip")?.socketId ?? "");
  const zoom = 6;
  return (
    <>
      <h3 className="small">{m.rigidTitle}</h3>
      <div className="eq-views">
        {rev.rigidViews.map((v) => {
          const grips = editing?.viewId === v.viewId ? editing.grips : v.grips;
          return (
            <figure key={v.viewId}>
              <div className="row">
                {BGS.map((bg) => (
                  <ViewCanvas
                    key={bg}
                    src={mediaUrl(projectId, v.mediaId)}
                    rect={v.rect}
                    zoom={zoom}
                    bg={bg}
                    grips={grips}
                    onPick={
                      bg === "checker" && socket
                        ? (at) => {
                            const base = editing?.viewId === v.viewId ? editing.grips : v.grips;
                            setEditing({ viewId: v.viewId, grips: [...base.filter((g) => g.socketId !== socket), { socketId: socket, at }] });
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
              <figcaption>
                <strong>{v.viewId}</strong> · {v.rect[2]}×{v.rect[3]} · {m.grips(grips.map((g) => `${g.socketId} (${g.at.join(", ")})`).join(", "))}
                {v.mirrorAllowed ? m.mirrorAllowed : ""}
              </figcaption>
            </figure>
          );
        })}
      </div>
      <div className="row small">
        <label>
          {m.markGripFor}
          <select value={socket} onChange={(e) => setSocket(e.target.value)}>
            {rig.sockets.filter((s) => s.purpose === "grip").map((s) => (
              <option key={s.socketId}>{s.socketId}</option>
            ))}
          </select>
        </label>
        {editing && (
          <>
            <button
              type="button"
              onClick={async () => {
                try {
                  const res = await apiFetch<{ revision: { number: number }; summary: TextValue }>(`/projects/${projectId}/equipment/overlays`, { method: "POST", json: { op: "set_grips", overlayRevisionId: rev.revisionId, viewId: editing.viewId, grips: editing.grips } });
                  setEditing(null);
                  onSaved(m.newRevision(text(res.summary), res.revision.number));
                } catch (err) {
                  onError(errorText(err, locale));
                }
              }}
            >
              {m.saveGrips}
            </button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              {m.undo}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** Vista recortada do atlas em zoom inteiro, com as empunhaduras marcadas (clique = marcar pixel). */
function ViewCanvas({ src, rect, zoom, bg, grips, onPick }: { src: string; rect: [number, number, number, number]; zoom: number; bg: string; grips: { socketId: string; at: [number, number] }[]; onPick?: (at: [number, number]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = src;
  }, [src]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const [sx, sy, sw, sh] = rect;
    c.width = sw * zoom;
    c.height = sh * zoom;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    if (img) ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw * zoom, sh * zoom);
    for (const g of grips) {
      ctx.strokeStyle = g.socketId.includes("right") ? "#ff8c00" : "#00b4ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(g.at[0] * zoom + 1, g.at[1] * zoom + 1, zoom - 2, zoom - 2);
    }
  }, [img, rect, zoom, grips]);
  return (
    <canvas
      ref={ref}
      className={`pixel bg-${bg}`}
      style={{ cursor: onPick ? "crosshair" : "default" }}
      onClick={(e) => {
        if (!onPick) return;
        const r = e.currentTarget.getBoundingClientRect();
        onPick([Math.floor(((e.clientX - r.left) / r.width) * rect[2]), Math.floor(((e.clientY - r.top) / r.height) * rect[3])]);
      }}
    />
  );
}

/** Item de inventário ligado à peça: o ícone e a arte equipada são variantes do mesmo item. */
function ItemLink({ projectId, rev, items, onSaved, onError }: { projectId: string; rev: OverlayRev; items: Overview["items"]; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const locale = useLocale();
  const m = useMessages(equipmentMessages).pieces;
  const text = useText();
  const current = items.find((i) => i.revisionId === rev.itemRevisionId);
  return (
    <div className="row small">
      <span>{m.inventoryItem}</span>
      {current?.icon?.mediaId && (
        <ViewCanvas src={mediaUrl(projectId, current.icon.mediaId)} rect={current.icon.rect} zoom={2} bg="checker" grips={[]} />
      )}
      <select
        value={rev.itemRevisionId ?? ""}
        onChange={async (e) => {
          try {
            const res = await apiFetch<{ revision: { number: number }; summary: TextValue }>(`/projects/${projectId}/equipment/overlays`, { method: "POST", json: { op: "set_item", overlayRevisionId: rev.revisionId, itemRevisionId: e.target.value || null } });
            onSaved(m.newRevision(text(res.summary), res.revision.number));
          } catch (err) {
            onError(errorText(err, locale));
          }
        }}
      >
        <option value="">{m.noItem}</option>
        {items.map((i) => (
          <option key={i.revisionId} value={i.revisionId}>
            {i.name}
          </option>
        ))}
      </select>
      {rev.itemRevisionId && !current && <span className="muted">{m.notActive(rev.itemRevisionId)}</span>}
    </div>
  );
}
