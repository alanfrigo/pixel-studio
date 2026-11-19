import { DIRECTIONS_8, type Direction, type WorldToViewMap } from "@/contracts";

/**
 * Geometria de direções (04 §isométrico, §encaixe).
 */

/** Vetores no plano do mundo: E = +u, S = +v. */
const WORLD_VECTORS: Record<Direction, readonly [number, number]> = {
  N: [0, -1],
  NE: [1, -1],
  E: [1, 0],
  SE: [1, 1],
  S: [0, 1],
  SW: [-1, 1],
  W: [-1, 0],
  NW: [-1, -1],
};

/** Direção de tela mais próxima de um vetor (Y para baixo). */
function nearestScreenDirection(dx: number, dy: number): Direction {
  // Ângulo a partir do N de tela (0, -1), no sentido horário.
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const index = ((Math.round(angle / 45) % 8) + 8) % 8;
  return DIRECTIONS_8[index]!;
}

/**
 * Mapa mundo → vista para a projeção isométrica de referência
 * `screenX = u - v`, `screenY = (u + v) / 2`. Girar a orientação do mapa
 * recalcula o mapa e pede revisão; não gira texturas.
 */
export function isoWorldToView(): WorldToViewMap {
  const map = {} as Record<Direction, Direction>;
  for (const dir of DIRECTIONS_8) {
    const [u, v] = WORLD_VECTORS[dir];
    map[dir] = nearestScreenDirection(u - v, (u + v) / 2);
  }
  return map;
}

/** Vértice superior do losango da célula `(i, j)` (06 §perspectivas). */
export function isoCellTop(i: number, j: number, diamond: readonly [number, number], origin: readonly [number, number] = [0, 0]) {
  const [w, h] = diamond;
  return [origin[0] + ((i - j) * w) / 2, origin[1] + ((i + j) * h) / 2] as const;
}

/** Espelho horizontal de um índice de pixel (socket): `W - 1 - x`. */
export function mirrorPixelIndexX(x: number, width: number): number {
  return width - 1 - x;
}

/** Espelho horizontal de um ponto de grade (pivô na borda): `W - x`. */
export function mirrorGridPointX(x: number, width: number): number {
  return width - x;
}

/**
 * Origem de desenho de uma peça rígida: socket na célula menos a empunhadura
 * na imagem da peça. Ex.: mão (39, 34) e empunhadura (3, 22) → (36, 12).
 */
export function attachOrigin(socket: readonly [number, number], grip: readonly [number, number]): [number, number] {
  return [socket[0] - grip[0], socket[1] - grip[1]];
}
