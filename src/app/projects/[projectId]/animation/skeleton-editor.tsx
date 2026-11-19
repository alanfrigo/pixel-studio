"use client";

import { useEffect, useRef, useState } from "react";
import type { Direction, JointPose, MotionPayload, Pose, ProjectionKind, Skeleton } from "@/contracts";
import { skeletonProblems } from "@/contracts";
import type { ActionPreset } from "@/domain/animation/presets";
import {
  addCustomJoint,
  buildMotion,
  defaultHumanoidPose,
  duplicatePose,
  fillBetween,
  humanoidSkeleton,
  moveJoint,
  presetPoses,
  removeCustomJoint,
  removePose,
  reparent,
} from "@/domain/animation/skeleton";
import type { RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { contentBox, errorText } from "./shared";

/**
 * Editor de esqueleto com timeline de keypoints (04 §esqueleto estimado ou
 * custom editável). A pose da referência (o desenho aprovado) fica separada
 * das poses-alvo; cada pose-alvo tem ID e duração próprios. Joints ocultos
 * continuam na sequência. Arrastar um joint muda os dados enviados — no
 * PixelLab como keypoints; numa rota genérica, como guia de poses em imagem.
 */

const SIDE_COLOR: Record<string, string> = { right: "#d63031", left: "#2662d6", center: "#28282f" };

interface Props {
  projectId: string;
  baseRevisionId: string;
  baseImageUrl: string;
  cell: [number, number];
  direction: Direction;
  projection: ProjectionKind;
  presets: readonly ActionPreset[];
  initialMotion: MotionPayload | null;
  initialPresetKey: string | null;
  onSaved: (revision: RevisionView, assetId: string) => void;
}

export function SkeletonEditor(props: Props) {
  const { cell, direction } = props;
  const [W, H] = cell;
  const zoom = Math.max(2, Math.floor(448 / Math.max(W, H)));
  const preset = props.presets.find((p) => p.key === props.initialPresetKey) ?? null;
  const [skeleton, setSkeleton] = useState<Skeleton>(() => props.initialMotion?.skeleton ?? humanoidSkeleton());
  const [reference, setReference] = useState<Record<string, JointPose>>(() => props.initialMotion?.referencePose ?? defaultHumanoidPose(direction, cell));
  const [poses, setPoses] = useState<Pose[]>(() => props.initialMotion?.poses ?? initialPoses(preset, defaultHumanoidPose(direction, cell), direction));
  const [action, setAction] = useState(props.initialMotion?.action ?? preset?.action ?? "acao");
  const [loop, setLoop] = useState(props.initialMotion?.loop ?? preset?.playback === "loop");
  const [presetKey, setPresetKey] = useState<string | null>(props.initialPresetKey);
  const [index, setIndex] = useState(-1); // -1 = pose da referência
  const [selected, setSelected] = useState<string | null>(null);
  const [keys, setKeys] = useState<Set<number>>(() => new Set([0]));
  const [onion, setOnion] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [newJoint, setNewJoint] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const dragging = useRef(false);
  const [imageReady, setImageReady] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      image.current = img;
      setImageReady(true);
    };
    img.src = props.baseImageUrl;
  }, [props.baseImageUrl]);

  const joints = index < 0 ? reference : poses[index]?.joints ?? reference;

  function setJoints(next: Record<string, JointPose>) {
    if (index < 0) setReference(next);
    else setPoses((all) => all.map((p, i) => (i === index ? { ...p, joints: next } : p)));
  }

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = W * zoom;
    c.height = H * zoom;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    if (image.current) {
      // A referência mostra o desenho aprovado; as poses-alvo o mostram esmaecido (a arte ainda não existe).
      ctx.globalAlpha = index < 0 ? 1 : 0.3;
      ctx.drawImage(image.current, 0, 0, W * zoom, H * zoom);
      ctx.globalAlpha = 1;
    }
    const drawSkeleton = (pose: Record<string, JointPose>, ghost: boolean) => {
      const order = [...skeleton.joints].sort((a, b) => (pose[a.jointId]?.zIndex ?? 0) - (pose[b.jointId]?.zIndex ?? 0));
      for (const j of order) {
        const p = pose[j.jointId];
        if (!p) continue;
        const parent = j.parent ? pose[j.parent] : undefined;
        const color = ghost ? "rgba(120,120,128,0.6)" : p.visible ? SIDE_COLOR[j.anatomicalSide]! : "#9a9aa2";
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = ghost ? 1 : 2;
        if (parent) {
          ctx.setLineDash(p.visible ? [] : [4, 3]);
          ctx.beginPath();
          ctx.moveTo(parent.x * W * zoom, parent.y * H * zoom);
          ctx.lineTo(p.x * W * zoom, p.y * H * zoom);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (!ghost) {
          ctx.beginPath();
          ctx.arc(p.x * W * zoom, p.y * H * zoom, j.jointId === selected ? 6 : 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    if (onion && index > 0) drawSkeleton(poses[index - 1]!.joints, true);
    if (onion && index === 0) drawSkeleton(reference, true);
    drawSkeleton(joints, false);
  }, [joints, skeleton, selected, index, onion, poses, reference, W, H, zoom, imageReady]);

  function at(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const rect = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const [x, y] = at(e);
    let best: string | null = null;
    let dist = Infinity;
    for (const [id, p] of Object.entries(joints)) {
      const d = Math.hypot((p.x - x) * W * zoom, (p.y - y) * H * zoom);
      if (d < dist) [best, dist] = [id, d];
    }
    if (best && dist <= 12) {
      setSelected(best);
      dragging.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* sem captura: o arraste segue enquanto o ponteiro estiver no canvas */
      }
    }
  }

  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragging.current || !selected) return;
    const [x, y] = at(e);
    setJoints(moveJoint(joints, selected, x, y));
  }

  function estimate() {
    const img = image.current;
    const box = img ? contentBox(img) : null;
    if (skeleton.kind !== "humanoid") return setMessage("Ajuste automático só para o esqueleto humanoide; mova os joints do rig custom à mão.");
    setReference(defaultHumanoidPose(direction, cell, box));
    setMessage(box ? `Esqueleto padrão ajustado à caixa do desenho (${box.join(", ")}). É uma estimativa: corrija joints, lados e oclusão.` : "Desenho vazio: usando a célula inteira.");
  }

  function fromPreset(key: string) {
    const p = props.presets.find((x) => x.key === key);
    if (!p) return;
    if (skeleton.kind !== "humanoid") return setMessage("Poses de preset são para o esqueleto humanoide.");
    setPresetKey(p.key);
    setAction(p.action);
    setLoop(p.playback === "loop");
    setPoses(initialPoses(p, reference, direction));
    setKeys(new Set(p.frameIds.map((_, i) => i)));
    setIndex(0);
  }

  function interpolate() {
    const sorted = [...keys].filter((k) => k < poses.length).sort((a, b) => a - b);
    let next = poses;
    for (let i = 0; i + 1 < sorted.length; i++) next = fillBetween(next, sorted[i]!, sorted[i + 1]!);
    setPoses(next);
    setMessage("Guias intermediárias reamostradas entre os keyframes (nenhum pixel gerado).");
  }

  async function save() {
    setMessage(null);
    try {
      const problems = skeletonProblems(skeleton.joints);
      if (problems.length) throw new Error(problems[0]!.message);
      const motion = buildMotion({ skeleton, cell, direction, projection: props.projection, action, referencePose: reference, poses, loop });
      const res = await apiFetch<{ revision: RevisionView; asset: { id: string } }>(`/projects/${props.projectId}/animation/motion`, {
        method: "POST",
        json: { baseRevisionId: props.baseRevisionId, motion, presetKey },
      });
      setMessage(`Movimento r${res.revision.number} publicado como candidato. Aprove-o para gerar.`);
      props.onSaved(res.revision, res.asset.id);
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  const sel = selected ? joints[selected] : undefined;
  const selJoint = skeleton.joints.find((j) => j.jointId === selected);

  return (
    <div className="grid2">
      <div>
        <canvas
          ref={canvas}
          className="pixel bg-checker"
          style={{ touchAction: "none", cursor: "crosshair", maxWidth: "100%" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (dragging.current = false)}
        />
        <p className="small muted">Vermelho: lado direito do personagem · azul: esquerdo · tracejado: joint oculto (continua na sequência).</p>
        <div className="anim-chips">
          <button type="button" className={index < 0 ? "" : "secondary"} onClick={() => setIndex(-1)}>
            Referência
          </button>
          {poses.map((p, i) => (
            <span key={p.poseId} className={`anim-chip${i === index ? " current" : ""}`}>
              <button type="button" className={i === index ? "" : "secondary"} onClick={() => setIndex(i)}>
                {keys.has(i) ? "◆ " : ""}
                {p.poseId}
              </button>
              <input
                type="number"
                min={1}
                max={60000}
                value={p.durationMs}
                aria-label={`Duração de ${p.poseId}`}
                onChange={(e) => setPoses((all) => all.map((x, j) => (j === i ? { ...x, durationMs: Math.max(1, Math.round(Number(e.target.value) || 1)) } : x)))}
              />
            </span>
          ))}
        </div>
        <div className="row small" style={{ marginTop: 8 }}>
          <button type="button" className="secondary" disabled={index < 0} onClick={() => setKeys((k) => new Set(k.has(index) ? [...k].filter((x) => x !== index) : [...k, index]))}>
            Marcar/desmarcar keyframe
          </button>
          <button type="button" className="secondary" onClick={interpolate} disabled={keys.size < 2}>
            Interpolar guias entre keyframes
          </button>
          <button type="button" className="secondary" disabled={index < 0} onClick={() => setPoses(duplicatePose(poses, index))}>
            Duplicar pose
          </button>
          <button type="button" className="secondary" disabled={index < 0 || poses.length <= 1} onClick={() => (setPoses(removePose(poses, index)), setIndex(Math.max(0, index - 1)))}>
            Remover pose
          </button>
          <button type="button" className="secondary" disabled={index < 0} onClick={() => setJoints(structuredClone(index > 0 ? poses[index - 1]!.joints : reference))}>
            Copiar pose anterior
          </button>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={onion} onChange={(e) => setOnion(e.target.checked)} /> pose anterior
          </label>
        </div>
      </div>
      <div>
        <div className="row">
          <label>
            Ação
            <input value={action} onChange={(e) => setAction(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, "_"))} />
          </label>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> ciclo
          </label>
          <label>
            Começar do preset
            <select value="" onChange={(e) => fromPreset(e.target.value)}>
              <option value="">—</option>
              {props.presets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} ({p.frameIds.length})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="secondary" onClick={estimate}>
            Estimar na base (local)
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (skeleton.kind === "humanoid") setSkeleton({ ...skeleton, kind: "custom" });
              setMessage("Esqueleto custom: nomes, parents e joints editáveis; no PixelLab vai como `rig`.");
            }}
            disabled={skeleton.kind === "custom"}
          >
            Converter em custom
          </button>
        </div>
        {sel && selJoint ? (
          <fieldset className="small" style={{ marginTop: 8 }}>
            <legend>
              {selJoint.name} <span className="muted">({selJoint.anatomicalSide})</span>
            </legend>
            <div className="row">
              <label>
                x
                <input type="number" step={0.01} min={0} max={1} value={sel.x} onChange={(e) => setJoints(moveJoint(joints, selJoint.jointId, Number(e.target.value), sel.y))} />
              </label>
              <label>
                y
                <input type="number" step={0.01} min={0} max={1} value={sel.y} onChange={(e) => setJoints(moveJoint(joints, selJoint.jointId, sel.x, Number(e.target.value)))} />
              </label>
              <label>
                z (oclusão)
                <input type="number" step={1} value={sel.zIndex} onChange={(e) => setJoints({ ...joints, [selJoint.jointId]: { ...sel, zIndex: Math.round(Number(e.target.value)) } })} />
              </label>
              <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={sel.visible} onChange={(e) => setJoints({ ...joints, [selJoint.jointId]: { ...sel, visible: e.target.checked } })} /> visível
              </label>
            </div>
            {skeleton.kind === "custom" && (
              <div className="row">
                <label>
                  Parent
                  <select
                    value={selJoint.parent ?? ""}
                    onChange={(e) => {
                      const r = reparent(skeleton, selJoint.jointId, e.target.value || null);
                      if (r.problems.length) setMessage(r.problems[0]!);
                      else setSkeleton(r.skeleton);
                    }}
                  >
                    <option value="">(raiz)</option>
                    {skeleton.joints
                      .filter((j) => j.jointId !== selJoint.jointId)
                      .map((j) => (
                        <option key={j.jointId} value={j.jointId}>
                          {j.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const r = removeCustomJoint({ skeleton, referencePose: reference, poses }, selJoint.jointId);
                    if (!r) return setMessage("A raiz não pode ser removida.");
                    setSkeleton(r.skeleton);
                    setReference(r.referencePose);
                    setPoses(r.poses);
                    setSelected(null);
                  }}
                >
                  Remover joint
                </button>
              </div>
            )}
          </fieldset>
        ) : (
          <p className="small muted">Clique num joint para selecionar e arraste para mover.</p>
        )}
        {skeleton.kind === "custom" && (
          <div className="row small" style={{ marginTop: 8 }}>
            <label>
              Novo joint (filho do selecionado)
              <input value={newJoint} onChange={(e) => setNewJoint(e.target.value)} placeholder="ex.: cauda" />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={!newJoint.trim() || !selected}
              onClick={() => {
                const id = `j_${newJoint.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${skeleton.joints.length}`;
                const r = addCustomJoint({ skeleton, referencePose: reference, poses }, { jointId: id, name: newJoint.trim(), parent: selected, anatomicalSide: "center" });
                setSkeleton(r.skeleton);
                setReference(r.referencePose);
                setPoses(r.poses);
                setNewJoint("");
              }}
            >
              Adicionar
            </button>
          </div>
        )}
        <p className="small">
          {skeleton.joints.length} joints · {poses.length} poses-alvo · célula {W}×{H} · direção {direction}
        </p>
        <button type="button" onClick={save}>
          Publicar movimento (candidato)
        </button>
        {message && <p className="small">{message}</p>}
      </div>
    </div>
  );
}

function initialPoses(preset: ActionPreset | null, reference: Record<string, JointPose>, direction: Direction): Pose[] {
  if (!preset) return [0, 1, 2, 3].map((i) => ({ poseId: `pose-${i + 1}`, durationMs: 120, joints: structuredClone(reference) }));
  return presetPoses(preset.poseRecipe, reference, direction, preset.frameIds.length).map((joints, i) => ({ poseId: preset.frameIds[i]!, durationMs: preset.durationsMs[i]!, joints }));
}
