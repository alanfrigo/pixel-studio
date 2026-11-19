"use client";

import { useState } from "react";
import type { GenerationPlan } from "@/contracts";
import type { CoveragePlanSummary } from "@/server/equipment/plans";
import { ApiError, apiFetch } from "@/app/client/api";
import { estimateText } from "@/app/client/cost";
import type { CoveragePrefill } from "./loadout-workspace";
import { errorText, type Overview, type RigInfo } from "./shared";

/**
 * "Criar peça para este personagem" (04 §criar uma roupa): escolher base,
 * slots, movimentos e vistas; ver a matriz de cobertura e o número de tiras
 * ANTES de gerar; começar por uma pose de prova; reaproveitar poses
 * equivalentes e gerar só as lacunas. A rota de cada perfil é dita pelo que
 * ela faz: em rota genérica, candidato vestido + extração local por máscara.
 * Também extrai a peça de um clipe vestido ("transferir roupa") ou de imagens
 * importadas, sem custo.
 */

interface PlanResult {
  plan: GenerationPlan;
  digest: string;
  destination: { name: string; simulated: boolean };
  summary: CoveragePlanSummary;
  costCheck: { kind: string; withinCeiling: boolean | null };
}

const FATE_LABEL: Record<string, string> = { existing: "já coberta", empty: "vazia explícita", reused: "reaproveita pose equivalente", generate: "gerar", later: "depois da prova" };

export function CreatePiece({ projectId, overview, rig, prefill, refresh }: { projectId: string; overview: Overview; rig: RigInfo; prefill: CoveragePrefill | null; refresh: () => void }) {
  const profiles = overview.profiles.filter((p) => !p.unavailable);
  const [profileId, setProfileId] = useState(profiles.find((p) => p.simulated)?.id ?? profiles[0]?.id ?? "");
  const profile = overview.profiles.find((p) => p.id === profileId);
  const [mode, setMode] = useState<"coverage" | "rigid_view">("coverage");
  // Pré-preenchido pela matriz/pendência (o pai remonta este painel a cada pedido).
  const foreign = prefill?.foreign;
  const pieces = overview.overlays.flatMap((g) => g.revisions.filter((r) => r.active && r.rigRevisionId === rig.revisionId).map((r) => ({ ...r, group: g })));
  const [overlayRevisionId, setOverlayRevisionId] = useState<string>(() => (prefill?.overlayRevisionId && pieces.some((p) => p.revisionId === prefill.overlayRevisionId) ? prefill.overlayRevisionId : ""));
  const [itemName, setItemName] = useState(foreign ? `${foreign.name} (para ${rig.name})` : "");
  const [slots, setSlots] = useState<string[]>(foreign ? foreign.slots.filter((s) => rig.slots.some((x) => x.slotId === s)) : ["torso"]);
  const [stances, setStances] = useState<string[]>(foreign ? foreign.stances.filter((s) => rig.stances.includes(s)) : rig.stances);
  const [description, setDescription] = useState(foreign?.name ?? "cota de malha de ferro com rebites");
  const pieceParts = rig.parts.filter((p) => !rig.baseParts.includes(p.partId));
  const [parts, setParts] = useState<string[]>(() => (prefill?.partIds.length ? prefill.partIds.filter((p) => rig.parts.some((x) => x.partId === p)) : pieceParts.slice(0, 1).map((p) => p.partId)));
  const clips = overview.clips.filter((c) => c.rigRevisionId === rig.revisionId && c.active && c.status === "approved");
  const [clipIds, setClipIds] = useState<string[]>(() => (prefill?.clipRevisionIds ?? []).filter((id) => clips.some((c) => c.revisionId === id)));
  const [framesPerStrip, setFramesPerStrip] = useState(4);
  /** Folga da zona autorizada em px (ombreiras, capas, mangas mais largas que a peça anterior). */
  const [growZonePx, setGrowZonePx] = useState(1);
  const [proof, setProof] = useState<string>("");
  const [regenerate, setRegenerate] = useState(false);
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [view, setView] = useState({ viewId: "up", w: 7, h: 28, grip1: rig.sockets[0]?.socketId ?? "hand_right", g1x: 3, g1y: 23, grip2: "", g2x: 3, g2y: 26, orientation: "vertical_up", mirrorAllowed: false });
  const [result, setResult] = useState<PlanResult | null>(null);
  const [reuse, setReuse] = useState<unknown[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);


  const proofOptions = clips.filter((c) => clipIds.includes(c.revisionId)).flatMap((c) => c.frames.map((f) => ({ key: `${c.revisionId}|${f.frameId}`, label: `${c.name} · ${f.frameId}` })));

  function body() {
    const common = {
      operation: "generate_overlay_coverage",
      providerProfileId: profileId,
      rigRevisionId: rig.revisionId,
      overlayRevisionId: overlayRevisionId || null,
      ...(overlayRevisionId ? {} : { item: { slots, stances } }),
      description,
      mode,
    };
    if (mode === "rigid_view") {
      return {
        ...common,
        view: {
          viewId: view.viewId,
          size: [view.w, view.h],
          grips: [{ socketId: view.grip1, at: [view.g1x, view.g1y] }, ...(view.grip2 ? [{ socketId: view.grip2, at: [view.g2x, view.g2y] }] : [])],
          mirrorAllowed: view.mirrorAllowed,
          orientation: view.orientation,
        },
      };
    }
    const [pc, pf] = proof ? proof.split("|") : [];
    return { ...common, parts, clips: clipIds.map((clipRevisionId) => ({ clipRevisionId })), framesPerStrip, growZonePx, regenerate, ...(pc ? { proofPose: { clipRevisionId: pc, frameId: pf } } : {}) };
  }

  async function preview() {
    setBusy(true);
    setMessage(null);
    setReuse(null);
    try {
      setResult(await apiFetch<PlanResult>(`/projects/${projectId}/equipment/coverage/plan`, { method: "POST", json: body() }));
    } catch (err) {
      setResult(null);
      if (err instanceof ApiError && err.details?.nothingToGenerate && Array.isArray(err.details.reused) && err.details.reused.length) setReuse(err.details.reused);
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch<{ job: { id: string; state: string }; created: boolean }>(`/projects/${projectId}/equipment/coverage/run`, {
        method: "POST",
        json: { plan: body(), ...(overlayRevisionId ? {} : { newItemName: itemName || description.slice(0, 60) }), allowUnknownCost: allowUnknown },
      });
      setMessage(res.created ? `Job ${res.job.id} enfileirado. A peça volta como revisão CANDIDATA (aprove na aba Peças).` : `Mesmo plano: job ${res.job.id} já existe (sem cobrança duplicada).`);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyReuse() {
    if (!reuse || !overlayRevisionId) return;
    try {
      const res = await apiFetch<{ revision: { number: number }; applied: number }>(`/projects/${projectId}/equipment/overlays/reuse`, { method: "POST", json: { overlayRevisionId, reused: reuse } });
      setMessage(`${res.applied} célula(s) reaproveitada(s) sem gerar nada: revisão r${res.revision.number} (candidata).`);
      setReuse(null);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  const toggle = (list: string[], v: string, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  return (
    <>
      <section>
        <h2>Criar peça para este personagem</h2>
        <div className="row">
          <label>
            Perfil
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {overview.profiles.map((p) => (
                <option key={p.id} value={p.id} disabled={Boolean(p.unavailable)}>
                  {p.name}
                  {p.simulated ? " (simulado)" : ""}
                  {p.unavailable ? " — indisponível" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tipo
            <select value={mode} onChange={(e) => (setMode(e.target.value as typeof mode), setResult(null))}>
              <option value="coverage">roupa/armadura por frame (cobertura)</option>
              <option value="rigid_view">peça rígida (vista com empunhadura)</option>
            </select>
          </label>
          <label>
            Peça
            <select value={overlayRevisionId} onChange={(e) => setOverlayRevisionId(e.target.value)}>
              <option value="">nova peça</option>
              {pieces.map((p) => (
                <option key={p.revisionId} value={p.revisionId}>
                  {p.group.name} r{p.number} (gerar só lacunas)
                </option>
              ))}
            </select>
          </label>
        </div>
        {profile && (
          <ul className="anim-routes small">
            <li>Cobertura: {profile.routes.coverage ?? <span className="error">indisponível neste perfil</span>}</li>
            <li>Vista rígida: {profile.routes.rigid ?? <span className="error">indisponível neste perfil</span>}</li>
          </ul>
        )}
        {overview.profiles
          .filter((p) => p.unavailable)
          .map((p) => (
            <p key={p.id} className="small muted">
              {p.name}: {p.unavailable}
            </p>
          ))}
        {!overlayRevisionId && (
          <div className="row small">
            <label>
              Nome do item
              <input value={itemName} placeholder="Cota de malha" onChange={(e) => setItemName(e.target.value)} />
            </label>
            <span>Slots:</span>
            {rig.slots.map((s) => (
              <label key={s.slotId} style={{ flexDirection: "row", gap: 4 }}>
                <input type="checkbox" checked={slots.includes(s.slotId)} onChange={(e) => setSlots(toggle(slots, s.slotId, e.target.checked))} />
                {s.label}
              </label>
            ))}
            <span>Posturas:</span>
            {rig.stances.map((s) => (
              <label key={s} style={{ flexDirection: "row", gap: 4 }}>
                <input type="checkbox" checked={stances.includes(s)} onChange={(e) => setStances(toggle(stances, s, e.target.checked))} />
                {s}
              </label>
            ))}
          </div>
        )}
        <label>
          Descrição da peça (material, forma)
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        {mode === "coverage" ? (
          <>
            <div className="row small">
              <span>Partes desenháveis:</span>
              {pieceParts.map((p) => (
                <label key={p.partId} style={{ flexDirection: "row", gap: 4 }}>
                  <input type="checkbox" checked={parts.includes(p.partId)} onChange={(e) => setParts(toggle(parts, p.partId, e.target.checked))} />
                  {p.label}
                </label>
              ))}
            </div>
            <p className="small">Movimentos e vistas a entregar (clipes aprovados da base):</p>
            <div className="row small">
              {clips.map((c) => (
                <label key={c.revisionId} style={{ flexDirection: "row", gap: 4 }}>
                  <input type="checkbox" checked={clipIds.includes(c.revisionId)} onChange={(e) => setClipIds(toggle(clipIds, c.revisionId, e.target.checked))} />
                  {c.name} ({c.frames.length} frames)
                </label>
              ))}
            </div>
            <div className="row small">
              <label>
                Frames por tira
                <select value={framesPerStrip} onChange={(e) => setFramesPerStrip(Number(e.target.value))}>
                  {[1, 2, 4, 6].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? "1 (um frame por imagem)" : `${n} (grade)`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Pose de prova
                <select value={proof} onChange={(e) => setProof(e.target.value)}>
                  <option value="">gerar todas as lacunas</option>
                  {proofOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label title="Amplia a zona em que o modelo pode desenhar a peça; olhos e mãos da base continuam protegidos">
                Ampliar zona da roupa
                <select value={growZonePx} onChange={(e) => setGrowZonePx(Number(e.target.value))}>
                  {[0, 1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? "sem folga" : `+${n} px`}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flexDirection: "row", gap: 4 }}>
                <input type="checkbox" checked={regenerate} onChange={(e) => setRegenerate(e.target.checked)} /> refazer células já cobertas
              </label>
            </div>
          </>
        ) : (
          <div className="row small">
            <label>
              Vista
              <input value={view.viewId} onChange={(e) => setView({ ...view, viewId: e.target.value })} style={{ width: 80 }} />
            </label>
            <label>
              Tamanho
              <span className="row">
                <input type="number" min={2} max={128} value={view.w} style={{ width: 56 }} onChange={(e) => setView({ ...view, w: Number(e.target.value) })} />×
                <input type="number" min={2} max={128} value={view.h} style={{ width: 56 }} onChange={(e) => setView({ ...view, h: Number(e.target.value) })} />
              </span>
            </label>
            <label>
              Orientação
              <select value={view.orientation} onChange={(e) => setView({ ...view, orientation: e.target.value })}>
                <option value="vertical_up">vertical, ponta para cima</option>
                <option value="vertical_down">vertical, ponta para baixo</option>
                <option value="horizontal_right">horizontal, para a direita</option>
                <option value="horizontal_left">horizontal, para a esquerda</option>
                <option value="diagonal_up">diagonal para cima</option>
                <option value="diagonal_down">diagonal para baixo</option>
              </select>
            </label>
            <label>
              Empunhadura 1
              <span className="row">
                <select value={view.grip1} onChange={(e) => setView({ ...view, grip1: e.target.value })}>
                  {rig.sockets.map((s) => (
                    <option key={s.socketId}>{s.socketId}</option>
                  ))}
                </select>
                <input type="number" value={view.g1x} style={{ width: 48 }} onChange={(e) => setView({ ...view, g1x: Number(e.target.value) })} />
                <input type="number" value={view.g1y} style={{ width: 48 }} onChange={(e) => setView({ ...view, g1y: Number(e.target.value) })} />
              </span>
            </label>
            <label>
              Segunda mão (dupla empunhadura)
              <span className="row">
                <select value={view.grip2} onChange={(e) => setView({ ...view, grip2: e.target.value })}>
                  <option value="">nenhuma</option>
                  {rig.sockets.map((s) => (
                    <option key={s.socketId}>{s.socketId}</option>
                  ))}
                </select>
                <input type="number" value={view.g2x} style={{ width: 48 }} onChange={(e) => setView({ ...view, g2x: Number(e.target.value) })} />
                <input type="number" value={view.g2y} style={{ width: 48 }} onChange={(e) => setView({ ...view, g2y: Number(e.target.value) })} />
              </span>
            </label>
            <label style={{ flexDirection: "row", gap: 4 }}>
              <input type="checkbox" checked={view.mirrorAllowed} onChange={(e) => setView({ ...view, mirrorAllowed: e.target.checked })} /> arte simétrica (autorizar espelho)
            </label>
          </div>
        )}
        <div className="row">
          <button type="button" disabled={busy || !profileId} onClick={preview}>
            Ver plano (matriz e tiras)
          </button>
          <label style={{ flexDirection: "row", gap: 4 }} className="small">
            <input type="checkbox" checked={allowUnknown} onChange={(e) => setAllowUnknown(e.target.checked)} /> aceito custo desconhecido
          </label>
          <button type="button" disabled={busy || !result} onClick={run}>
            Gerar {result ? `(${result.plan.parts.length} envio(s))` : ""}
          </button>
          {reuse && overlayRevisionId && (
            <button type="button" className="secondary" onClick={applyReuse}>
              Aplicar reaproveitamento ({reuse.length} célula(s), sem custo)
            </button>
          )}
        </div>
        {message && <p className="small">{message}</p>}
      </section>

      {result && <PlanSummary result={result} />}
      <ExtractPanel projectId={projectId} overview={overview} rig={rig} refresh={refresh} />
      <JobsList overview={overview} />
    </>
  );
}

function PlanSummary({ result }: { result: PlanResult }) {
  const s = result.summary;
  const clipsInCells = [...new Set(s.cells.map((c) => c.clipName))];
  return (
    <section>
      <h2>Plano congelado</h2>
      <p className="small">
        <strong>{s.routeLabel}</strong> · destino {result.destination.name}
        {result.destination.simulated ? " (simulado)" : ""} · custo estimado{" "}
        {estimateText(result.plan)}
      </p>
      <p className="small">
        {s.requested} célula(s) pedida(s): {s.existing} já coberta(s), {s.empty} vazia(s), {s.reused} reaproveitada(s) de pose equivalente, <strong>{s.toGenerate} a gerar</strong> em <strong>{s.strips.length} tira(s)</strong>.
      </p>
      {s.strips.length > 0 && (
        <table className="eq-matrix">
          <thead>
            <tr>
              <th>Tira</th>
              <th>Clipe</th>
              <th>Frames</th>
              <th>Grade</th>
              <th>Tela</th>
            </tr>
          </thead>
          <tbody>
            {s.strips.map((st) => (
              <tr key={st.stripKey}>
                <td>{st.stripKey}</td>
                <td>{st.clipName}</td>
                <td>{st.frameIds.join(", ")}</td>
                <td>{st.grid}</td>
                <td>{st.canvas.join("×")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s.cells.length > 0 && (
        <div className="eq-scroll" style={{ marginTop: 8 }}>
          <table className="eq-matrix">
            <tbody>
              {clipsInCells.map((name) => (
                <tr key={name}>
                  <th style={{ textAlign: "left" }}>{name}</th>
                  {s.cells
                    .filter((c) => c.clipName === name)
                    .map((c) => (
                      <td key={`${c.frameId}-${c.partId}`} className={c.fate === "generate" ? "missing" : c.fate === "later" ? "stale" : c.fate === "empty" ? "empty" : "covered"} title={`${c.frameId} · ${c.partId}: ${FATE_LABEL[c.fate]}`}>
                        {c.frameId}/{c.partId}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.warnings.map((w) => (
        <p key={w} className="small muted">
          {w}
        </p>
      ))}
      <details className="small">
        <summary>Prompt compilado e fontes</summary>
        <pre>{result.plan.prompt.compiled}</pre>
        <pre>{JSON.stringify(result.plan.sources, null, 2)}</pre>
      </details>
    </section>
  );
}

function ExtractPanel({ projectId, overview, rig, refresh }: { projectId: string; overview: Overview; rig: RigInfo; refresh: () => void }) {
  const targets = overview.clips.filter((c) => c.rigRevisionId === rig.revisionId && c.status === "approved");
  const [target, setTarget] = useState("");
  const t = targets.find((c) => c.revisionId === target);
  const sources = overview.clips.filter((c) => t && c.revisionId !== t.revisionId && c.logicalSize[0] === t.logicalSize[0] && c.logicalSize[1] === t.logicalSize[1] && t.frames.every((f) => c.frames.some((x) => x.frameId === f.frameId)));
  const [source, setSource] = useState("");
  const pieces = overview.overlays.flatMap((g) => g.revisions.filter((r) => r.active && r.rigRevisionId === rig.revisionId).map((r) => ({ ...r, group: g })));
  const [overlay, setOverlay] = useState("");
  const [name, setName] = useState("Peça extraída");
  const [part, setPart] = useState(rig.parts.find((p) => p.partId === "torso")?.partId ?? rig.parts[0]?.partId ?? "");
  const [out, setOut] = useState<{ revision: { number: number }; warnings: string[]; previews: Record<string, string> } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <section>
      <h2>Extrair cobertura de um clipe vestido (sem custo)</h2>
      <p className="small muted">
        Aceita o clipe candidato da operação “transferir roupa” (estado <code>outfit_*</code>) ou qualquer clipe com os mesmos frames e célula: a peça é a diferença contra a base limpa dentro da zona autorizada, com mãos protegidas.
      </p>
      <div className="row small">
        <label>
          Clipe limpo (alvo)
          <select value={target} onChange={(e) => (setTarget(e.target.value), setSource(""))}>
            <option value="">escolha</option>
            {targets.map((c) => (
              <option key={c.revisionId} value={c.revisionId}>
                {c.name} r{c.number}
              </option>
            ))}
          </select>
        </label>
        <label>
          Clipe vestido
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">escolha</option>
            {sources.map((c) => (
              <option key={c.revisionId} value={c.revisionId}>
                {c.name} r{c.number}
                {c.state?.startsWith("outfit_") ? " · transferir roupa" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Peça
          <select value={overlay} onChange={(e) => setOverlay(e.target.value)}>
            <option value="">nova</option>
            {pieces.map((p) => (
              <option key={p.revisionId} value={p.revisionId}>
                {p.group.name} r{p.number}
              </option>
            ))}
          </select>
        </label>
        {!overlay && (
          <label>
            Nome
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label>
          Parte
          <select value={part} onChange={(e) => setPart(e.target.value)}>
            {rig.parts.map((p) => (
              <option key={p.partId} value={p.partId}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!target || !source}
          onClick={async () => {
            setMessage(null);
            try {
              const res = await apiFetch<{ revision: { number: number }; warnings: string[]; previews: Record<string, string> }>(`/projects/${projectId}/equipment/extract`, {
                method: "POST",
                json: {
                  targetClipRevisionId: target,
                  source: { kind: "clip", clipRevisionId: source },
                  overlayRevisionId: overlay || null,
                  ...(overlay ? {} : { item: { name, slots: ["torso"], stances: rig.stances } }),
                  parts: [part],
                },
              });
              setOut(res);
              refresh();
            } catch (err) {
              setMessage(errorText(err));
            }
          }}
        >
          Extrair
        </button>
      </div>
      {message && <p className="small error">{message}</p>}
      {out && (
        <>
          <p className="small">
            Revisão candidata r{out.revision.number} publicada. {out.warnings.length ? `Avisos: ${out.warnings.join("; ")}` : "Sem avisos."}
          </p>
          <div className="row">
            {Object.entries(out.previews).map(([frameId, src]) => (
              <figure key={frameId} style={{ margin: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="pixel" src={src} alt={`Base + peça em ${frameId}`} width={128} height={128} />
                <figcaption className="small">{frameId}</figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function JobsList({ overview }: { overview: Overview }) {
  if (overview.jobs.length === 0) return null;
  return (
    <section>
      <h2>Gerações recentes</h2>
      <ul className="list small">
        {overview.jobs.map((j) => (
          <li key={j.id}>
            {j.id} · <span className={`badge state-${j.state}`}>{j.state}</span>
            {j.error ? ` · ${(j.error as { message?: string }).message ?? ""}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
