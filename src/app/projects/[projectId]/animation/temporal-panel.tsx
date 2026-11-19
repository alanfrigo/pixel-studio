"use client";

import { useMemo, useState } from "react";
import type { BasePayload, ClipPayload, Direction } from "@/contracts";
import type { RevisionView } from "@/server/catalog/catalog";
import { ClipPlayer } from "./clip-player";
import { DIRS, errorText, type Overview, type ProfileInfo, routeLabel, uploadPng, viewUrl } from "./shared";
import { FrameThumb, MaskPainter, maskToPng, PlanActions, ReviewButtons, type RunFn } from "./temporal-ui";

/**
 * Edição temporal (cartão S3) sobre um clipe aprovado: interpolar, editar um
 * trecho, corrigir um quadro com máscara e transferir roupa. Cada operação
 * publica uma revisão candidata; os quadros não tocados ficam com os mesmos
 * arquivos. A prévia toca com a duração de cada quadro e onion skin.
 */

type Sub = "interpolate" | "edit" | "correct" | "outfit";
type Props = { projectId: string; data: Overview; profile: ProfileInfo; run: RunFn; onChanged: () => void };

export function TemporalPanel({ projectId, data, profile, run, onChanged }: Props) {
  const clips = useMemo(() => data.clips.flatMap((c) => c.revisions.map((r) => ({ asset: c.asset, revision: r }))), [data.clips]);
  const approved = clips.filter((c) => c.revision.status === "approved");
  const [clipId, setClipId] = useState("");
  const current = clips.find((c) => c.revision.id === clipId) ?? approved[0] ?? null;
  const [sub, setSub] = useState<Sub>("interpolate");
  const [selected, setSelected] = useState<string[]>([]);
  const [focus, setFocus] = useState<string>("");
  return (
    <section>
      <h2>Edição temporal</h2>
      <div className="row">
        <label>
          Clipe
          <select value={current?.revision.id ?? ""} onChange={(e) => (setClipId(e.target.value), setSelected([]), setFocus(""))}>
            {clips.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number} · {revision.status}
              </option>
            ))}
          </select>
        </label>
        {current && <ReviewButtons projectId={projectId} assetId={current.asset.id} revision={current.revision} activeRevisionId={current.asset.approvedRevisionId} onChanged={onChanged} />}
      </div>
      {current && (
        <div className="grid2">
          <div>
            <ClipPlayer key={current.revision.id} projectId={projectId} revision={current.revision} onSaved={(id) => (setClipId(id), onChanged())} />
            <ChangeSummary revision={current.revision} />
          </div>
          <div>
            <p className="small muted">Clique para focar um quadro; marque os quadros do trecho. Os não marcados ficam protegidos (mesmo hash).</p>
            <div className="anim-frames">
              {(current.revision.payload as ClipPayload).frames.map((f, i) => (
                <div key={f.frameId} className="small">
                  <FrameThumb projectId={projectId} revision={current.revision} index={i} zoom={2} selected={focus === f.frameId} onClick={() => setFocus(f.frameId)} title={`${f.frameId} · ${f.durationMs} ms`} />
                  <label>
                    <input type="checkbox" checked={selected.includes(f.frameId)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, f.frameId] : s.filter((x) => x !== f.frameId)))} /> {f.frameId}
                  </label>
                  <span className="muted">{selected.includes(f.frameId) ? " editar" : " protegido"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <nav className="row anim-tabs">
        {(
          [
            ["interpolate", "Interpolar"],
            ["edit", "Editar trecho"],
            ["correct", "Corrigir quadro"],
            ["outfit", "Transferir roupa"],
          ] as [Sub, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" className={sub === k ? "" : "secondary"} onClick={() => setSub(k)}>
            {label}
          </button>
        ))}
      </nav>
      {sub === "interpolate" && <Interpolate projectId={projectId} data={data} profile={profile} clip={current?.revision ?? null} focus={focus} run={run} />}
      {sub === "edit" && current && <EditSegment projectId={projectId} profile={profile} clip={current.revision} selected={selected} run={run} />}
      {sub === "correct" && current && <CorrectFrame key={`${current.revision.id}:${focus}`} projectId={projectId} profile={profile} clip={current.revision} frameId={focus || (current.revision.payload as ClipPayload).frames[0]!.frameId} run={run} />}
      {sub === "outfit" && current && <TransferOutfit projectId={projectId} data={data} profile={profile} clip={current.revision} selected={selected} run={run} />}
      {!current && sub !== "interpolate" && <p className="small muted">Nenhum clipe ainda: gere um na aba de animação ou no objeto.</p>}
    </section>
  );
}

/** O que a revisão mudou e quais dependentes revisar (eventos, coberturas de peças). */
function ChangeSummary({ revision }: { revision: RevisionView }) {
  const r = revision.technicalReport as {
    operation?: string;
    routeLabel?: string;
    modeLabel?: string;
    affected?: { events: { eventId: string; frameId: string }[]; overlays: { assetName: string; number: number; partId: string | null; frameId: string }[] };
    composite?: { protectedDiffPixels: number; editedPixels: number };
    keepFirstFrameSemantics?: string;
    note?: string;
    warnings?: string[];
  } | null;
  if (!r?.operation) return null;
  return (
    <div className="small">
      <p>
        <strong>{r.operation}</strong> · {r.routeLabel ?? r.modeLabel ?? ""}
      </p>
      {r.note && <p className="muted">{r.note}</p>}
      {r.keepFirstFrameSemantics && <p className="muted">{r.keepFirstFrameSemantics}</p>}
      {r.composite && (
        <p>
          {r.composite.editedPixels} pixel(s) editados; {r.composite.protectedDiffPixels} diferença(s) na área protegida.
        </p>
      )}
      {r.affected && (r.affected.events.length > 0 || r.affected.overlays.length > 0) && (
        <p className="error">
          Revisar: {r.affected.events.map((e) => `evento ${e.eventId} (${e.frameId})`).join(", ")}
          {r.affected.events.length && r.affected.overlays.length ? "; " : ""}
          {[...new Set(r.affected.overlays.map((o) => `${o.assetName} r${o.number} · ${o.partId ?? "vista rígida"} · ${o.frameId}`))].join("; ")}
        </p>
      )}
      {(r.warnings ?? []).map((w, i) => (
        <p key={i} className="error">
          {w}
        </p>
      ))}
    </div>
  );
}

function Interpolate({ projectId, data, profile, clip, focus, run }: { projectId: string; data: Overview; profile: ProfileInfo; clip: RevisionView | null; focus: string; run: RunFn }) {
  const route = routeLabel(profile, "interpolation");
  const [mode, setMode] = useState<"frames" | "views">(clip ? "frames" : "views");
  const [action, setAction] = useState("");
  const [count, setCount] = useState(2);
  const [transitionMs, setTransitionMs] = useState(200);
  const frames = clip ? (clip.payload as ClipPayload).frames : [];
  const start = frames.find((f) => f.frameId === focus) ?? frames[0];
  const next = start ? (frames[frames.indexOf(start) + 1] ?? (clip && (clip.payload as ClipPayload).playback === "loop" ? frames[0] : undefined)) : undefined;
  const views = data.bases.flatMap((b) => b.revisions.filter((r) => r.status === "approved").map((r) => ({ label: `${b.asset.name} r${r.number} (${(r.payload as BasePayload).state})`, revision: r })));
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [direction, setDirection] = useState<Direction>("S");
  const [clipAction, setClipAction] = useState("transition");
  const generic = route.strategy === "reference_sheet";
  const plan =
    !action.trim() || !route.ok
      ? null
      : mode === "frames"
        ? clip && start && next
          ? { operation: "interpolate_frames", providerProfileId: profile.id, start: { kind: "clip_frame", clipRevisionId: clip.id, frameId: start.frameId }, end: { kind: "clip_frame", clipRevisionId: clip.id, frameId: next.frameId }, action: action.trim(), transitionMs, ...(generic ? { count } : {}) }
          : null
        : a && b
          ? { operation: "interpolate_frames", providerProfileId: profile.id, start: { kind: "view", baseRevisionId: a, direction }, end: { kind: "view", baseRevisionId: b, direction }, action: action.trim(), transitionMs, newClip: { action: clipAction, startMs: 150, endMs: 250, playback: "once" }, ...(generic ? { count } : {}) }
          : null;
  const viewA = views.find((v) => v.revision.id === a);
  const viewB = views.find((v) => v.revision.id === b);
  return (
    <div>
      <p className="small muted">
        <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>. Os extremos ficam como estão (mesmo hash) e não se repetem; os intermediários recebem IDs novos e tempos explícitos{generic ? "" : " — a contagem é decidida pela rota nativa do provedor"}.
      </p>
      <div className="row">
        <label>
          Entre
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="frames">dois quadros vizinhos do clipe</option>
            <option value="views">duas vistas (estados), novo clipe</option>
          </select>
        </label>
        {mode === "frames" ? (
          <span className="small">{start && next ? `${start.frameId} → ${next.frameId}` : "foque um quadro que tenha vizinho"}</span>
        ) : (
          <>
            <label>
              Início
              <select value={a} onChange={(e) => setA(e.target.value)}>
                <option value="">—</option>
                {views.map((v) => (
                  <option key={v.revision.id} value={v.revision.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Fim
              <select value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">—</option>
                {views.map((v) => (
                  <option key={v.revision.id} value={v.revision.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Direção
              <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                {DIRS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ação do clipe
              <input value={clipAction} onChange={(e) => setClipAction(e.target.value.toLowerCase())} />
            </label>
            {viewA && viewUrl(projectId, viewA.revision, direction) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="pixel bg-checker" alt="início" src={viewUrl(projectId, viewA.revision, direction)!} width={48} height={48} />
            )}
            {viewB && viewUrl(projectId, viewB.revision, direction) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="pixel bg-checker" alt="fim" src={viewUrl(projectId, viewB.revision, direction)!} width={48} height={48} />
            )}
          </>
        )}
      </div>
      <div className="row">
        <label style={{ flex: 1 }}>
          Transição
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="ex.: a tampa abre; o braço sobe até o contato" />
        </label>
        {generic && (
          <label>
            Intermediários
            <input type="number" min={1} max={14} value={count} onChange={(e) => setCount(Math.max(1, Math.min(14, Number(e.target.value) || 1)))} />
          </label>
        )}
        <label>
          Duração total (ms)
          <input type="number" min={1} max={60000} value={transitionMs} onChange={(e) => setTransitionMs(Math.max(1, Number(e.target.value) || 1))} />
        </label>
      </div>
      <PlanActions projectId={projectId} plan={plan} run={run} label="Interpolar" />
    </div>
  );
}

function EditSegment({ projectId, profile, clip, selected, run }: { projectId: string; profile: ProfileInfo; clip: RevisionView; selected: string[]; run: RunFn }) {
  const route = routeLabel(profile, "edit");
  const [description, setDescription] = useState("");
  const ordered = (clip.payload as ClipPayload).frames.map((f) => f.frameId).filter((id) => selected.includes(id));
  return (
    <div>
      <p className="small muted">
        <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>. Trecho: {ordered.join(", ") || "marque os quadros ao lado"}. A edição de trecho muda os quadros inteiros, sem máscara; para uma região de um quadro, use Corrigir quadro.
      </p>
      <label>
        Mudança coerente no trecho
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ex.: a lâmina brilha em azul do avanço ao contato" />
      </label>
      <PlanActions projectId={projectId} plan={route.ok && ordered.length && description.trim() ? { operation: "edit_animation", providerProfileId: profile.id, clipRevisionId: clip.id, frameIds: ordered, description: description.trim() } : null} run={run} label="Editar trecho" />
    </div>
  );
}

function CorrectFrame({ projectId, profile, clip, frameId, run }: { projectId: string; profile: ProfileInfo; clip: RevisionView; frameId: string; run: RunFn }) {
  const payload = clip.payload as ClipPayload;
  const index = payload.frames.findIndex((f) => f.frameId === frameId);
  const frame = payload.frames[index]!;
  const [w, h] = payload.logicalSize;
  const zoom = Math.max(2, Math.floor(256 / Math.max(w, h)));
  const native = routeLabel(profile, "correctNative");
  const candidate = routeLabel(profile, "correctCandidate");
  const [mode, setMode] = useState<"native-mask" | "candidate-composite">(native.ok ? "native-mask" : "candidate-composite");
  const [partId, setPartId] = useState(frame.layers.length === 1 ? frame.layers[0]!.partId : "body");
  const [instruction, setInstruction] = useState("");
  const [mask, setMask] = useState<Uint8Array | null>(null);
  const [maskUploadId, setMaskUploadId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const available = mode === "native-mask" ? native : candidate;
  const plan = available.ok && instruction.trim() ? { operation: "correct_frame", providerProfileId: profile.id, clipRevisionId: clip.id, frameId, partId, instruction: instruction.trim(), mode, maskUploadId } : null;
  return (
    <div>
      <p className="small muted">
        Quadro {frameId} · vizinhos vão só como contexto · os outros quadros ficam com os mesmos hashes e o RGBA fora da máscara sai idêntico (máscara 255 edita / 0 protege). Sem máscara, o quadro inteiro pode mudar.
      </p>
      <div className="row">
        <label>
          Modo
          <select value={mode} onChange={(e) => (setMode(e.target.value as typeof mode), setMaskUploadId(null))}>
            <option value="native-mask" disabled={!native.ok}>
              Máscara nativa {native.ok ? "" : "(indisponível neste perfil)"}
            </option>
            <option value="candidate-composite" disabled={!candidate.ok}>
              Candidato + recorte local {candidate.ok ? "" : "(indisponível)"}
            </option>
          </select>
        </label>
        <label>
          Camada
          <select value={partId} onChange={(e) => setPartId(e.target.value)}>
            {frame.layers.map((l) => (
              <option key={l.partId} value={l.partId}>
                {l.partId}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          Correção
          <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="ex.: dobre mais o cotovelo; a mão mantém a empunhadura" />
        </label>
      </div>
      <p className="small">
        <span className={available.strategy === "native" ? "" : "anim-sheet"}>{available.text}</span>
      </p>
      <MaskPainter width={w} height={h} zoom={zoom} background={<FrameThumb projectId={projectId} revision={clip} index={index} zoom={zoom} />} onChange={(m) => (setMask(m), setMaskUploadId(null))} />
      <div className="row small">
        <button
          type="button"
          className="secondary"
          disabled={!mask}
          onClick={async () => {
            setMessage(null);
            try {
              setMaskUploadId(await uploadPng(projectId, await maskToPng(mask!, w, h), `mascara-${frameId}.png`));
              setMessage("Máscara enviada: a prévia e o envio usam esta região.");
            } catch (err) {
              setMessage(errorText(err));
            }
          }}
        >
          Usar esta máscara
        </button>
        <span className="muted">{maskUploadId ? "região marcada" : mask ? "pinte e confirme a máscara" : "sem máscara: quadro inteiro"}</span>
      </div>
      {message && <p className="small">{message}</p>}
      <PlanActions projectId={projectId} plan={mask && !maskUploadId ? null : plan} run={run} label="Corrigir quadro" />
    </div>
  );
}

function TransferOutfit({ projectId, data, profile, clip, selected, run }: { projectId: string; data: Overview; profile: ProfileInfo; clip: RevisionView; selected: string[]; run: RunFn }) {
  const route = routeLabel(profile, "outfit");
  const sources = data.imageSources.flatMap((s) => s.files.map((f) => ({ key: `${s.revisionId}|${f.fileKey}`, label: `${s.name} · ${f.fileKey}`, revisionId: s.revisionId, fileKey: f.fileKey, fileId: f.fileId })));
  const [sourceKey, setSourceKey] = useState("");
  const [stateKey, setStateKey] = useState("outfit_");
  const [instructions, setInstructions] = useState("");
  const src = sources.find((s) => s.key === sourceKey);
  const frames = (clip.payload as ClipPayload).frames.map((f) => f.frameId).filter((id) => selected.length === 0 || selected.includes(id));
  return (
    <div>
      <p className="small muted">
        <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>. Publica um <strong>clipe candidato vestido</strong> (mesmos quadros e célula): não é overlay modular e não substitui a base limpa. A peça
        reutilizável sai depois, pela extração de cobertura em Equipamentos.
      </p>
      <div className="row">
        <label>
          Roupa (imagem aprovada)
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value="">—</option>
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pixel bg-checker" alt="roupa" src={`/api/v1/projects/${projectId}/media/${src.fileId}`} width={48} height={48} />
        )}
        <label>
          Estado do clipe
          <input value={stateKey} onChange={(e) => setStateKey(e.target.value.toLowerCase())} />
        </label>
        <label style={{ flex: 1 }}>
          Instruções (opcional)
          <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="ex.: os quadros mostram o personagem de frente" />
        </label>
      </div>
      <p className="small muted">Quadros: {frames.join(", ")} (marque quadros ao lado para restringir).</p>
      <PlanActions
        projectId={projectId}
        plan={
          route.ok && src && /^outfit_[a-z0-9]/.test(stateKey)
            ? { operation: "transfer_outfit", providerProfileId: profile.id, clipRevisionId: clip.id, frameIds: frames, outfitRevisionId: src.revisionId, outfitFileKey: src.fileKey, stateKey, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) }
            : null
        }
        run={run}
        label="Gerar clipe vestido"
      />
    </div>
  );
}
