import type { CornerTilesetPayload, MapPlacement, RoomFloorPlan, RoomPayload, TilemapPayload } from "@/contracts";

type CornerTile = CornerTilesetPayload["tiles"][number];
type MapEntrance = TilemapPayload["entrances"][number];
import { type Bit, vertexIndex } from "../world/corner";
import { doorCells, isFloor } from "./room";

/**
 * Kit da sala → mapa editável do T1 (06 §demonstrações: "abrir o kit
 * recebido, mapear paredes/cantos/portas e remontar um trecho editável").
 * O kit vira um tileset por cantos piso (A) ↔ parede (B); a planta vira o
 * terreno por vértice; portas viram entradas com ID estável; móveis viram
 * colocações de objetos (apoio, footprint, colisão e oclusão do próprio prop).
 */

export type KitKey = { kind: "mask"; mask: number } | { kind: "door"; side: "N" | "E" | "S" | "W" } | { kind: "ignore" };

/** Retângulos das células de uma folha em grade (linha a linha). */
export function sheetCells(sheetSize: readonly [number, number], cell: readonly [number, number], margin = 0, spacing = 0): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let y = margin; y + cell[1] <= sheetSize[1] - margin; y += cell[1] + spacing) {
    for (let x = margin; x + cell[0] <= sheetSize[0] - margin; x += cell[0] + spacing) out.push([x, y, cell[0], cell[1]]);
  }
  return out;
}

/** Proposta inicial: as 16 primeiras células na ordem das máscaras 0–15 (o artista confere cada uma). */
export function proposeMaskOrder(count: number): KitKey[] {
  return Array.from({ length: count }, (_, i) => (i < 16 ? { kind: "mask", mask: i } : { kind: "ignore" }));
}

export const KIT_TERRAINS: CornerTilesetPayload["terrains"] = [
  { terrainId: "floor", name: "Piso", color: "#c8a064" },
  { terrainId: "wall", name: "Parede", color: "#5a4a46" },
];

/** Tileset por cantos piso ↔ parede a partir das chaves atribuídas às células da folha do kit. */
export function kitTilesetPayload(o: { fileId: string; cell: readonly [number, number]; margin: number; spacing: number; rects: readonly [number, number, number, number][]; keys: readonly KitKey[] }): {
  payload: CornerTilesetPayload;
  missing: number[];
  doors: { side: "N" | "E" | "S" | "W"; rect: [number, number, number, number] }[];
} {
  const tiles: CornerTile[] = [];
  const variants = new Map<number, number>();
  const doors: { side: "N" | "E" | "S" | "W"; rect: [number, number, number, number] }[] = [];
  o.keys.forEach((key, i) => {
    const rect = o.rects[i];
    if (!rect) return;
    if (key.kind === "mask") {
      const variant = variants.get(key.mask) ?? 0;
      variants.set(key.mask, variant + 1);
      tiles.push({ tileKey: `kit-m${key.mask}-v${variant}`, mask: key.mask, variant, weight: 1, rect: [...rect], frames: [] });
    } else if (key.kind === "door") doors.push({ side: key.side, rect: [...rect] });
  });
  const missing = Array.from({ length: 16 }, (_, m) => m).filter((m) => !variants.has(m));
  const payload: CornerTilesetPayload = {
    projection: "top_down",
    cellSize: [o.cell[0], o.cell[1]],
    atlas: { fileId: o.fileId, margin: o.margin, spacing: o.spacing },
    terrains: KIT_TERRAINS,
    diagonals: { mask5: "separate", mask10: "separate" },
    tiles,
    complete: missing.length === 0,
  };
  return { payload, missing, doors };
}

/**
 * Planta → vértices do terreno (0 = piso/A, 1 = parede/B) num mapa com uma
 * célula de parede em volta: o vértice é piso se toca alguma célula de piso.
 * Assim as células de piso ficam inteiras e as de borda viram parede/cantos.
 */
export function roomVertices(plan: RoomFloorPlan): { size: [number, number]; vertices: Bit[] } {
  const [cols, rows] = plan.size;
  const size: [number, number] = [cols + 2, rows + 2];
  const vertices: Bit[] = new Array((size[0] + 1) * (size[1] + 1)).fill(1);
  for (let vy = 0; vy <= size[1]; vy++) {
    for (let vx = 0; vx <= size[0]; vx++) {
      const touches = [
        [vx - 1, vy - 1],
        [vx, vy - 1],
        [vx - 1, vy],
        [vx, vy],
      ].some(([mx, my]) => isFloor(plan, mx! - 1, my! - 1));
      vertices[vertexIndex(size[0], vx, vy)] = touches ? 0 : 1;
    }
  }
  return { size, vertices };
}

/** Portas da sala → entradas do mapa (célula de piso, +1 pela borda de parede) com o mesmo ID. */
export function roomEntrances(room: Pick<RoomPayload, "doors">): MapEntrance[] {
  return room.doors.map((d) => ({ entranceId: d.doorId, name: `Porta ${d.side}`, cell: [d.cell[0] + 1, d.cell[1] + 1], side: d.side }));
}

/** Célula da parede onde desenhar a peça de porta do kit (do outro lado da entrada). */
export function doorWallCells(room: Pick<RoomPayload, "doors">): { doorId: string; side: "N" | "E" | "S" | "W"; cell: [number, number] }[] {
  const delta = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as const;
  return room.doors.flatMap((d) =>
    doorCells(d)
      .slice(0, 1)
      .map(([c, r]) => ({ doorId: d.doorId, side: d.side, cell: [c + 1 + delta[d.side][0], r + 1 + delta[d.side][1]] as [number, number] })),
  );
}

/**
 * Móvel colocado na sala (apoio em px da imagem) → colocação no mapa: célula
 * do canto do footprint e ajuste fino em px a partir do centro do footprint.
 */
export function furniturePlacement(
  room: Pick<RoomPayload, "gridOrigin" | "cellPx">,
  mapCell: readonly [number, number],
  f: { placementId: string; objectRevisionId: string; supportAtPx: readonly [number, number]; label?: string },
  footprint: readonly [number, number],
): MapPlacement {
  const [cw, ch] = mapCell;
  // Coordenada do apoio no mapa: a célula (0,0) da sala é a (1,1) do mapa.
  const mx = ((f.supportAtPx[0] - room.gridOrigin[0]) / room.cellPx[0] + 1) * cw;
  const my = ((f.supportAtPx[1] - room.gridOrigin[1]) / room.cellPx[1] + 1) * ch;
  const cell: [number, number] = [Math.max(0, Math.round(mx / cw - footprint[0] / 2)), Math.max(0, Math.round(my / ch - footprint[1] / 2))];
  const offsetPx: [number, number] = [Math.round(mx - (cell[0] + footprint[0] / 2) * cw), Math.round(my - (cell[1] + footprint[1] / 2) * ch)];
  return { objectId: f.placementId, objectRevisionId: f.objectRevisionId, pieceKey: null, cell, offsetPx, ...(f.label ? { label: f.label } : {}) };
}
