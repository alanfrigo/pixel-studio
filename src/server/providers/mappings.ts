import type { Direction, MotionPayload, ProjectionKind } from "@/contracts";
import { DomainFailure } from "../errors";

/**
 * Traduções do domínio local para o schema do PixelLab REST v2 (OpenAPI de
 * 2026-11-18). Funções puras: testáveis sem rede e sem credencial.
 */

const PIXELLAB_DIRECTIONS: Record<Direction, string> = {
  N: "north",
  NE: "north-east",
  E: "east",
  SE: "south-east",
  S: "south",
  SW: "south-west",
  W: "west",
  NW: "north-west",
};

export function pixelLabDirection(direction: Direction): string {
  return PIXELLAB_DIRECTIONS[direction];
}

/** `view` do esqueleto v3 não tem isométrico: nunca enviar por analogia (03 §mapeamentos). */
export function pixelLabView(projection: ProjectionKind, preferHighTopDown = false): string {
  switch (projection) {
    case "side":
      return "side";
    case "top_down":
    case "three_quarter":
      return preferHighTopDown ? "high top-down" : "low top-down";
    case "isometric":
      throw new DomainFailure("capability_missing", "O esqueleto v3 do PixelLab não oferece vista isométrica; qualifique outra rota para essa projeção");
  }
}

export const PIXELLAB_HUMANOID_JOINTS = [
  "NOSE",
  "NECK",
  "RIGHT SHOULDER",
  "RIGHT ELBOW",
  "RIGHT ARM",
  "LEFT SHOULDER",
  "LEFT ELBOW",
  "LEFT ARM",
  "RIGHT HIP",
  "RIGHT KNEE",
  "RIGHT LEG",
  "LEFT HIP",
  "LEFT KNEE",
  "LEFT LEG",
  "RIGHT EYE",
  "LEFT EYE",
  "RIGHT EAR",
  "LEFT EAR",
] as const;

interface Base64Image {
  type: "base64";
  base64: string;
  format: "png";
}

export function base64Image(bytes: Uint8Array): Base64Image {
  return { type: "base64", base64: Buffer.from(bytes).toString("base64"), format: "png" };
}

/**
 * Corpo de `/animate-with-skeleton-v3`: poses enviadas como dados estruturados
 * (`first_frame_keypoints` + `keypoints` por frame), não embutidas no prompt.
 * Humanoide usa os 18 rótulos fixos; custom envia `rig` com pais antes dos filhos.
 */
export function pixelLabSkeletonBody(input: {
  description: string;
  firstFrame: Uint8Array;
  motion: MotionPayload;
  preferHighTopDown?: boolean;
  seed?: number;
}) {
  const { motion } = input;
  const joints = motion.skeleton.joints;
  const byId = new Map(joints.map((j) => [j.jointId, j]));
  const label = (jointId: string) => {
    const joint = byId.get(jointId)!;
    if (motion.skeleton.kind === "custom") return joint.name;
    const upper = joint.name.toUpperCase();
    if (!(PIXELLAB_HUMANOID_JOINTS as readonly string[]).includes(upper)) {
      throw new DomainFailure("capability_missing", `Joint "${joint.name}" não corresponde a nenhum dos 18 joints humanoides do PixelLab`);
    }
    return upper;
  };
  const keypoints = (pose: MotionPayload["referencePose"]) =>
    joints.map((j) => {
      const p = pose[j.jointId]!;
      return { x: p.x, y: p.y, label: label(j.jointId), z_index: p.zIndex, ...(p.depth !== undefined ? { depth: p.depth } : {}) };
    });

  const frames = motion.poses.length;
  const [min, max] = motion.skeleton.kind === "custom" ? [1, 15] : [3, 15];
  if (frames < min || frames > max) {
    throw new DomainFailure("capability_missing", `O esqueleto v3 aceita ${min}–${max} poses (${motion.skeleton.kind}); o movimento tem ${frames}`);
  }
  if (motion.generationCell[0] > 256 || motion.generationCell[1] > 256) {
    throw new DomainFailure("capability_missing", "O esqueleto v3 aceita quadro inicial de até 256×256");
  }

  // Pais antes dos filhos (exigência do rig custom v3).
  const ordered: typeof joints = [];
  const placed = new Set<string>();
  while (ordered.length < joints.length) {
    const before = ordered.length;
    for (const j of joints) {
      if (!placed.has(j.jointId) && (j.parent === null || placed.has(j.parent))) {
        ordered.push(j);
        placed.add(j.jointId);
      }
    }
    if (ordered.length === before) throw new DomainFailure("validation_failed", "Hierarquia de joints com ciclo");
  }

  return {
    description: input.description,
    action: motion.action,
    direction: pixelLabDirection(motion.direction),
    view: pixelLabView(motion.projection, input.preferHighTopDown),
    first_frame: base64Image(input.firstFrame),
    first_frame_keypoints: keypoints(motion.referencePose),
    keypoints: motion.poses.map((p) => keypoints(p.joints)),
    ...(motion.skeleton.kind === "custom"
      ? { rig: ordered.map((j) => ({ name: j.name, parent: j.parent ? byId.get(j.parent)!.name : null, side: j.cameraSide ?? "mid" })) }
      : {}),
    no_background: true,
    seed: input.seed ?? 0,
  };
}

/**
 * Corpo de `/inpaint-v3`. A máscara local (branco edita, preto preserva) já é
 * a convenção do PixelLab: enviar sem inverter nem transformar em alfa.
 */
export function pixelLabInpaintBody(input: {
  description: string;
  source: { bytes: Uint8Array; width: number; height: number };
  editMask: { bytes: Uint8Array; width: number; height: number };
  seed?: number;
}) {
  const { source, editMask } = input;
  if (source.width !== editMask.width || source.height !== editMask.height) {
    throw new DomainFailure("validation_failed", "Máscara e fonte precisam ter as mesmas dimensões");
  }
  for (const side of [source.width, source.height]) {
    if (side < 32 || side > 512) throw new DomainFailure("capability_missing", "/inpaint-v3 aceita imagens de 32 a 512 px por lado");
  }
  const size = { width: source.width, height: source.height };
  return {
    description: input.description,
    inpainting_image: { image: base64Image(source.bytes), size },
    mask_image: { image: base64Image(editMask.bytes), size },
    no_background: false,
    crop_to_mask: true,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}

/**
 * Corpo de `/animate-with-text-v3` (cartão S1): `first_frame` real + ação em
 * texto. O schema aceita 4–16 quadros pares e orçamento de pixels
 * `largura × altura × quadros ≤ 524.288`; fora disso o plano é recusado antes
 * de cobrar, sem gerar a mais e descartar em silêncio.
 */
export function pixelLabTextAnimationBody(input: { action: string; firstFrame: Uint8Array; size: [number, number]; frames: number; seed?: number }) {
  const { frames, size } = input;
  if (frames < 4 || frames > 16 || frames % 2 !== 0) {
    throw new DomainFailure("capability_missing", `O texto v3 aceita 4–16 quadros pares; o pedido tem ${frames}`);
  }
  if (size[0] > 256 || size[1] > 256) throw new DomainFailure("capability_missing", "O texto v3 aceita quadro inicial de até 256×256");
  if (size[0] * size[1] * frames > 524_288) throw new DomainFailure("capability_missing", "O texto v3 limita largura × altura × quadros a 524.288 pixels");
  return {
    first_frame: base64Image(input.firstFrame),
    action: input.action,
    frame_count: frames,
    no_background: true,
    seed: input.seed ?? 0,
  };
}

/** Tamanhos aceitos pelo `/rotate` (descrição do endpoint no OpenAPI de 2026-11-18). */
export const PIXELLAB_ROTATE_SIZES = [16, 32, 64, 128] as const;

/**
 * Corpo de `/rotate`: arte nova da direção-alvo a partir de uma vista aprovada,
 * nunca bitmap girado. A direção de origem e a de destino vão explícitas; o
 * isométrico usa a flag documentada `isometric`, não um valor inventado de `view`.
 */
export function pixelLabRotateBody(input: {
  source: Uint8Array;
  size: [number, number];
  from: Direction;
  to: Direction;
  projection: ProjectionKind;
  preferHighTopDown?: boolean;
  seed?: number;
}) {
  const [w, h] = input.size;
  if (w !== h || !(PIXELLAB_ROTATE_SIZES as readonly number[]).includes(w)) {
    throw new DomainFailure("capability_missing", `/rotate aceita imagens quadradas de ${PIXELLAB_ROTATE_SIZES.join(", ")} px; a vista tem ${w}×${h}`);
  }
  const isometric = input.projection === "isometric";
  const view = isometric ? (input.preferHighTopDown ? "high top-down" : "low top-down") : pixelLabView(input.projection, input.preferHighTopDown);
  return {
    image_size: { width: w, height: h },
    from_image: base64Image(input.source),
    from_direction: pixelLabDirection(input.from),
    to_direction: pixelLabDirection(input.to),
    from_view: view,
    to_view: view,
    isometric,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}
