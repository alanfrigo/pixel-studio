import type { IsoPiece } from "@/contracts";
import { isoCellTop } from "../projection";

/**
 * Projeção isométrica (06 §perspectivas): o vértice superior do losango da
 * célula `(i, j)` fica em `(ox + (i − j)·W/2, oy + (i + j)·H/2)`; um prop no
 * centro da célula apoia-se H/2 abaixo desse vértice. As mesmas fórmulas
 * desenham o editor, validam no Python e reconstroem no consumidor.
 */

export type Diamond = readonly [number, number];

/** Centro do losango do footprint (onde o `supportPoint` pousa), já com a elevação. */
export function isoSupportScreen(cell: readonly [number, number], footprint: readonly [number, number], diamond: Diamond, elevationPx = 0, origin: readonly [number, number] = [0, 0]) {
  const [tx, ty] = isoCellTop(cell[0], cell[1], diamond, origin);
  const [fw, fh] = footprint;
  return [tx + ((fw - fh) * diamond[0]) / 4, ty + ((fw + fh) * diamond[1]) / 4 - elevationPx] as const;
}

/** Canto superior esquerdo onde desenhar a imagem da peça para que o apoio caia no centro do footprint. */
export function isoDrawPosition(piece: Pick<IsoPiece, "supportPoint" | "footprintCells">, cell: readonly [number, number], diamond: Diamond, elevationPx = 0, origin: readonly [number, number] = [0, 0]) {
  const [sx, sy] = isoSupportScreen(cell, piece.footprintCells, diamond, elevationPx, origin);
  return [sx - piece.supportPoint[0], sy - piece.supportPoint[1]] as const;
}

/**
 * Célula do chão sob um ponto da tela (elevação 0). Usa só a geometria do
 * losango, não a caixa do PNG: selecionar o chão sob a copa de um prop alto
 * devolve a célula de chão, não a do prop.
 */
export function isoScreenToCell(point: readonly [number, number], diamond: Diamond, origin: readonly [number, number] = [0, 0]): [number, number] {
  const px = point[0] - origin[0];
  const py = point[1] - origin[1];
  const u = py / diamond[1] + px / diamond[0];
  const v = py / diamond[1] - px / diamond[0];
  return [Math.floor(u), Math.floor(v)];
}

/** Chave de ordenação `depth_ij_elevation_v1`: profundidade i+j da frente do footprint, elevação, chão < bloco < personagem < prop. */
export function isoSortKey(cell: readonly [number, number], footprint: readonly [number, number], elevation: number, kind: "floor" | "block" | "actor" | "prop"): [number, number, number] {
  const order = { floor: 0, block: 1, actor: 1.5, prop: 2 }[kind];
  return [cell[0] + footprint[0] - 1 + cell[1] + footprint[1] - 1, elevation, order];
}

export function compareSortKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Pixel (centro) dentro do losango do footprint com vértice superior em `top` — mesma regra do Python. */
export function inIsoDiamond(x: number, y: number, top: readonly [number, number], diamond: Diamond, footprint: readonly [number, number] = [1, 1]): boolean {
  const px = x + 0.5 - top[0];
  const py = y + 0.5 - top[1];
  const u = py / diamond[1] + px / diamond[0];
  const v = py / diamond[1] - px / diamond[0];
  return u > 0 && u < footprint[0] && v > 0 && v < footprint[1];
}

/** Retângulo de tela `[x, y, w, h]` que contém todos os losangos do mapa (para o canvas). */
export function isoMapBounds(size: readonly [number, number], diamond: Diamond): { origin: [number, number]; width: number; height: number } {
  const [cols, rows] = size;
  const [w, h] = diamond;
  return { origin: [rows * (w / 2), 0], width: (cols + rows) * (w / 2), height: (cols + rows) * (h / 2) };
}
