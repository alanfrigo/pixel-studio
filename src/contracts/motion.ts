import { z } from "zod";
import { type LocalizedText, tx } from "@/i18n/locales";
import { checkUnique, DurationMs, Id, Int, NormalizedCoord, Size, Slug } from "./common";
import { Direction, ProjectionKind } from "./projection";

/**
 * Esqueleto de MOVIMENTO (04 §esqueleto). Não é o rig de equipamento:
 * `RigPayload` descreve anatomia vestível, slots e sockets de composição; esta
 * revisão fixa hierarquia de joints e poses por frame. Os dois se ligam apenas
 * por `jointSocketMap`, explícito e revisado.
 *
 * Coordenadas de pose: contínuas normalizadas `x/y ∈ [0, 1]` na célula de
 * geração, origem superior esquerda. Sobreposição em pixels usa `(x·W, y·H)`.
 */

export const AnatomicalSide = z.enum(["left", "right", "center"]);
export type AnatomicalSide = z.infer<typeof AnatomicalSide>;

/** Lado relativo à câmera; não substitui esquerda/direita anatômica. */
export const CameraSide = z.enum(["near", "mid", "far"]);

export const Joint = z.strictObject({
  jointId: Id,
  name: z.string().min(1).max(64),
  /** `null` apenas na raiz. */
  parent: Id.nullable(),
  anatomicalSide: AnatomicalSide,
  cameraSide: CameraSide.optional(),
});
export type Joint = z.infer<typeof Joint>;

export const JointPose = z.strictObject({
  x: NormalizedCoord,
  y: NormalizedCoord,
  /** Joints ocultos continuam na sequência com posição revisável. */
  visible: z.boolean(),
  /** Maior à frente. */
  zIndex: Int,
  /** Opcional, 0–255, maior perto da câmera. Omitir sem dados 3D. */
  depth: z.number().int().min(0).max(255).optional(),
});
export type JointPose = z.infer<typeof JointPose>;

export const PoseJoints = z.record(Id, JointPose);

export const Pose = z.strictObject({
  poseId: Id,
  durationMs: DurationMs,
  joints: PoseJoints,
});
export type Pose = z.infer<typeof Pose>;

export const Skeleton = z
  .strictObject({
    kind: z.enum(["humanoid", "custom"]),
    joints: z.array(Joint).min(2).max(64),
  })
  .superRefine((skeleton, ctx) => {
    checkUnique(ctx, skeleton.joints, (j) => j.jointId, "Joint", ["joints"]);
    for (const problem of skeletonProblems(skeleton.joints)) {
      ctx.addIssue({ code: "custom", message: problem.message["pt-BR"], path: ["joints", problem.index] });
    }
  });
export type Skeleton = z.infer<typeof Skeleton>;

/** Exatamente uma raiz, parents existentes e hierarquia sem ciclos. */
export function skeletonProblems(joints: readonly Joint[]): { index: number; message: LocalizedText }[] {
  const problems: { index: number; message: LocalizedText }[] = [];
  const byId = new Map(joints.map((j) => [j.jointId, j]));
  const roots = joints.filter((j) => j.parent === null);
  if (roots.length !== 1) {
    problems.push({ index: 0, message: tx(`Esqueleto deve ter exatamente uma raiz (encontradas ${roots.length})`, `The skeleton must have exactly one root (found ${roots.length})`) });
  }
  joints.forEach((joint, index) => {
    if (joint.parent !== null && !byId.has(joint.parent)) {
      problems.push({ index, message: tx(`Parent inexistente: ${joint.parent}`, `Parent does not exist: ${joint.parent}`) });
    }
    if (joint.parent === joint.jointId) {
      problems.push({ index, message: tx("Joint não pode ser parent de si mesmo", "A joint cannot be its own parent") });
    }
  });
  // Detecta ciclos subindo pelos parents.
  joints.forEach((joint, index) => {
    const visited = new Set<string>();
    let current: Joint | undefined = joint;
    while (current && current.parent !== null) {
      if (visited.has(current.jointId)) {
        problems.push({ index, message: tx(`Ciclo na hierarquia a partir de ${joint.jointId}`, `Cycle in the hierarchy starting at ${joint.jointId}`) });
        break;
      }
      visited.add(current.jointId);
      current = byId.get(current.parent);
    }
  });
  return problems;
}

export const JointSocketLink = z.strictObject({
  jointId: Id,
  rigRevisionId: Id,
  socketId: Id,
});

export const MotionPayload = z
  .strictObject({
    skeleton: Skeleton,
    /** Célula de geração em px; poses são normalizadas sobre ela. */
    generationCell: Size,
    /** Direção e câmera fixas por sequência. */
    direction: Direction,
    projection: ProjectionKind,
    action: Slug,
    /** Pose da imagem de referência, separada das poses-alvo. */
    referencePose: PoseJoints,
    poses: z.array(Pose).min(1).max(64),
    loop: z.boolean(),
    jointSocketMap: z.array(JointSocketLink),
  })
  .superRefine((motion, ctx) => {
    const jointIds = motion.skeleton.joints.map((j) => j.jointId);
    const checkPose = (joints: Record<string, unknown>, path: (string | number)[]) => {
      for (const id of jointIds) {
        if (!(id in joints)) ctx.addIssue({ code: "custom", message: `Pose sem o joint ${id}`, path });
      }
      for (const id of Object.keys(joints)) {
        if (!jointIds.includes(id)) ctx.addIssue({ code: "custom", message: `Joint desconhecido na pose: ${id}`, path });
      }
    };
    checkPose(motion.referencePose, ["referencePose"]);
    motion.poses.forEach((pose, i) => checkPose(pose.joints, ["poses", i, "joints"]));
    checkUnique(ctx, motion.poses, (p) => p.poseId, "Pose", ["poses"]);
    motion.jointSocketMap.forEach((link, i) => {
      if (!jointIds.includes(link.jointId)) {
        ctx.addIssue({ code: "custom", message: `Joint desconhecido: ${link.jointId}`, path: ["jointSocketMap", i, "jointId"] });
      }
    });
  });
export type MotionPayload = z.infer<typeof MotionPayload>;
