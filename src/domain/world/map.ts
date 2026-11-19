import type { CornerTilesetPayload, IsoPiece, MapObjectPayload, MapPlacement, TilemapPayload } from "@/contracts";
import { type LocalizedText, tx } from "@/i18n/locales";
import { type Bit, cellsTouchingVertex, cornerMask, chooseVariant, resolveCornerMap, vertexIndex } from "./corner";
import { isoMapBounds, isoSupportScreen } from "./iso";
import { resolveSideMap } from "./side";

/**
 * Operações puras do mapa editável (06 §montar a região): pintar terreno com
 * autotile, mover objetos, colisões e a checagem de passagem entre portas.
 * Cada operação devolve um payload novo; o editor guarda o histórico para desfazer.
 */

export type Cell = [number, number];

/** Chave estável do conjunto para o sorteio de variantes (não muda com a revisão do tileset). */
export function cornerSetKey(tileset: Pick<CornerTilesetPayload, "terrains">): string {
  return `${tileset.terrains[0].terrainId}/${tileset.terrains[1].terrainId}`;
}

export function emptyCornerMap(opts: {
  size: [number, number];
  cellSize: [number, number];
  tilesetRevisionId: string;
  tileset: Pick<CornerTilesetPayload, "tiles" | "terrains" | "projection">;
  seed?: number;
  walkable?: [boolean, boolean];
}): TilemapPayload {
  const [cols, rows] = opts.size;
  const vertices = new Array<Bit>((cols + 1) * (rows + 1)).fill(0);
  const seed = opts.seed ?? 1;
  const { resolved } = resolveCornerMap(vertices, opts.size, opts.tileset, { seed, setKey: cornerSetKey(opts.tileset) });
  return {
    projection: opts.tileset.projection,
    size: opts.size,
    cellSize: opts.cellSize,
    seed,
    units: { cell: "cell", offset: "px", polygon: "px" },
    terrain: {
      mode: "corner",
      tilesetRevisionId: opts.tilesetRevisionId,
      rule: "corner-v1",
      vertices,
      walkable: opts.walkable ?? [true, false],
      overrides: [],
      resolved,
    },
    objects: [],
    collisions: [],
    regions: [],
    entrances: [],
    passages: [],
  };
}

export type CornerMap = TilemapPayload & { terrain: Extract<TilemapPayload["terrain"], { mode: "corner" }> };

export function isCornerMap(map: TilemapPayload): map is CornerMap {
  return map.terrain.mode === "corner";
}

export function asCornerMap(map: TilemapPayload): CornerMap {
  if (!isCornerMap(map)) throw new Error("Mapa não usa terreno por cantos");
  return map;
}

/** Repinta um vértice e recalcula só as até quatro células que o tocam. */
export function paintCornerVertex(map: CornerMap, tileset: Pick<CornerTilesetPayload, "tiles" | "terrains">, vx: number, vy: number, value: Bit): { map: CornerMap; changedCells: Cell[] } {
  const [cols, rows] = map.size;
  if (vx < 0 || vy < 0 || vx > cols || vy > rows) return { map, changedCells: [] };
  const index = vertexIndex(cols, vx, vy);
  if (map.terrain.vertices[index] === value) return { map, changedCells: [] };
  const vertices = [...map.terrain.vertices];
  vertices[index] = value;
  const resolved = [...map.terrain.resolved];
  const touched = cellsTouchingVertex(cols, rows, vx, vy);
  const setKey = cornerSetKey(tileset);
  // Variante manual de célula cuja máscara mudou deixa de valer.
  const overrides = map.terrain.overrides.filter((o) => !touched.some(([x, y]) => x === o.cell[0] && y === o.cell[1]));
  for (const [x, y] of touched) {
    const mask = cornerMask(vertices, cols, x, y);
    const tile = chooseVariant(tileset.tiles.filter((t) => t.mask === mask), map.seed, [x, y], setKey, map.terrain.rule);
    resolved[y * cols + x] = tile?.tileKey ?? null;
  }
  return { map: { ...map, terrain: { ...map.terrain, vertices, resolved, overrides } }, changedCells: touched };
}

/** Preenchimento: troca todos os vértices conectados (4-vizinhança) de mesmo terreno a partir de um vértice. */
export function fillCornerVertices(map: CornerMap, tileset: Pick<CornerTilesetPayload, "tiles" | "terrains">, vx: number, vy: number, value: Bit): CornerMap {
  const [cols, rows] = map.size;
  const vertices = [...map.terrain.vertices];
  const start = vertices[vertexIndex(cols, vx, vy)];
  if (start === undefined || start === value) return map;
  const stack: Cell[] = [[vx, vy]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x > cols || y > rows) continue;
    const i = vertexIndex(cols, x, y);
    if (vertices[i] !== start) continue;
    vertices[i] = value;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return reresolveCorner({ ...map, terrain: { ...map.terrain, vertices } }, tileset);
}

/** Resolve o mapa inteiro (ex.: ao trocar a revisão do tileset): o traçado e as colocações não mudam. */
export function reresolveCorner(map: CornerMap, tileset: Pick<CornerTilesetPayload, "tiles" | "terrains">): CornerMap {
  const { resolved } = resolveCornerMap(map.terrain.vertices, map.size, tileset, {
    seed: map.seed,
    setKey: cornerSetKey(tileset),
    rule: map.terrain.rule,
    overrides: map.terrain.overrides,
  });
  return { ...map, terrain: { ...map.terrain, resolved } };
}

export function moveObject(map: TilemapPayload, objectId: string, cell: Cell, offsetPx?: [number, number]): TilemapPayload {
  const [cols, rows] = map.size;
  const clamped: Cell = [Math.max(0, Math.min(cols - 1, cell[0])), Math.max(0, Math.min(rows - 1, cell[1]))];
  return { ...map, objects: map.objects.map((o) => (o.objectId === objectId ? { ...o, cell: clamped, ...(offsetPx ? { offsetPx } : {}) } : o)) };
}

/** Ponto do mapa (px) onde o apoio do objeto pousa: centro do footprint + ajuste fino. */
export function objectAnchor(placement: Pick<MapPlacement, "cell" | "offsetPx">, footprint: readonly [number, number], cellSize: readonly [number, number]): [number, number] {
  return [
    (placement.cell[0] + footprint[0] / 2) * cellSize[0] + placement.offsetPx[0],
    (placement.cell[1] + footprint[1] / 2) * cellSize[1] + placement.offsetPx[1],
  ];
}

export interface PassageContext {
  objects: ReadonlyMap<string, Pick<MapObjectPayload, "supportPoint" | "footprintCells" | "collision">>;
  isoPieces?: ReadonlyMap<string, Pick<IsoPiece, "kind" | "blocksMovement" | "footprintCells">>;
}

function pointInPolygon(x: number, y: number, points: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ponto de referência de uma célula em px do mapa (centro; no isométrico, o centro do losango na tela). */
export function cellReferencePoint(map: Pick<TilemapPayload, "projection" | "size" | "cellSize">, cell: Cell): [number, number] {
  if (map.projection === "isometric") {
    const bounds = isoMapBounds(map.size, map.cellSize);
    const [x, y] = isoSupportScreen(cell, [1, 1], map.cellSize, 0, bounds.origin);
    return [x, y];
  }
  return [(cell[0] + 0.5) * map.cellSize[0], (cell[1] + 0.5) * map.cellSize[1]];
}

/**
 * Células bloqueadas: terreno não caminhável (2+ cantos), colisões de célula e
 * de polígono, colisão revisada dos objetos (só o tronco, não a copa) e peças
 * isométricas que bloqueiam. `null` = projeção sem regra de passagem (lateral).
 */
export function blockedCells(map: TilemapPayload, ctx: PassageContext): boolean[] | null {
  const [cols, rows] = map.size;
  const blocked = new Array<boolean>(cols * rows).fill(false);
  const t = map.terrain;
  if (t.mode === "side") return null;
  if (t.mode === "corner") {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const corners = [t.vertices[vertexIndex(cols, x, y)], t.vertices[vertexIndex(cols, x + 1, y)], t.vertices[vertexIndex(cols, x + 1, y + 1)], t.vertices[vertexIndex(cols, x, y + 1)]];
        const closed = corners.filter((v) => !t.walkable[v ?? 0]).length;
        if (closed >= 2) blocked[y * cols + x] = true;
      }
    }
  } else {
    t.cells.forEach((c, i) => {
      const piece = c.pieceKey ? ctx.isoPieces?.get(c.pieceKey) : undefined;
      if (!piece || piece.blocksMovement) blocked[i] = true;
    });
  }
  for (const c of map.collisions) {
    if (c.kind === "cells") for (const [x, y] of c.cells) blocked[y * cols + x] = true;
    else {
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const [px, py] = cellReferencePoint(map, [x, y]);
          if (pointInPolygon(px, py, c.points)) blocked[y * cols + x] = true;
        }
      }
    }
  }
  for (const o of map.objects) {
    if (o.pieceKey) {
      const piece = ctx.isoPieces?.get(o.pieceKey);
      if (!piece?.blocksMovement) continue;
      for (let dy = 0; dy < piece.footprintCells[1]; dy++) {
        for (let dx = 0; dx < piece.footprintCells[0]; dx++) {
          const x = o.cell[0] + dx;
          const y = o.cell[1] + dy;
          if (x < cols && y < rows) blocked[y * cols + x] = true;
        }
      }
      continue;
    }
    const obj = o.objectRevisionId ? ctx.objects.get(o.objectRevisionId) : undefined;
    if (!obj || map.projection === "isometric") continue;
    const [ax, ay] = objectAnchor(o, obj.footprintCells, map.cellSize);
    const [cw, ch] = map.cellSize;
    for (const [rx, ry, rw, rh] of obj.collision) {
      const x0 = ax - obj.supportPoint[0] + rx;
      const y0 = ay - obj.supportPoint[1] + ry;
      // Células que a colisão revisada sobrepõe (área > 0).
      for (let y = Math.max(0, Math.floor(y0 / ch)); y < Math.min(rows, Math.ceil((y0 + rh) / ch)); y++) {
        for (let x = Math.max(0, Math.floor(x0 / cw)); x < Math.min(cols, Math.ceil((x0 + rw) / cw)); x++) blocked[y * cols + x] = true;
      }
    }
  }
  return blocked;
}

export interface PassageResult {
  from: string;
  to: string;
  connected: boolean;
  /** Passos do menor caminho em células (4-vizinhança), quando conectado. */
  steps: number | null;
  path: Cell[];
  /** Motivo da passagem não verificada ou interrompida (bilíngue). */
  reason?: LocalizedText;
}

export function checkPassages(map: TilemapPayload, ctx: PassageContext): { supported: boolean; results: PassageResult[]; blocked: boolean[] | null } {
  const blocked = blockedCells(map, ctx);
  if (!blocked) {
    return {
      supported: false,
      blocked: null,
      results: map.passages.map((p) => ({ ...p, connected: false, steps: null, path: [], reason: tx("Passagem lateral exige física de pulo; não verificada", "Side-view passage needs jump physics; not checked") })),
    };
  }
  const [cols, rows] = map.size;
  const byId = new Map(map.entrances.map((e) => [e.entranceId, e]));
  const results = map.passages.map((p): PassageResult => {
    const a = byId.get(p.from)!;
    const b = byId.get(p.to)!;
    const start = a.cell[1] * cols + a.cell[0];
    const goal = b.cell[1] * cols + b.cell[0];
    if (blocked[start] || blocked[goal]) return { ...p, connected: false, steps: null, path: [], reason: tx(`Entrada ${blocked[start] ? a.name : b.name} está numa célula bloqueada`, `Entrance ${blocked[start] ? a.name : b.name} is on a blocked cell`) };
    const prev = new Map<number, number>([[start, -1]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === goal) break;
      const x = cur % cols;
      const y = Math.floor(cur / cols);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (blocked[n] || prev.has(n)) continue;
        prev.set(n, cur);
        queue.push(n);
      }
    }
    if (!prev.has(goal)) return { ...p, connected: false, steps: null, path: [], reason: tx("Sem caminho entre as entradas", "No path between the entrances") };
    const path: Cell[] = [];
    for (let c = goal; c !== -1; c = prev.get(c)!) path.unshift([c % cols, Math.floor(c / cols)]);
    return { ...p, connected: true, steps: path.length - 1, path };
  });
  return { supported: true, results, blocked };
}

/** Resolve o terreno lateral (configuração por célula e lacunas). */
export function reresolveSide(map: TilemapPayload, tileset: Parameters<typeof resolveSideMap>[2]): TilemapPayload {
  if (map.terrain.mode !== "side") return map;
  const { resolved } = resolveSideMap(map.terrain.solid, map.size, tileset);
  return { ...map, terrain: { ...map.terrain, resolved } };
}
