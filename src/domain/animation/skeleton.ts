import type { Direction, Joint, JointPose, MotionPayload, Pose, ProjectionKind, Skeleton } from "@/contracts";
import { skeletonProblems } from "@/contracts";
import type { LocalizedText } from "@/i18n/locales";
import type { PoseRecipe } from "./presets";

/**
 * Esqueleto de movimento no editor (04 §esqueleto estimado ou custom editável).
 *
 * - Coordenadas de pose contínuas normalizadas na célula de geração (`x/y` em
 *   0–1, origem no canto superior esquerdo); a sobreposição em pixels usa
 *   `(x·W, y·H)` e conserva frações.
 * - O humanoide usa 18 rótulos fixos de keypoints (nariz, pescoço, ombros,
 *   cotovelos, punhos, quadris, joelhos, tornozelos, olhos e orelhas) como
 *   nomes e uma hierarquia editorial explícita (keypoints soltos não trazem parent).
 * - "Estimar" aqui é um ajuste local do esqueleto padrão à caixa do conteúdo
 *   da base: candidato a corrigir, não verdade anatômica.
 *
 * Funções puras, sem dependência de Node: rodam no editor e no servidor.
 */

type HumanoidDef = { jointId: string; name: string; parent: string | null; side: Joint["anatomicalSide"] };

export const HUMANOID: readonly HumanoidDef[] = [
  { jointId: "neck", name: "NECK", parent: null, side: "center" },
  { jointId: "nose", name: "NOSE", parent: "neck", side: "center" },
  { jointId: "eye_r", name: "RIGHT EYE", parent: "nose", side: "right" },
  { jointId: "eye_l", name: "LEFT EYE", parent: "nose", side: "left" },
  { jointId: "ear_r", name: "RIGHT EAR", parent: "eye_r", side: "right" },
  { jointId: "ear_l", name: "LEFT EAR", parent: "eye_l", side: "left" },
  { jointId: "shoulder_r", name: "RIGHT SHOULDER", parent: "neck", side: "right" },
  { jointId: "elbow_r", name: "RIGHT ELBOW", parent: "shoulder_r", side: "right" },
  { jointId: "wrist_r", name: "RIGHT ARM", parent: "elbow_r", side: "right" },
  { jointId: "shoulder_l", name: "LEFT SHOULDER", parent: "neck", side: "left" },
  { jointId: "elbow_l", name: "LEFT ELBOW", parent: "shoulder_l", side: "left" },
  { jointId: "wrist_l", name: "LEFT ARM", parent: "elbow_l", side: "left" },
  { jointId: "hip_r", name: "RIGHT HIP", parent: "neck", side: "right" },
  { jointId: "knee_r", name: "RIGHT KNEE", parent: "hip_r", side: "right" },
  { jointId: "ankle_r", name: "RIGHT LEG", parent: "knee_r", side: "right" },
  { jointId: "hip_l", name: "LEFT HIP", parent: "neck", side: "left" },
  { jointId: "knee_l", name: "LEFT KNEE", parent: "hip_l", side: "left" },
  { jointId: "ankle_l", name: "LEFT LEG", parent: "knee_l", side: "left" },
];

export function humanoidSkeleton(): Skeleton {
  return { kind: "humanoid", joints: HUMANOID.map((j) => ({ jointId: j.jointId, name: j.name, parent: j.parent, anatomicalSide: j.side })) };
}

const UPPER = new Set(["neck", "nose", "eye_r", "eye_l", "ear_r", "ear_l", "shoulder_r", "elbow_r", "wrist_r", "shoulder_l", "elbow_l", "wrist_l"]);
const HEAD = new Set(["nose", "eye_r", "eye_l", "ear_r", "ear_l"]);

/** Figura de pé numa caixa unitária, olhando para o sul (o lado direito do personagem fica à esquerda da tela). */
const FRONT: Record<string, [number, number]> = {
  nose: [0.5, 0.12],
  eye_r: [0.44, 0.09],
  eye_l: [0.56, 0.09],
  ear_r: [0.38, 0.1],
  ear_l: [0.62, 0.1],
  neck: [0.5, 0.22],
  shoulder_r: [0.32, 0.26],
  elbow_r: [0.26, 0.42],
  wrist_r: [0.24, 0.56],
  shoulder_l: [0.68, 0.26],
  elbow_l: [0.74, 0.42],
  wrist_l: [0.76, 0.56],
  hip_r: [0.42, 0.56],
  knee_r: [0.41, 0.77],
  ankle_r: [0.4, 0.97],
  hip_l: [0.58, 0.56],
  knee_l: [0.59, 0.77],
  ankle_l: [0.6, 0.97],
};

/** Perfil olhando para o leste: o lado direito do personagem fica perto da câmera. */
const SIDE_EAST: Record<string, [number, number]> = {
  nose: [0.62, 0.12],
  eye_r: [0.58, 0.09],
  eye_l: [0.6, 0.09],
  ear_r: [0.46, 0.1],
  ear_l: [0.5, 0.1],
  neck: [0.5, 0.22],
  shoulder_r: [0.48, 0.26],
  elbow_r: [0.5, 0.42],
  wrist_r: [0.54, 0.56],
  shoulder_l: [0.54, 0.26],
  elbow_l: [0.56, 0.42],
  wrist_l: [0.6, 0.55],
  hip_r: [0.48, 0.56],
  knee_r: [0.5, 0.77],
  ankle_r: [0.48, 0.97],
  hip_l: [0.52, 0.56],
  knee_l: [0.54, 0.77],
  ankle_l: [0.54, 0.97],
};

function mirrorX(src: Record<string, [number, number]>): Record<string, [number, number]> {
  return Object.fromEntries(Object.entries(src).map(([k, [x, y]]) => [k, [1 - x, y]]));
}

/** Pose unitária por direção cardinal; diagonais combinam as duas cardinais vizinhas. */
function unitPose(direction: Direction): Record<string, [number, number]> {
  const cardinal: Record<"N" | "E" | "S" | "W", Record<string, [number, number]>> = {
    S: FRONT,
    N: mirrorX(FRONT), // de costas: o lado direito do personagem fica à direita da tela
    E: SIDE_EAST,
    W: mirrorX(SIDE_EAST),
  };
  if (direction.length === 1) return cardinal[direction as "N" | "E" | "S" | "W"];
  const a = cardinal[direction[0] as "N" | "S"];
  const b = cardinal[direction[1] as "E" | "W"];
  return Object.fromEntries(Object.keys(a).map((k) => [k, [(a[k]![0] + b[k]![0]) / 2, (a[k]![1] + b[k]![1]) / 2] as [number, number]]));
}

/** Ordem de oclusão inicial por direção: lado perto da câmera à frente; de costas, rosto atrás. */
function defaultZ(jointId: string, direction: Direction): number {
  const side = jointId.endsWith("_r") ? "right" : jointId.endsWith("_l") ? "left" : "center";
  const facingAway = direction.startsWith("N");
  if (HEAD.has(jointId)) return facingAway ? -1 : 3;
  if (side === "center") return 1;
  const east = direction.includes("E");
  const west = direction.includes("W");
  const near = east ? side === "right" : west ? side === "left" : null;
  const limb = /wrist|elbow/.test(jointId) ? 2 : 0;
  if (near === null) return limb;
  return near ? limb + 2 : limb - 2;
}

/** Caixa do conteúdo `[x, y, w, h]` em pixels da célula; `null` usa a célula inteira com margem. */
export type ContentBox = [number, number, number, number];

/**
 * Esqueleto humanoide padrão ajustado à caixa do conteúdo da base. É a
 * "estimativa" local: o artista corrige nomes, lados e posições antes de animar.
 */
export function defaultHumanoidPose(direction: Direction, cell: [number, number], box: ContentBox | null = null): Record<string, JointPose> {
  const [W, H] = cell;
  const [bx, by, bw, bh] = box ?? [W * 0.25, H * 0.12, W * 0.5, H * 0.8];
  const unit = unitPose(direction);
  const facingAway = direction.startsWith("N");
  return Object.fromEntries(
    HUMANOID.map((j) => {
      const [u, v] = unit[j.jointId]!;
      return [
        j.jointId,
        {
          x: clamp01((bx + u * bw) / W),
          y: clamp01((by + v * bh) / H),
          // De costas o rosto continua na sequência, oculto e revisável.
          visible: !(facingAway && (j.jointId === "nose" || j.jointId.startsWith("eye_"))),
          zIndex: defaultZ(j.jointId, direction),
        },
      ];
    }),
  );
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Math.round(v * 10_000) / 10_000));
}

/** Vetor de "frente" do personagem na tela para a direção (sul = em direção ao observador). */
function forward(direction: Direction): [number, number] {
  const dx = direction.includes("E") ? 1 : direction.includes("W") ? -1 : 0;
  const dy = direction.includes("S") ? 1 : direction.includes("N") ? -1 : 0;
  const n = Math.hypot(dx, dy) || 1;
  return [dx / n, dy / n];
}

type Offsets = Record<string, [number, number]>;

function shifted(base: Record<string, JointPose>, offsets: Offsets, all: [number, number] = [0, 0]): Record<string, JointPose> {
  return Object.fromEntries(
    Object.entries(base).map(([id, p]) => {
      const [dx, dy] = offsets[id] ?? [0, 0];
      return [id, { ...p, x: clamp01(p.x + dx + all[0]), y: clamp01(p.y + dy + all[1]) }];
    }),
  );
}

/** Altura aproximada da figura na pose (normalizada), escala dos deslocamentos procedurais. */
function figureHeight(pose: Record<string, JointPose>): number {
  const ys = Object.values(pose).map((p) => p.y);
  return Math.max(0.05, Math.max(...ys) - Math.min(...ys));
}

/**
 * Poses-guia de um preset a partir da pose de referência (humanoide). Ponto de
 * partida editável: deslocamentos pequenos e legíveis, root motion incluído
 * (a fase aérea da corrida sobe a figura inteira; não é recentralizada).
 */
export function presetPoses(recipe: PoseRecipe, reference: Record<string, JointPose>, direction: Direction, frames: number): Record<string, JointPose>[] {
  const s = figureHeight(reference);
  const [fx, fy] = forward(direction);
  const fwd = (k: number): [number, number] => [fx * k * s, fy * k * s * 0.5];
  const up = (k: number): [number, number] => [0, -k * s];
  const upper = (d: [number, number]): Offsets => Object.fromEntries([...UPPER].map((id) => [id, d]));
  const out: Record<string, JointPose>[] = [];
  for (let i = 0; i < frames; i++) {
    const phase = (i / frames) * Math.PI * 2;
    let offsets: Offsets = {};
    let all: [number, number] = [0, 0];
    switch (recipe) {
      case "idle_breath": {
        const lift = [0, 0.012, 0.02, 0.012][i % 4]!;
        offsets = upper(up(lift));
        break;
      }
      case "walk_cycle":
      case "run_cycle": {
        const amp = recipe === "run_cycle" ? 0.16 : 0.1;
        const swing = Math.cos(phase);
        const [lx, ly] = fwd(amp * swing);
        const [rx, ry] = fwd(-amp * swing);
        offsets = {
          ankle_l: [lx, ly + (swing < 0 ? -0.04 * s : 0)],
          knee_l: [lx / 2, ly / 2 - (swing < 0 ? 0.03 * s : 0)],
          ankle_r: [rx, ry + (swing > 0 ? -0.04 * s : 0)],
          knee_r: [rx / 2, ry / 2 - (swing > 0 ? 0.03 * s : 0)],
          // Braços opostos às pernas.
          wrist_r: [lx * 0.6, ly * 0.6],
          elbow_r: [lx * 0.3, ly * 0.3],
          wrist_l: [rx * 0.6, ry * 0.6],
          elbow_l: [rx * 0.3, ry * 0.3],
        };
        const bob = Math.abs(Math.sin(phase)) * 0.02 * s;
        if (recipe === "run_cycle") {
          const lean = fwd(0.05);
          for (const id of UPPER) offsets[id] = [(offsets[id]?.[0] ?? 0) + lean[0], (offsets[id]?.[1] ?? 0) + lean[1]];
          // Fase aérea: a figura inteira sobe (movimento intencional, não recentralizar).
          if (i % 3 === 2) all = up(0.05);
        } else {
          all = [0, bob];
        }
        break;
      }
      case "attack_swing": {
        const k = frames > 1 ? i / (frames - 1) : 0;
        const path: [number, number][] = [
          [-0.05, -0.2],
          [0.08, -0.1],
          [0.22, 0.0],
          [0.05, -0.02],
        ];
        const [ax, ay] = path[Math.min(path.length - 1, Math.round(k * (path.length - 1)))]!;
        const [hx, hy] = fwd(ax);
        offsets = { wrist_r: [hx, hy + ay * s], elbow_r: [hx / 2, hy / 2 + (ay * s) / 2], ...upper(fwd(ax * 0.15)) };
        offsets.wrist_r = [hx, hy + ay * s];
        offsets.elbow_r = [hx / 2, hy / 2 + (ay * s) / 2];
        break;
      }
      case "attack_wide": {
        const path: [number, number][] = [
          [0.02, -0.05],
          [-0.02, -0.3],
          [-0.08, -0.25],
          [0.2, 0.02],
          [0.18, 0.08],
          [0.03, -0.02],
        ];
        const [ax, ay] = path[Math.min(path.length - 1, Math.round((frames > 1 ? i / (frames - 1) : 0) * (path.length - 1)))]!;
        const [hx, hy] = fwd(ax);
        offsets = {
          ...upper(fwd(ax * 0.2)),
          wrist_r: [hx, hy + ay * s],
          wrist_l: [hx, hy + ay * s],
          elbow_r: [hx / 2, hy / 2 + (ay * s) / 2],
          elbow_l: [hx / 2, hy / 2 + (ay * s) / 2],
        };
        break;
      }
      case "hurt_recoil": {
        const back = [-0.1, -0.16, -0.03][Math.min(2, i)]!;
        offsets = upper(fwd(back));
        for (const id of HEAD) offsets[id] = [(offsets[id]?.[0] ?? 0) + fwd(back * 0.5)[0], (offsets[id]?.[1] ?? 0) - 0.02 * s];
        break;
      }
    }
    out.push(shifted(reference, offsets, all));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operações do editor (sequência de poses / timeline de keyframes)
// ---------------------------------------------------------------------------

export function nextPoseId(poses: readonly Pose[], prefix = "pose"): string {
  const ids = new Set(poses.map((p) => p.poseId));
  for (let n = poses.length + 1; ; n++) if (!ids.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export function moveJoint(joints: Record<string, JointPose>, jointId: string, x: number, y: number): Record<string, JointPose> {
  const current = joints[jointId];
  if (!current) return joints;
  return { ...joints, [jointId]: { ...current, x: clamp01(x), y: clamp01(y) } };
}

/** Interpola posições entre duas poses (guias locais; não gera pixels). Oclusão e visibilidade vêm da mais próxima. */
export function lerpJoints(a: Record<string, JointPose>, b: Record<string, JointPose>, t: number): Record<string, JointPose> {
  return Object.fromEntries(
    Object.keys(a).map((id) => {
      const pa = a[id]!;
      const pb = b[id] ?? pa;
      const near = t < 0.5 ? pa : pb;
      return [id, { ...near, x: clamp01(pa.x + (pb.x - pa.x) * t), y: clamp01(pa.y + (pb.y - pa.y) * t) }];
    }),
  );
}

/** Reamostra as poses estritamente entre dois keyframes, mantendo IDs e durações. */
export function fillBetween(poses: readonly Pose[], from: number, to: number): Pose[] {
  if (to - from < 2) return [...poses];
  return poses.map((p, i) => (i > from && i < to ? { ...p, joints: lerpJoints(poses[from]!.joints, poses[to]!.joints, (i - from) / (to - from)) } : p));
}

export function duplicatePose(poses: readonly Pose[], index: number): Pose[] {
  const src = poses[index];
  if (!src) return [...poses];
  const copy = { ...src, poseId: nextPoseId(poses), joints: structuredClone(src.joints) };
  return [...poses.slice(0, index + 1), copy, ...poses.slice(index + 1)];
}

export function removePose(poses: readonly Pose[], index: number): Pose[] {
  return poses.length <= 1 ? [...poses] : poses.filter((_, i) => i !== index);
}

// ---------------------------------------------------------------------------
// Hierarquia custom
// ---------------------------------------------------------------------------

/** Troca o parent sem perder a identidade do joint; recusa ciclos e segunda raiz. */
export function reparent(skeleton: Skeleton, jointId: string, parent: string | null): { skeleton: Skeleton; problems: LocalizedText[] } {
  const joints = skeleton.joints.map((j) => (j.jointId === jointId ? { ...j, parent } : j));
  const problems = skeletonProblems(joints).map((p) => p.message);
  return problems.length > 0 ? { skeleton, problems } : { skeleton: { ...skeleton, joints }, problems: [] };
}

/** Acrescenta um joint custom filho de `parent`, na posição do parent em todas as poses. */
export function addCustomJoint(motion: Pick<MotionPayload, "skeleton" | "referencePose" | "poses">, joint: Joint) {
  const parentPose = (pose: Record<string, JointPose>) => (joint.parent ? pose[joint.parent] : undefined) ?? { x: 0.5, y: 0.5, visible: true, zIndex: 0 };
  return {
    skeleton: { kind: "custom" as const, joints: [...motion.skeleton.joints, joint] },
    referencePose: { ...motion.referencePose, [joint.jointId]: { ...parentPose(motion.referencePose) } },
    poses: motion.poses.map((p) => ({ ...p, joints: { ...p.joints, [joint.jointId]: { ...parentPose(p.joints) } } })),
  };
}

/** Remove um joint custom; os filhos passam para o parent dele. A raiz não sai. */
export function removeCustomJoint(motion: Pick<MotionPayload, "skeleton" | "referencePose" | "poses">, jointId: string) {
  const target = motion.skeleton.joints.find((j) => j.jointId === jointId);
  if (!target || target.parent === null) return null;
  const strip = (pose: Record<string, JointPose>) => Object.fromEntries(Object.entries(pose).filter(([id]) => id !== jointId));
  return {
    skeleton: {
      kind: "custom" as const,
      joints: motion.skeleton.joints.filter((j) => j.jointId !== jointId).map((j) => (j.parent === jointId ? { ...j, parent: target.parent } : j)),
    },
    referencePose: strip(motion.referencePose),
    poses: motion.poses.map((p) => ({ ...p, joints: strip(p.joints) })),
  };
}

/** Movimento completo a partir das peças do editor. */
export function buildMotion(input: {
  skeleton: Skeleton;
  cell: [number, number];
  direction: Direction;
  projection: ProjectionKind;
  action: string;
  referencePose: Record<string, JointPose>;
  poses: Pose[];
  loop: boolean;
}): MotionPayload {
  return {
    skeleton: input.skeleton,
    generationCell: input.cell,
    direction: input.direction,
    projection: input.projection,
    action: input.action,
    referencePose: input.referencePose,
    poses: input.poses,
    loop: input.loop,
    jointSocketMap: [],
  };
}
