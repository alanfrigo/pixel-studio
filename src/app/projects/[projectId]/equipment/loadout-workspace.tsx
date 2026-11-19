"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Insets, LayerRef } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { type CellTarget, CoverageMatrix } from "./coverage-matrix";
import { ResolvedPlayer } from "./resolved-player";
import { type Config, configOf, DIR_LABEL, errorText, type Overview, type Pendency, resolve, review, type RigInfo, STATUS_LABEL, type View, whereText } from "./shared";

/**
 * Editor de conjuntos (04 §caso de ponta a ponta): catálogo de peças, slots,
 * postura pela combinação, variante de clipe, conflitos com "Substituir",
 * player do clipe resolvido, matriz de cobertura e publicação como revisão
 * candidata. Trocar de conjunto ou de item nunca chama provedor.
 */

export interface CoveragePrefill {
  overlayRevisionId: string | null;
  clipRevisionIds: string[];
  partIds: string[];
  foreign?: { name: string; slots: string[]; stances: string[] };
}

type Mode = { kind: "published"; revisionId: string } | { kind: "draft"; config: Config; assetId: string | null; name: string };

export function LoadoutWorkspace({ projectId, overview, rig, refresh, onCreateCoverage }: { projectId: string; overview: Overview; rig: RigInfo; refresh: () => void; onCreateCoverage: (p: CoveragePrefill) => void }) {
  const loadouts = overview.loadouts.filter((g) => g.revisions.some((r) => r.rigRevisionId === rig.revisionId));
  const initial = loadouts[0]?.activeRevisionId ?? loadouts[0]?.revisions[0]?.revisionId ?? null;
  const [mode, setMode] = useState<Mode>(initial ? { kind: "published", revisionId: initial } : { kind: "draft", config: { rigRevisionId: rig.revisionId, overlayRevisionIds: [] }, assetId: null, name: "" });
  const [view, setView] = useState<View | null>(null);
  const [comboKey, setComboKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [flatten, setFlatten] = useState(true);
  const [subsetReason, setSubsetReason] = useState("");
  const [exportInfo, setExportInfo] = useState<{ id: string; state: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const request = useMemo(() => (mode.kind === "published" ? { loadoutRevisionId: mode.revisionId } : { config: mode.config }), [mode]);

  const [reloads, setReloads] = useState(0);
  const load = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    resolve(projectId, request)
      .then((res) => alive && setView(res.view))
      .catch((err) => alive && setMessage(errorText(err)));
    return () => {
      alive = false;
    };
  }, [projectId, request, reloads]);

  const combo = view?.combos.find((c) => c.key === comboKey) ?? view?.combos.find((c) => c.clip) ?? null;
  const published = mode.kind === "published" ? loadouts.flatMap((g) => g.revisions).find((r) => r.revisionId === mode.revisionId) : null;
  const publishedGroup = published ? loadouts.find((g) => g.assetId === published.assetId) : null;
  const currentConfig: Config | null = mode.kind === "draft" ? mode.config : published ? configOf(published) : null;

  const pieces = overview.overlays
    .map((g) => ({ group: g, rev: g.revisions.find((r) => r.revisionId === g.activeRevisionId) ?? g.revisions[0]! }))
    .filter((p) => p.rev);

  async function act<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setMessage(null);
    try {
      const out = await fn();
      return out;
    } catch (err) {
      setMessage(`${label}: ${errorText(err)}`);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  function toDraft(config: Config, note?: string) {
    setMode({ kind: "draft", config, assetId: published?.assetId ?? (mode.kind === "draft" ? mode.assetId : null), name: publishedGroup?.name ?? (mode.kind === "draft" ? mode.name : "") });
    if (note) setMessage(note);
  }

  /** Equipar no rascunho SEM retirar nada: se houver disputa de slot, a pendência explica e oferece "Substituir". */
  function equip(overlayRevisionId: string) {
    if (!currentConfig) return;
    if (currentConfig.overlayRevisionIds.includes(overlayRevisionId)) return;
    toDraft({ ...currentConfig, stance: null, overlayRevisionIds: [...currentConfig.overlayRevisionIds, overlayRevisionId] });
  }

  /** "Substituir": UMA operação que retira quem disputa os slots da peça (e revisão anterior do mesmo item). */
  async function replace(overlayRevisionId: string) {
    if (!currentConfig) return;
    const base = { ...currentConfig, overlayRevisionIds: currentConfig.overlayRevisionIds.filter((id) => id !== overlayRevisionId) };
    const res = await act("Substituir", () => resolve(projectId, { config: base }, overlayRevisionId));
    if (res?.config) {
      toDraft(res.config, res.replacement?.removed.length ? `Substituído: ${res.replacement.removed.map(nameOf).join(", ")} saiu para liberar os slots de ${nameOf(overlayRevisionId)}. Publique para registrar.` : undefined);
      setView(res.view);
    }
  }

  /** Conjunto publicado: troca e publica a revisão nova numa só ação (sem passar pelo rascunho). */
  async function swapAndPublish(overlayRevisionId: string) {
    if (mode.kind !== "published") return;
    const res = await act("Troca", () =>
      apiFetch<{ revision: { id: string; number: number }; replacement: { removed: string[] }; droppedOrderOverrides: number }>(`/projects/${projectId}/equipment/loadouts/swap`, {
        method: "POST",
        json: { loadoutRevisionId: mode.revisionId, incomingOverlayRevisionId: overlayRevisionId, flatten },
      }),
    );
    if (res) {
      setMode({ kind: "published", revisionId: res.revision.id });
      setMessage(`Troca publicada como r${res.revision.number} (candidata). Retirado: ${res.replacement.removed.length ? res.replacement.removed.map(nameOf).join(", ") : "nada"}. Nenhuma chamada a provedor.`);
      refresh();
    }
  }

  function nameOf(revisionId: string): string {
    return overview.overlays.find((g) => g.revisions.some((r) => r.revisionId === revisionId))?.name ?? revisionId;
  }

  function replaceOverlay(oldId: string, newId: string, note: string) {
    if (!currentConfig) return;
    toDraft({ ...currentConfig, overlayRevisionIds: currentConfig.overlayRevisionIds.map((id) => (id === oldId ? newId : id)) }, note);
    refresh();
  }

  async function matrixAction(action: "create_coverage" | "mark_empty" | "remove_cell" | "rebind" | "place" | "create_for_base", cell: CellTarget, extra?: { viewId: string; anchorSocketId: string; drawIndex: number; mirrored: boolean }) {
    if (action === "create_coverage") {
      onCreateCoverage({ overlayRevisionId: cell.overlayRevisionId, clipRevisionIds: [cell.clipRevisionId], partIds: [cell.partId] });
      return;
    }
    if (action === "create_for_base") {
      const ov = view?.overlays.find((o) => o.revisionId === cell.overlayRevisionId);
      onCreateCoverage({ overlayRevisionId: null, clipRevisionIds: view?.combos.filter((c) => c.clip).map((c) => c.clip!.revisionId) ?? [], partIds: ov?.parts ?? [], foreign: ov ? { name: ov.name, slots: ov.slots, stances: ov.stances } : undefined });
      return;
    }
    if (action === "rebind") {
      const res = await act("Revincular", () =>
        apiFetch<{ revision: { id: string; number: number } | null; rebound: unknown[]; review: { partId: string; frameId: string }[] }>(`/projects/${projectId}/equipment/overlays/rebind`, {
          method: "POST",
          json: { overlayRevisionId: cell.overlayRevisionId, toClipRevisionId: cell.clipRevisionId },
        }),
      );
      if (res?.revision) replaceOverlay(cell.overlayRevisionId, res.revision.id, `${res.rebound.length} célula(s) revinculada(s) com os mesmos blobs; ${res.review.length} a revisar (${res.review.map((r) => `${r.partId}/${r.frameId}`).join(", ") || "nenhuma"}). Aprove a revisão da peça antes de exportar.`);
      else if (res) setMessage(`Nada a revincular: geometria mudou em todos os frames (${res.review.length} a revisar).`);
      return;
    }
    const body =
      action === "place"
        ? { op: "set_placement", overlayRevisionId: cell.overlayRevisionId, clipRevisionId: cell.clipRevisionId, frameId: cell.frameId, ...extra }
        : { op: action, overlayRevisionId: cell.overlayRevisionId, clipRevisionId: cell.clipRevisionId, frameId: cell.frameId, partId: cell.partId };
    const res = await act("Editar peça", () => apiFetch<{ revision: { id: string; number: number }; summary: string }>(`/projects/${projectId}/equipment/overlays`, { method: "POST", json: body }));
    if (res) replaceOverlay(cell.overlayRevisionId, res.revision.id, `${res.summary} — ${cell.overlayName} r${res.revision.number} (candidata; aprove na aba Peças). Rascunho atualizado.`);
  }

  async function publish(subset: boolean) {
    if (!currentConfig || !view) return;
    const ready = view.combos.filter((c) => c.status === "ready").map((c) => ({ action: c.action, direction: c.direction }));
    const res = await act("Publicar", () =>
      apiFetch<{ revision: { id: string; number: number } }>(`/projects/${projectId}/equipment/loadouts`, {
        method: "POST",
        json: {
          ...(mode.kind === "draft" && mode.assetId ? { assetId: mode.assetId } : published ? { assetId: published.assetId } : {}),
          ...(mode.kind === "draft" && mode.name ? { name: mode.name } : {}),
          config: currentConfig,
          flatten,
          ...(subset ? { subset: { combos: ready, reason: subsetReason || "Subconjunto completo; as demais combinações têm pendências" } } : {}),
        },
      }),
    );
    if (res) {
      setMode({ kind: "published", revisionId: res.revision.id });
      setMessage(`Conjunto publicado como r${res.revision.number} (candidata). Aprove abaixo; nenhuma chamada a provedor.`);
      refresh();
    }
  }

  async function saveOrder(clipRevisionId: string, frameId: string, layers: LayerRef[]) {
    if (!currentConfig) return;
    const drawOrder = [...(currentConfig.drawOrder ?? []).filter((o) => !(o.clipRevisionId === clipRevisionId && o.frameId === frameId)), { clipRevisionId, frameId, layers }];
    const config = { ...currentConfig, drawOrder };
    if (mode.kind === "draft") {
      setMode({ ...mode, config });
      setMessage("Ordem do frame salva no rascunho; publique para registrar a revisão.");
      return;
    }
    const res = await act("Salvar ordem", () => apiFetch<{ revision: { id: string; number: number } }>(`/projects/${projectId}/equipment/loadouts`, { method: "POST", json: { assetId: published!.assetId, config, flatten } }));
    if (res) {
      setMode({ kind: "published", revisionId: res.revision.id });
      setMessage(`Override de ordem registrado na revisão r${res.revision.number} (candidata).`);
      refresh();
    }
  }

  async function expand(clipRevisionId: string, margins: Insets) {
    const res = await act("Ampliar célula", () =>
      apiFetch<{ clips: { revision: { id: string; number: number; assetId: string } }[]; overlays: { overlayRevisionId: string; name: string; revision: { id: string; number: number; assetId: string } }[] }>(`/projects/${projectId}/equipment/cell`, {
        method: "POST",
        json: { clips: [{ clipRevisionId, margins }], overlayRevisionIds: currentConfig?.overlayRevisionIds ?? [] },
      }),
    );
    if (!res || !currentConfig) return;
    // Aprova as candidatas da ampliação (clipe e peças) para o resolvedor usar: é a ação explícita do artista neste botão.
    for (const r of [...res.clips.map((c) => c.revision), ...res.overlays.map((o) => o.revision)]) {
      const asset = await apiFetch<{ asset: { approvedRevisionId: string | null } }>(`/projects/${projectId}/assets/${r.assetId}`);
      await review(projectId, r.assetId, r.id, "approve", asset.asset.approvedRevisionId, "Célula ampliada para caber o contorno");
    }
    let config = { ...currentConfig };
    for (const o of res.overlays) config = { ...config, overlayRevisionIds: config.overlayRevisionIds.map((id) => (id === o.overlayRevisionId ? o.revision.id : id)) };
    config = { ...config, pins: (config.pins ?? []).filter((p) => p.clipRevisionId !== clipRevisionId) };
    toDraft(config, `Célula ampliada: clipe r${res.clips[0]!.revision.number} e ${res.overlays.length} peça(s) com coberturas deslocadas (mesmos blobs), aprovados. Publique o conjunto para registrar.`);
    refresh();
  }

  async function exportLoadout() {
    if (mode.kind !== "published") return;
    const res = await act("Exportar", () => apiFetch<{ export: { id: string; state: string } }>(`/projects/${projectId}/exports`, { method: "POST", json: { revisionIds: [mode.revisionId], profile: "portable-v1" } }));
    if (res) setExportInfo(res.export);
  }

  async function checkExport() {
    if (!exportInfo) return;
    const res = await act("Exportação", () => apiFetch<{ export: { id: string; state: string } }>(`/projects/${projectId}/exports/${exportInfo.id}`));
    if (res) setExportInfo(res.export);
  }

  const allPend: Pendency[] = view ? [...view.pendencies, ...view.combos.flatMap((c) => c.pendencies)] : [];
  const rigidViews = Object.fromEntries((view?.overlays ?? []).map((o) => [o.revisionId, o.rigidViews.map((v) => ({ viewId: v.viewId, grips: v.grips }))]));

  return (
    <>
      <section>
        <div className="row">
          <h2 style={{ margin: 0 }}>Conjuntos</h2>
          {loadouts.map((g) =>
            g.revisions.map((r) => (
              <button
                key={r.revisionId}
                type="button"
                className={mode.kind === "published" && mode.revisionId === r.revisionId ? "" : "secondary"}
                onClick={() => (setMode({ kind: "published", revisionId: r.revisionId }), setExportInfo(null), setMessage(null))}
                title={`${g.name} r${r.number}`}
              >
                {g.name} r{r.number} <span className={`badge state-${r.status}`}>{r.status === "approved" ? (r.active ? "ativa" : "aprovada") : r.status === "candidate" ? "candidata" : "reprovada"}</span>
              </button>
            )),
          )}
          <button type="button" className="secondary" onClick={() => setMode({ kind: "draft", config: { rigRevisionId: rig.revisionId, overlayRevisionIds: [] }, assetId: null, name: "" })}>
            + Novo conjunto
          </button>
        </div>
        {message && <p className="small">{message}</p>}
      </section>

      <div className="eq-layout">
        <div>
          <section>
            {mode.kind === "published" && published ? (
              <>
                <h2>
                  {publishedGroup?.name} r{published.number}
                </h2>
                <p className="small">
                  <span className={`badge state-${published.status}`}>{published.status === "approved" ? "aprovada" : published.status === "candidate" ? "candidata" : "reprovada"}</span> · postura {published.stance} ({published.stancePolicy === "pinned" ? "escolhida" : "automática"}) ·{" "}
                  {published.clips.length} combinação(ões){published.omitted.length ? ` · omitidas: ${published.omitted.map((o) => `${o.action}/${o.direction}`).join(", ")}` : ""} · {published.sheets.length} folha(s) achatada(s)
                </p>
                <div className="row">
                  {published.status === "candidate" && (
                    <>
                      <button type="button" disabled={busy} onClick={() => act("Aprovar", () => review(projectId, published.assetId, published.revisionId, "approve", publishedGroup?.activeRevisionId ?? null)).then(refresh)}>
                        Aprovar
                      </button>
                      <button type="button" className="secondary" disabled={busy} onClick={() => act("Reprovar", () => review(projectId, published.assetId, published.revisionId, "reject", publishedGroup?.activeRevisionId ?? null, "Reprovado no editor de conjuntos")).then(refresh)}>
                        Reprovar
                      </button>
                    </>
                  )}
                  <button type="button" className="secondary" onClick={() => toDraft(configOf(published))}>
                    Editar como rascunho
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={exportLoadout}>
                    Exportar (portable-v1)
                  </button>
                </div>
                {exportInfo && (
                  <p className="small">
                    Exportação {exportInfo.id}: {exportInfo.state}{" "}
                    {exportInfo.state === "ready" ? (
                      <a href={`/api/v1/projects/${projectId}/exports/${exportInfo.id}/download`}>baixar ZIP</a>
                    ) : (
                      <button type="button" className="secondary" onClick={checkExport}>
                        Verificar
                      </button>
                    )}
                  </p>
                )}
              </>
            ) : mode.kind === "draft" ? (
              <>
                <h2>Rascunho de conjunto</h2>
                <label>
                  Nome
                  <input value={mode.name} placeholder="Conjunto: espada + cota" onChange={(e) => setMode({ ...mode, name: e.target.value })} />
                </label>
                <div className="row small">
                  <label style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                    <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> incluir folha achatada
                  </label>
                  <button type="button" disabled={busy || !view?.snapshot} onClick={() => publish(false)}>
                    Publicar como candidata
                  </button>
                </div>
                {view && !view.ready && view.combos.some((c) => c.status === "ready") && (
                  <div className="row small">
                    <input value={subsetReason} placeholder="Motivo das combinações omitidas" onChange={(e) => setSubsetReason(e.target.value)} />
                    <button type="button" className="secondary" disabled={busy} onClick={() => publish(true)}>
                      Publicar subconjunto completo ({view.combos.filter((c) => c.status === "ready").length} de {view.combos.length})
                    </button>
                  </div>
                )}
              </>
            ) : null}
          </section>

          {view && (
            <section>
              <h2>Slots e postura</h2>
              <div className="eq-slots">
                {rig.slots.map((s) => {
                  const holders = view.occupancy.bySlot[s.slotId] ?? [];
                  return (
                    <div key={s.slotId} className={`eq-slot small${holders.length > 1 ? " conflict" : ""}`}>
                      <strong>{s.label}</strong>
                      <div>{holders.length ? holders.map(nameOf).join(" + ") : <span className="muted">livre</span>}</div>
                    </div>
                  );
                })}
              </div>
              <p className="small">
                Postura:{" "}
                {view.stance.status === "resolved" ? (
                  <strong>
                    {view.stance.stance} ({view.stance.policy === "pinned" ? "escolhida" : "pela combinação das peças"})
                  </strong>
                ) : view.stance.status === "ambiguous" ? (
                  <select
                    value=""
                    disabled={mode.kind !== "draft"}
                    onChange={(e) => mode.kind === "draft" && setMode({ ...mode, config: { ...mode.config, stance: e.target.value } })}
                  >
                    <option value="">escolha entre {view.stance.candidates.join(", ")}</option>
                    {view.stance.candidates.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <span className="error">nenhuma postura serve a todas as peças</span>
                )}
              </p>
              {view.combos
                .filter((c) => c.lookup?.status === "ambiguous" || (c.lookup?.status === "resolved" && c.lookup.candidates.length > 1))
                .map((c) => (
                  <label key={c.key} className="small">
                    Variante de {c.action}/{c.direction}
                    <select
                      value={c.clip?.revisionId ?? ""}
                      onChange={(e) => currentConfig && toDraft({ ...currentConfig, pins: [...(currentConfig.pins ?? []).filter((p) => !(p.action === c.action && p.direction === c.direction)), { action: c.action, direction: c.direction, clipRevisionId: e.target.value }] })}
                    >
                      <option value="">escolha a variante</option>
                      {c.candidates.map((cand) => (
                        <option key={cand.revisionId} value={cand.revisionId}>
                          {cand.name} r{cand.number}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              {allPend.length > 0 && (
                <>
                  <h3 className="small">Pendências</h3>
                  <ul className="eq-pend small">
                    {allPend.slice(0, 40).map((p, i) => (
                      <li key={i} className={p.blocking ? "blocking" : ""}>
                        {p.message}
                        <div className="muted">{whereText(p)}</div>
                        <PendencyAction
                          projectId={projectId}
                          p={p}
                          view={view}
                          onEquip={(id) => replace(id)}
                          onCreateCoverage={(over) => onCreateCoverage(over)}
                          onShared={() => (refresh(), load())}
                          setMessage={setMessage}
                        />
                      </li>
                    ))}
                  </ul>
                  {allPend.length > 40 && <p className="small muted">+{allPend.length - 40} pendência(s) (veja a matriz)</p>}
                </>
              )}
            </section>
          )}

          <section>
            <h2>Catálogo de peças</h2>
            <ul className="list small">
              {pieces.map(({ group, rev }) => {
                const inSet = currentConfig?.overlayRevisionIds.includes(rev.revisionId);
                const otherBase = rev.rigRevisionId !== rig.revisionId;
                return (
                  <li key={group.assetId}>
                    <strong>{group.name}</strong> r{rev.number} <span className={`badge state-${rev.status}`}>{rev.status}</span>
                    {otherBase && <span className="badge state-failed"> outra base</span>}
                    <div className="muted">
                      slots {rev.slots.join(", ")} · posturas {rev.stances.join(", ")} · {rev.parts.length ? `partes ${rev.parts.map((p) => p.partId).join(", ")}` : `${rev.rigidViews.length} vista(s) rígida(s)`}
                    </div>
                    <div className="row">
                      {!inSet && (
                        <button type="button" disabled={busy} onClick={() => equip(rev.revisionId)}>
                          Equipar
                        </button>
                      )}
                      {!inSet && mode.kind === "published" && (
                        <button type="button" className="secondary" disabled={busy} title="Retira quem disputa os slots e publica a revisão nova do conjunto" onClick={() => swapAndPublish(rev.revisionId)}>
                          Trocar e publicar
                        </button>
                      )}
                      {inSet && mode.kind === "draft" && (
                        <button type="button" className="secondary" onClick={() => setMode({ ...mode, config: { ...mode.config, overlayRevisionIds: mode.config.overlayRevisionIds.filter((id) => id !== rev.revisionId) } })}>
                          Retirar
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <div>
          {view && (
            <section>
              <div className="row small">
                {view.combos.map((c) => (
                  <button key={c.key} type="button" className={combo?.key === c.key ? "" : "secondary"} onClick={() => setComboKey(c.key)} title={STATUS_LABEL[c.status]}>
                    {c.action} · {c.direction} ({DIR_LABEL[c.direction]}) <span className={`badge state-${c.status === "ready" ? "ready" : "failed"}`}>{STATUS_LABEL[c.status]}</span>
                  </button>
                ))}
              </div>
              {combo?.clip ? (
                <ResolvedPlayer key={`${combo.key}-${combo.clip.revisionId}-${JSON.stringify(request)}`} projectId={projectId} combo={combo} request={request} onSaveOrder={saveOrder} onExpand={expand} />
              ) : combo ? (
                <p className="error small">
                  Sem clipe para {combo.action}/{combo.direction} na postura {combo.stance}.{" "}
                  <Link href={`/projects/${projectId}/animation`}>Criar variante na animação</Link>
                </p>
              ) : (
                <p className="muted small">Equipe peças para ver as combinações.</p>
              )}
            </section>
          )}
          {view && (
            <section>
              <h2>Matriz de cobertura</h2>
              <CoverageMatrix view={view} onAction={matrixAction} rigidViews={rigidViews} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function PendencyAction({
  projectId,
  p,
  view,
  onEquip,
  onCreateCoverage,
  onShared,
  setMessage,
}: {
  projectId: string;
  p: Pendency;
  view: View;
  onEquip: (id: string) => void;
  onCreateCoverage: (p: CoveragePrefill) => void;
  onShared: () => void;
  setMessage: (m: string) => void;
}) {
  const w = p.where;
  switch (p.action.kind) {
    case "replace_item":
      return w.overlayRevisionId ? (
        <button type="button" onClick={() => onEquip(w.overlayRevisionId!)}>
          {p.action.label}
        </button>
      ) : null;
    case "create_coverage": {
      const ov = view.overlays.find((o) => o.revisionId === w.overlayRevisionId);
      return (
        <button
          type="button"
          className="secondary"
          onClick={() =>
            p.kind === "incompatible_rig"
              ? onCreateCoverage({ overlayRevisionId: null, clipRevisionIds: view.combos.filter((c) => c.clip).map((c) => c.clip!.revisionId), partIds: ov?.parts ?? [], foreign: ov ? { name: ov.name, slots: ov.slots, stances: ov.stances } : undefined })
              : onCreateCoverage({ overlayRevisionId: w.overlayRevisionId ?? null, clipRevisionIds: w.clipRevisionId ? [w.clipRevisionId] : [], partIds: w.partId && w.partId !== "rigid" ? [w.partId] : [] })
          }
        >
          {p.action.label}
        </button>
      );
    }
    case "create_variant": {
      const combo = view.combos.find((c) => c.action === w.action && c.direction === w.direction);
      return (
        <span className="row">
          <Link className="button secondary" href={`/projects/${projectId}/animation`}>
            {p.action.label}
          </Link>
          {combo?.linkable.map((l) => (
            <button
              key={l.revisionId}
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  await apiFetch(`/projects/${projectId}/equipment/clips/share`, { method: "POST", json: { clipRevisionId: l.revisionId, stance: w.stance } });
                  setMessage(`Vínculo de ${l.name} com ${w.stance} publicado como candidato: aprove o clipe para o resolvedor usar.`);
                  onShared();
                } catch (err) {
                  setMessage(errorText(err));
                }
              }}
            >
              Vincular {l.name} r{l.number} como compartilhado
            </button>
          ))}
        </span>
      );
    }
    default:
      return null;
  }
}
