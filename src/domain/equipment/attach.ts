import type { Insets, Offset, PixelIndex, Size } from "@/contracts";
import { attachOrigin, mirrorGridPointX, mirrorPixelIndexX } from "@/domain/projection";

/**
 * Matemática de encaixe (04 §exemplo de encaixe). Duas convenções que nunca se
 * confundem:
 * - socket/empunhadura = ÍNDICE de pixel em `[0, W − 1]`; espelho = `W − 1 − x`;
 * - pivô = PONTO da grade (pode valer `W`); espelho = `W − x`;
 * - camada posicionada em `ox` com largura `w` vira `W − ox − w` (borda a borda).
 */

export { attachOrigin, mirrorGridPointX, mirrorPixelIndexX };

/** Empunhadura na imagem da vista, depois do espelho autorizado (índice de pixel). */
export function gripInView(grip: PixelIndex, viewWidth: number, mirrored: boolean): [number, number] {
  return mirrored ? [mirrorPixelIndexX(grip[0], viewWidth), grip[1]] : [grip[0], grip[1]];
}

/** Origem de desenho da vista rígida: socket do frame − empunhadura (já espelhada, se for o caso). */
export function rigidOrigin(socket: PixelIndex, grip: PixelIndex, viewWidth: number, mirrored: boolean): [number, number] {
  return attachOrigin(socket, gripInView(grip, viewWidth, mirrored));
}

/** Onde uma empunhadura da vista cai na célula, com a vista desenhada em `origin`. */
export function gripInCell(origin: Offset, grip: PixelIndex, viewWidth: number, mirrored: boolean): [number, number] {
  const g = gripInView(grip, viewWidth, mirrored);
  return [origin[0] + g[0], origin[1] + g[1]];
}

/** Desvio em px entre dois índices de pixel (Chebyshev: o maior dos eixos). */
export function deviationPx(a: PixelIndex, b: PixelIndex): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/** Socket espelhado numa célula de largura W (derivação autorizada): índice de pixel. */
export function mirrorSocket(at: PixelIndex, cellWidth: number): [number, number] {
  return [mirrorPixelIndexX(at[0], cellWidth), at[1]];
}

/** Pivô espelhado (ponto da grade, inclusive na borda). */
export function mirrorPivot(pivot: readonly [number, number], cellWidth: number): [number, number] {
  return [mirrorGridPointX(pivot[0], cellWidth), pivot[1]];
}

/** Offset de uma camada de largura `w` espelhada na célula: borda direita vira borda esquerda. */
export function mirrorLayerOffset(offset: Offset, layerWidth: number, cellWidth: number): [number, number] {
  return [cellWidth - offset[0] - layerWidth, offset[1]];
}

/** Quanto um retângulo posicionado passa de cada borda da célula (0 = cabe). */
export function overflow(offset: Offset, size: Size, cell: Size): Insets {
  return {
    left: Math.max(0, -offset[0]),
    top: Math.max(0, -offset[1]),
    right: Math.max(0, offset[0] + size[0] - cell[0]),
    bottom: Math.max(0, offset[1] + size[1] - cell[1]),
  };
}

export function overflows(o: Insets): boolean {
  return o.left > 0 || o.right > 0 || o.top > 0 || o.bottom > 0;
}

/** Maior estouro por borda entre vários contornos cortados: a margem que faz todos caberem. */
export function marginsToFit(list: readonly Insets[]): Insets {
  return list.reduce<Insets>(
    (acc, o) => ({ left: Math.max(acc.left, o.left), right: Math.max(acc.right, o.right), top: Math.max(acc.top, o.top), bottom: Math.max(acc.bottom, o.bottom) }),
    { left: 0, right: 0, top: 0, bottom: 0 },
  );
}
