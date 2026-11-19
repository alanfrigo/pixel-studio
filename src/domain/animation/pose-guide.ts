import type { JointPose, Skeleton } from "@/contracts";
import { createImage, encodePng, fillRect, type Rgba, type RgbaImage, setPixel } from "@/lib/media/png";

/**
 * Guia de poses em imagem (rota genérica, 03a): a sequência do editor desenhada
 * como bonecos de traço numa folha com a mesma grade da saída pedida. É uma
 * referência visual com papel `pose`, nunca anunciada como esqueleto
 * estruturado. Também serve ao provedor simulado para que a pose aprovada
 * apareça nos quadros de ensaio.
 *
 * Cores fixas por lado anatômico: direito vermelho, esquerdo azul, centro
 * escuro; joints ocultos em cinza.
 */

const COLORS: Record<string, Rgba> = {
  right: [214, 48, 49, 255],
  left: [38, 98, 214, 255],
  center: [40, 40, 48, 255],
  hidden: [150, 150, 158, 255],
};

function line(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, color: Rgba, thickness: number) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const half = Math.floor((thickness - 1) / 2);
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps);
    const y = Math.round(y0 + ((y1 - y0) * s) / steps);
    for (let dy = -half; dy < thickness - half; dy++) {
      for (let dx = -half; dx < thickness - half; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && py >= 0 && px < img.width && py < img.height) setPixel(img, px, py, color);
      }
    }
  }
}

/** Desenha uma pose dentro do retângulo `[ox, oy, w, h]` da imagem. */
export function drawPose(img: RgbaImage, skeleton: Skeleton, pose: Record<string, JointPose>, rect: [number, number, number, number], thickness = 1) {
  const [ox, oy, w, h] = rect;
  const at = (p: JointPose): [number, number] => [ox + Math.min(w - 1, Math.floor(p.x * w)), oy + Math.min(h - 1, Math.floor(p.y * h))];
  // Ordem de oclusão: o maior zIndex é desenhado por último (à frente).
  const order = [...skeleton.joints].sort((a, b) => (pose[a.jointId]?.zIndex ?? 0) - (pose[b.jointId]?.zIndex ?? 0));
  for (const joint of order) {
    const p = pose[joint.jointId];
    if (!p) continue;
    const parent = joint.parent ? pose[joint.parent] : undefined;
    const color = p.visible ? COLORS[joint.anatomicalSide]! : COLORS.hidden!;
    if (parent) {
      const [x0, y0] = at(parent);
      const [x1, y1] = at(p);
      line(img, x0, y0, x1, y1, color, thickness);
    }
    const [x, y] = at(p);
    line(img, x, y, x, y, color, thickness + 2);
  }
}

/** Folha de guias: uma pose por célula, na ordem de leitura, ampliada por fator inteiro. */
export function renderPoseGuide(input: {
  skeleton: Skeleton;
  poses: Record<string, JointPose>[];
  columns: number;
  rows: number;
  cell: [number, number];
  scale: number;
  background: Rgba;
}): Uint8Array {
  const [cw, ch] = [input.cell[0] * input.scale, input.cell[1] * input.scale];
  const img = createImage(cw * input.columns, ch * input.rows);
  fillRect(img, 0, 0, img.width, img.height, input.background);
  const thickness = Math.max(1, Math.round(input.scale / 2));
  input.poses.forEach((pose, i) => {
    const col = i % input.columns;
    const row = Math.floor(i / input.columns);
    drawPose(img, input.skeleton, pose, [col * cw, row * ch, cw, ch], thickness);
  });
  return encodePng(img);
}
