import { type BasePayload, type Direction, type IsoPiece, type IsoTilesetPayload, type TilemapPayload, type WorldToViewMap } from "@/contracts";
import { type LocalizedText, tx } from "@/i18n/locales";
import { isoWorldToView } from "../projection";
import { compareSortKeys, isoMapBounds, isoSortKey, isoSupportScreen } from "../world/iso";
import { blockedCells } from "../world/map";

/**
 * Personagem andando num mapa isométrico (06 §perspectivas, 04 §isométrico):
 * a entrada é a direção NO MUNDO (E = +u, S = +v); a vista desenhada é a
 * direção projetada na tela pelo mapa mundo → vista (E → SE, N → NE no
 * preset de referência). Nunca gira nem espelha o bitmap: vista ausente fica
 * ausente. O apoio acompanha a elevação do piso, a colisão usa o footprint e
 * a ordem de desenho segue `depth_ij_elevation_v1`.
 */

export const WORLD_STEP: Record<Direction, readonly [number, number]> = {
  N: [0, -1],
  NE: [1, -1],
  E: [1, 0],
  SE: [1, 1],
  S: [0, 1],
  SW: [-1, 1],
  W: [-1, 0],
  NW: [-1, -1],
};

/** Vista projetada para uma direção do mundo (orientação do asset, se houver; senão o preset de referência). */
export function viewForWorld(direction: Direction, worldToView?: WorldToViewMap | null): Direction {
  const map = worldToView ?? isoWorldToView();
  return map[direction] ?? direction;
}

/** Vista do personagem para a direção do mundo; `null` quando a base não tem essa vista (sem espelho implícito). */
export function characterView(base: Pick<BasePayload, "views" | "orientation">, direction: Direction) {
  const view = viewForWorld(direction, base.orientation?.worldToView);
  return { view, art: base.views.find((v) => v.direction === view) ?? null };
}

export interface IsoActor {
  cell: [number, number];
  /** Direção no mundo para onde o personagem olha. */
  facing: Direction;
}

export interface IsoWorld {
  map: TilemapPayload;
  tileset: IsoTilesetPayload;
  blocked: boolean[];
}

export function isoWorld(map: TilemapPayload, tileset: IsoTilesetPayload): IsoWorld {
  const blocked = blockedCells(map, { objects: new Map(), isoPieces: new Map(tileset.pieces.map((p) => [p.pieceKey, p])) }) ?? [];
  return { map, tileset, blocked };
}

export function cellElevation(world: IsoWorld, cell: readonly [number, number]): number {
  const t = world.map.terrain;
  if (t.mode !== "isometric") return 0;
  return t.cells[cell[1] * world.map.size[0] + cell[0]]?.elevation ?? 0;
}

/** Um passo na direção do mundo: bloqueia na borda e nas células do footprint de peças que bloqueiam. */
export function stepActor(world: IsoWorld, actor: IsoActor, direction: Direction): { actor: IsoActor; moved: boolean; reason: LocalizedText | null } {
  const [du, dv] = WORLD_STEP[direction];
  const target: [number, number] = [actor.cell[0] + du, actor.cell[1] + dv];
  const [cols, rows] = world.map.size;
  const turned = { ...actor, facing: direction };
  if (target[0] < 0 || target[1] < 0 || target[0] >= cols || target[1] >= rows) return { actor: turned, moved: false, reason: tx("borda do mapa", "edge of the map") };
  if (world.blocked[target[1] * cols + target[0]]) return { actor: turned, moved: false, reason: tx(`célula ${target.join(",")} bloqueada pelo footprint`, `cell ${target.join(",")} blocked by a footprint`) };
  if (du !== 0 && dv !== 0 && (world.blocked[actor.cell[1] * cols + target[0]] || world.blocked[target[1] * cols + actor.cell[0]])) {
    return { actor: turned, moved: false, reason: tx("diagonal cortaria um canto bloqueado", "diagonal would cut a blocked corner") };
  }
  return { actor: { cell: target, facing: direction }, moved: true, reason: null };
}

export interface IsoDrawItem {
  kind: "floor" | "block" | "prop" | "actor";
  key: string;
  cell: [number, number];
  sort: [number, number, number];
  /** Canto superior esquerdo do desenho na tela. */
  at: [number, number];
  size: [number, number];
  /** Região (px de tela) que cobre o personagem atrás (copa do prop); `null` = a imagem inteira conta. */
  occluder: [number, number, number, number] | null;
}

/**
 * Lista de desenho do mapa com o personagem: chão, blocos e props pela
 * geometria do losango (não pela caixa do PNG), personagem pousado no centro
 * do losango da célula, na elevação do piso.
 */
export function isoDrawList(world: IsoWorld, actor: IsoActor, character: { size: readonly [number, number]; pivot: readonly [number, number] }) {
  const { map, tileset } = world;
  const bounds = isoMapBounds(map.size, map.cellSize);
  const pieces = new Map<string, IsoPiece>(tileset.pieces.map((p) => [p.pieceKey, p]));
  const step = tileset.elevationStepPx;
  const items: IsoDrawItem[] = [];
  const place = (piece: IsoPiece, cell: [number, number], elevation: number, kind: IsoDrawItem["kind"], key: string) => {
    const [sx, sy] = isoSupportScreen(cell, piece.footprintCells, map.cellSize, elevation * step, bounds.origin);
    const at: [number, number] = [Math.round(sx - piece.supportPoint[0]), Math.round(sy - piece.supportPoint[1])];
    items.push({
      kind,
      key,
      cell,
      sort: isoSortKey(cell, piece.footprintCells, elevation, kind),
      at,
      size: [piece.logicalSize[0], piece.logicalSize[1]],
      occluder: piece.occluderRect ? [at[0] + piece.occluderRect[0], at[1] + piece.occluderRect[1], piece.occluderRect[2], piece.occluderRect[3]] : null,
    });
  };
  if (map.terrain.mode === "isometric") {
    map.terrain.cells.forEach((c, i) => {
      const piece = c.pieceKey ? pieces.get(c.pieceKey) : undefined;
      if (piece) place(piece, [i % map.size[0], Math.floor(i / map.size[0])], c.elevation, piece.kind === "block" ? "block" : "floor", c.pieceKey!);
    });
  }
  for (const o of map.objects) {
    const piece = o.pieceKey ? pieces.get(o.pieceKey) : undefined;
    // Mesma regra do editor e do consumidor do T1: o prop pousa no chão (elevação 0) da célula.
    if (piece) place(piece, [o.cell[0], o.cell[1]], 0, "prop", o.objectId);
  }
  const elevation = cellElevation(world, actor.cell);
  const [sx, sy] = isoSupportScreen(actor.cell, [1, 1], map.cellSize, elevation * step, bounds.origin);
  const actorAt: [number, number] = [Math.round(sx - character.pivot[0]), Math.round(sy - character.pivot[1])];
  items.push({ kind: "actor", key: "actor", cell: actor.cell, sort: isoSortKey(actor.cell, [1, 1], elevation, "actor"), at: actorAt, size: [character.size[0], character.size[1]], occluder: null });
  items.sort((a, b) => compareSortKeys(a.sort, b.sort));
  return { items, bounds, actorSupport: [Math.round(sx), Math.round(sy)] as [number, number], elevation };
}

/** Props desenhados depois do personagem que cobrem a figura dele (só pela região de oclusão revisada). */
export function occludersOf(items: readonly IsoDrawItem[]): string[] {
  const index = items.findIndex((i) => i.kind === "actor");
  if (index < 0) return [];
  const actor = items[index]!;
  const [ax, ay] = actor.at;
  const [aw, ah] = actor.size;
  return items
    .slice(index + 1)
    .filter((i) => i.kind === "prop" || i.kind === "block")
    .filter((i) => {
      const [x, y, w, h] = i.occluder ?? [i.at[0], i.at[1], i.size[0], i.size[1]];
      return x < ax + aw && x + w > ax && y < ay + ah && y + h > ay;
    })
    .map((i) => i.key);
}
