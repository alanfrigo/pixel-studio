import { CORNER_BITS, type CornerTilesetPayload } from "@/contracts";

/**
 * Autotile por cantos entre dois terrenos (06 §como gerar e validar um
 * autotile). O mapa guarda um terreno por vértice; cada célula lê os quatro
 * vértices que divide com as vizinhas. B nos bits NO=1, NE=2, SE=4, SO=8.
 * Código puro: roda no servidor, nos testes e no editor do navegador.
 */

export type Bit = 0 | 1;

export function vertexIndex(cols: number, vx: number, vy: number): number {
  return vy * (cols + 1) + vx;
}

/** Máscara da célula `(x, y)` a partir dos vértices `(cols+1)×(rows+1)`. */
export function cornerMask(vertices: readonly Bit[], cols: number, x: number, y: number): number {
  const v = (vx: number, vy: number) => vertices[vertexIndex(cols, vx, vy)] ?? 0;
  return (v(x, y) ? CORNER_BITS.NW : 0) | (v(x + 1, y) ? CORNER_BITS.NE : 0) | (v(x + 1, y + 1) ? CORNER_BITS.SE : 0) | (v(x, y + 1) ? CORNER_BITS.SW : 0);
}

/** Células que tocam o vértice (até quatro): só elas são recalculadas ao repintar. */
export function cellsTouchingVertex(cols: number, rows: number, vx: number, vy: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [x, y] of [
    [vx - 1, vy - 1],
    [vx, vy - 1],
    [vx - 1, vy],
    [vx, vy],
  ] as const) {
    if (x >= 0 && y >= 0 && x < cols && y < rows) out.push([x, y]);
  }
  return out;
}

/** FNV-1a 32 bits: hash estável e igual no navegador e no Node. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Variante estável: função da semente do mapa, coordenada global, chave do
 * conjunto e revisão da regra; candidatas ordenadas pela chave antes do sorteio.
 */
export function chooseVariant<T extends { tileKey: string; weight: number }>(
  candidates: readonly T[],
  seed: number,
  global: readonly [number, number],
  setKey: string,
  rule: string,
): T | undefined {
  if (candidates.length <= 1) return candidates[0];
  const sorted = [...candidates].sort((a, b) => (a.tileKey < b.tileKey ? -1 : a.tileKey > b.tileKey ? 1 : 0));
  const total = sorted.reduce((n, c) => n + c.weight, 0);
  let pick = stableHash(`${seed}|${global[0]},${global[1]}|${setKey}|${rule}`) % total;
  for (const c of sorted) {
    if (pick < c.weight) return c;
    pick -= c.weight;
  }
  return sorted[sorted.length - 1];
}

export interface CornerResolution {
  /** Tile por célula (linha a linha); `null` = máscara sem tile no conjunto. */
  resolved: (string | null)[];
  masks: number[];
  /** Máscaras usadas pelo mapa que o tileset não tem: o caso exato a corrigir. */
  missing: number[];
}

/** Resolve todas as células; substituições manuais vencem quando a máscara confere. */
export function resolveCornerMap(
  vertices: readonly Bit[],
  size: readonly [number, number],
  tileset: Pick<CornerTilesetPayload, "tiles">,
  opts: { seed: number; setKey: string; rule?: string; overrides?: readonly { cell: readonly [number, number]; tileKey: string }[]; origin?: readonly [number, number] },
): CornerResolution {
  const [cols, rows] = size;
  const byMask = new Map<number, CornerTilesetPayload["tiles"]>();
  for (const t of tileset.tiles) byMask.set(t.mask, [...(byMask.get(t.mask) ?? []), t]);
  const overrides = new Map((opts.overrides ?? []).map((o) => [`${o.cell[0]},${o.cell[1]}`, o.tileKey]));
  const [ox, oy] = opts.origin ?? [0, 0];
  const resolved: (string | null)[] = [];
  const masks: number[] = [];
  const missing = new Set<number>();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const mask = cornerMask(vertices, cols, x, y);
      masks.push(mask);
      const candidates = byMask.get(mask) ?? [];
      if (candidates.length === 0) {
        missing.add(mask);
        resolved.push(null);
        continue;
      }
      const fixed = overrides.get(`${x},${y}`);
      const manual = fixed ? candidates.find((c) => c.tileKey === fixed) : undefined;
      resolved.push((manual ?? chooseVariant(candidates, opts.seed, [ox + x, oy + y], opts.setKey, opts.rule ?? "corner-v1"))!.tileKey);
    }
  }
  return { resolved, masks, missing: [...missing].sort((a, b) => a - b) };
}

/**
 * Wang ID do Tiled para um conjunto por cantos (06 §perfis): oito entradas a
 * partir do lado norte em sentido horário (N, NE, E, SE, S, SO, O, NO); lados
 * ficam 0. Ex.: máscara 9 com grama = 1 e água = 2 → `[0,1,0,1,0,2,0,2]`.
 */
export function tiledWangId(mask: number, colors: readonly [number, number] = [1, 2]): number[] {
  const c = (bit: number) => (mask & bit ? colors[1] : colors[0]);
  return [0, c(CORNER_BITS.NE), 0, c(CORNER_BITS.SE), 0, c(CORNER_BITS.SW), 0, c(CORNER_BITS.NW)];
}

/** Pares de vizinhos compatíveis (lado comum com os mesmos terrenos): 64 por eixo com um tile por máscara. */
export function compatibleCornerPairs(masks: readonly number[]): { axis: "x" | "y"; a: number; b: number }[] {
  const has = (m: number, bit: number) => (m & bit) !== 0;
  const pairs: { axis: "x" | "y"; a: number; b: number }[] = [];
  for (const a of masks) {
    for (const b of masks) {
      if (has(a, CORNER_BITS.NE) === has(b, CORNER_BITS.NW) && has(a, CORNER_BITS.SE) === has(b, CORNER_BITS.SW)) pairs.push({ axis: "x", a, b });
      if (has(a, CORNER_BITS.SW) === has(b, CORNER_BITS.NW) && has(a, CORNER_BITS.SE) === has(b, CORNER_BITS.NE)) pairs.push({ axis: "y", a, b });
    }
  }
  return pairs;
}

/**
 * Amostra de validação (06 §aceite): lago com ilha, canal, diagonais e canto
 * interno numa grade 8×6 (vértices 9×7; 1 = terreno B).
 */
export const CORNER_SAMPLE = {
  size: [8, 6] as [number, number],
  vertices: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 1, 1, 0, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 0, 1, 0],
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 0, 0, 0, 1, 0, 0, 1, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ].flat() as Bit[],
};
