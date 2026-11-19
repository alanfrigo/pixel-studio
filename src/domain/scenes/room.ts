import { type RoomDoor, type RoomFloorPlan, type RoomPayload, type RoomProjection, ROOM_MAX_COLS, ROOM_MAX_ROWS } from "@/contracts";
import { type LocalizedText, tx } from "@/i18n/locales";
import { isoScreenToCell } from "../world/iso";

/**
 * Sala (06 §limites reais de salas): planta de até 7 × 6 células, portas nas
 * paredes do piso e vistas top-down/isométrica/oblíqua. As regras da planta e
 * das portas valem para a guia raster: o editor mostra o problema antes de
 * qualquer envio.
 */

export type Side = RoomDoor["side"];
export type DoorInput = Pick<RoomDoor, "doorId" | "cell" | "side">;

export const DOOR_DELTA: Record<Side, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
export const OPPOSITE: Record<Side, Side> = { N: "S", S: "N", E: "W", W: "E" };

export function fullFloorPlan(size: readonly [number, number] = [ROOM_MAX_COLS, ROOM_MAX_ROWS]): RoomFloorPlan {
  return { size: [size[0], size[1]], cells: new Array(size[0] * size[1]).fill(true) };
}

export function isFloor(plan: RoomFloorPlan, col: number, row: number): boolean {
  const [cols, rows] = plan.size;
  return col >= 0 && row >= 0 && col < cols && row < rows && Boolean(plan.cells[row * cols + col]);
}

/** Células cobertas pela porta: N/S = uma; E/W = duas (a de cima é `row`). */
export function doorCells(door: Pick<RoomDoor, "cell" | "side">): [number, number][] {
  const [c, r] = door.cell;
  return door.side === "E" || door.side === "W" ? [[c, r], [c, r + 1]] : [[c, r]];
}

export interface PlanProblem {
  path: string;
  /** Mensagem nos dois idiomas (o editor mostra no idioma da interface). */
  message: LocalizedText;
}

/** Problemas da planta e das portas; vazio = pode enviar. */
export function floorPlanProblems(plan: RoomFloorPlan, doors: readonly DoorInput[]): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const [cols, rows] = plan.size;
  if (cols > ROOM_MAX_COLS || rows > ROOM_MAX_ROWS) problems.push({ path: "floorPlan.size", message: tx(`Planta limitada a ${ROOM_MAX_COLS} × ${ROOM_MAX_ROWS} células`, `The floor plan is limited to ${ROOM_MAX_COLS} × ${ROOM_MAX_ROWS} cells`) });
  if (plan.cells.length !== cols * rows) problems.push({ path: "floorPlan.cells", message: tx(`Planta deve ter ${cols * rows} células`, `The floor plan must have ${cols * rows} cells`) });
  const floor = plan.cells.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (floor.length === 0) problems.push({ path: "floorPlan.cells", message: tx("Planta sem piso", "The floor plan has no floor") });
  else {
    // O piso precisa ser uma peça só (4-vizinhança).
    const seen = new Set<number>([floor[0]!]);
    const queue = [floor[0]!];
    while (queue.length) {
      const i = queue.shift()!;
      const [x, y] = [i % cols, Math.floor(i / cols)];
      for (const [dx, dy] of Object.values(DOOR_DELTA)) {
        const nx = x + dx;
        const ny = y + dy;
        const n = ny * cols + nx;
        if (isFloor(plan, nx, ny) && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    if (seen.size !== floor.length) problems.push({ path: "floorPlan.cells", message: tx("O piso precisa ser uma peça só (sem ilhas separadas)", "The floor must be a single piece (no separate islands)") });
  }
  if (doors.length < 1 || doors.length > 8) problems.push({ path: "doors", message: tx("A sala precisa de 1 a 8 portas", "The room needs 1 to 8 doors") });
  const taken = new Map<string, string>();
  doors.forEach((d, i) => {
    const where = `doors.${i}`;
    for (const [c, r] of doorCells(d)) {
      if (!isFloor(plan, c, r)) {
        const side = d.side === "E" || d.side === "W";
        problems.push({
          path: where,
          message: tx(
            `${d.doorId}: célula ${c},${r} não é piso${side ? " (passagem lateral ocupa duas células: a indicada e a de baixo)" : ""}`,
            `${d.doorId}: cell ${c},${r} is not floor${side ? " (a side passage takes two cells: the given one and the one below)" : ""}`,
          ),
        });
        continue;
      }
      const [dx, dy] = DOOR_DELTA[d.side];
      if (isFloor(plan, c + dx, r + dy)) problems.push({ path: where, message: tx(`${d.doorId}: o lado ${d.side} de ${c},${r} não é parede`, `${d.doorId}: the ${d.side} side of ${c},${r} is not a wall`) });
      const key = `${d.side}:${c},${r}`;
      if (taken.has(key)) problems.push({ path: where, message: tx(`${d.doorId} sobrepõe ${taken.get(key)}`, `${d.doorId} overlaps ${taken.get(key)}`) });
      taken.set(key, d.doorId);
    }
    if (d.side === "E" || d.side === "W") {
      // Uma passagem E/W precisa de duas células de parede entre ela e um canto interno abaixo.
      const [c, r] = d.cell;
      const dx = DOOR_DELTA[d.side][0];
      for (const k of [2, 3]) {
        if (isFloor(plan, c, r + k) && isFloor(plan, c + dx, r + k)) {
          problems.push({ path: where, message: tx(`${d.doorId}: canto interno a menos de duas células de parede abaixo da passagem`, `${d.doorId}: inner corner less than two wall cells below the passage`) });
          break;
        }
        if (!isFloor(plan, c, r + k)) break;
      }
    }
  });
  const ids = new Set<string>();
  doors.forEach((d, i) => {
    if (ids.has(d.doorId)) problems.push({ path: `doors.${i}`, message: tx(`Porta repetida: ${d.doorId}`, `Duplicate door: ${d.doorId}`) });
    ids.add(d.doorId);
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Grade da imagem
// ---------------------------------------------------------------------------

export interface RoomGrid {
  pictureSize: [number, number];
  cellPx: [number, number];
  gridOrigin: [number, number];
}

/**
 * Grade declarada da sala (a guia raster é desenhada nela).
 * Top-down: célula de 32 px (qualquer `tile_size`); isométrica: losango
 * [T, T/2]; oblíqua: quadrado T.
 */
export function roomGrid(projection: RoomProjection, tileSize: number, size: readonly [number, number] = [ROOM_MAX_COLS, ROOM_MAX_ROWS]): RoomGrid {
  const [cols, rows] = size;
  // Proporções comuns (1:1, 3:2) para os modelos de imagem não distorcerem a grade ao ajustar a resposta.
  if (projection === "top_down") return { pictureSize: [cols * 32 + 32, rows * 32 + 64], cellPx: [32, 32], gridOrigin: [16, 48] };
  const t = tileSize;
  if (projection === "isometric") {
    const w = ((cols + rows) * t) / 2 + t;
    const h = Math.round((w * 2) / 3);
    return { pictureSize: [w, h], cellPx: [t, t / 2], gridOrigin: [t / 2 + (rows * t) / 2, h - ((cols + rows) * t) / 4 - Math.round(t / 8)] };
  }
  const side = Math.max(cols, rows) * t + 3 * t;
  return { pictureSize: [side, side], cellPx: [t, t], gridOrigin: [Math.round(1.5 * t), 2 * t] };
}

/** Célula do piso sob um ponto da imagem (isométrica pela geometria do losango, não pela caixa do PNG). */
export function roomCellAt(room: Pick<RoomPayload, "projection" | "cellPx" | "gridOrigin">, point: readonly [number, number]): [number, number] {
  if (room.projection === "isometric") return isoScreenToCell(point, room.cellPx, room.gridOrigin);
  return [Math.floor((point[0] - room.gridOrigin[0]) / room.cellPx[0]), Math.floor((point[1] - room.gridOrigin[1]) / room.cellPx[1])];
}

/** Centro da célula na imagem (isométrica: centro do losango). */
export function roomCellCenter(room: Pick<RoomPayload, "projection" | "cellPx" | "gridOrigin">, cell: readonly [number, number]): [number, number] {
  const [cw, ch] = room.cellPx;
  const [ox, oy] = room.gridOrigin;
  if (room.projection === "isometric") return [ox + ((cell[0] - cell[1]) * cw) / 2, oy + ((cell[0] + cell[1]) * ch) / 2 + ch / 2];
  return [ox + (cell[0] + 0.5) * cw, oy + (cell[1] + 0.5) * ch];
}

/** Geometria de porta derivada da grade: âncora na face da parede, gatilho e chegada. */
export function doorGeometry(room: Pick<RoomPayload, "projection" | "cellPx" | "gridOrigin">, door: Pick<RoomDoor, "cell" | "side">) {
  const [cw, ch] = room.cellPx;
  const [ox, oy] = room.gridOrigin;
  const [c, r] = door.cell;
  if (room.projection === "isometric") {
    const [x, y] = roomCellCenter(room, [c, r]);
    return { anchorPx: [Math.round(x), Math.round(y)] as [number, number], triggerPx: null, arrivePx: [Math.round(x), Math.round(y)] as [number, number] };
  }
  const x0 = ox + c * cw;
  const y0 = oy + r * ch;
  const tall = door.side === "E" || door.side === "W" ? 2 : 1;
  // Âncora na face externa da parede: B = A + âncoraA − âncoraB encosta parede com parede.
  const anchor: [number, number] =
    door.side === "N" ? [x0 + cw / 2, y0 - ch] : door.side === "S" ? [x0 + cw / 2, y0 + ch + cw / 2] : door.side === "W" ? [x0 - cw / 2, y0 + ch] : [x0 + cw + cw / 2, y0 + ch];
  const trigger: [number, number, number, number] =
    door.side === "N" ? [x0, y0, cw, ch / 4] : door.side === "S" ? [x0, y0 + (3 * ch) / 4, cw, ch / 4] : door.side === "W" ? [x0, y0, cw / 4, tall * ch] : [x0 + (3 * cw) / 4, y0, cw / 4, tall * ch];
  const arrive: [number, number] = [x0 + cw / 2, y0 + (tall * ch) / 2];
  return { anchorPx: anchor.map(Math.round) as [number, number], triggerPx: trigger.map(Math.round) as [number, number, number, number], arrivePx: arrive.map(Math.round) as [number, number] };
}

/** Piso caminhável pela grade: um retângulo por célula de piso. */
export function gridWalkable(room: Pick<RoomPayload, "projection" | "cellPx" | "gridOrigin" | "floorPlan">): [number, number, number, number][] {
  if (room.projection === "isometric") return [];
  const [cols, rows] = room.floorPlan.size;
  const out: [number, number, number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (isFloor(room.floorPlan, c, r)) out.push([room.gridOrigin[0] + c * room.cellPx[0], room.gridOrigin[1] + r * room.cellPx[1], room.cellPx[0], room.cellPx[1]]);
  return out;
}

// ---------------------------------------------------------------------------
// Duas salas de um edifício
// ---------------------------------------------------------------------------

export interface DoorLink {
  ok: boolean;
  problems: LocalizedText[];
  /** Deslocamento da imagem de B em relação à de A, em px, para as portas encostarem. */
  offsetPx: [number, number] | null;
  method: "anchors" | "grid" | null;
}

/**
 * Porta de A ligada à porta de B: lados opostos (E↔W, S↔N), mesma vista e
 * escala. Top-down com âncoras nas portas: B = A + âncoraA − âncoraB; senão
 * pela grade (a célula de B encosta na célula vizinha da porta de A).
 */
export function linkDoors(
  a: Pick<RoomPayload, "projection" | "cellPx" | "gridOrigin" | "tileSize" | "doors" | "picture">,
  aDoorId: string,
  b: Pick<RoomPayload, "projection" | "cellPx" | "gridOrigin" | "tileSize" | "doors" | "picture">,
  bDoorId: string,
): DoorLink {
  const problems: LocalizedText[] = [];
  const da = a.doors.find((d) => d.doorId === aDoorId);
  const db = b.doors.find((d) => d.doorId === bDoorId);
  if (!da || !db) return { ok: false, problems: [tx(`Porta inexistente: ${!da ? aDoorId : bDoorId}`, `Door does not exist: ${!da ? aDoorId : bDoorId}`)], offsetPx: null, method: null };
  if (a.projection !== b.projection) problems.push(tx(`Vistas diferentes: ${a.projection} × ${b.projection}`, `Different views: ${a.projection} × ${b.projection}`));
  if (a.cellPx[0] !== b.cellPx[0] || a.cellPx[1] !== b.cellPx[1] || a.tileSize !== b.tileSize) {
    problems.push(
      tx(
        `Escalas diferentes: célula ${a.cellPx.join("×")} (tile ${a.tileSize}) × ${b.cellPx.join("×")} (tile ${b.tileSize})`,
        `Different scales: cell ${a.cellPx.join("×")} (tile ${a.tileSize}) × ${b.cellPx.join("×")} (tile ${b.tileSize})`,
      ),
    );
  }
  if (OPPOSITE[da.side] !== db.side) problems.push(tx(`Lados não se encontram: ${da.side} de A precisa de ${OPPOSITE[da.side]} em B (recebido ${db.side})`, `Sides do not meet: ${da.side} on A needs ${OPPOSITE[da.side]} on B (got ${db.side})`));
  if (problems.length) return { ok: false, problems, offsetPx: null, method: null };
  if (a.projection === "top_down" && da.anchorPx && db.anchorPx) {
    return { ok: true, problems, offsetPx: [da.anchorPx[0] - db.anchorPx[0], da.anchorPx[1] - db.anchorPx[1]], method: "anchors" };
  }
  const [dx, dy] = DOOR_DELTA[da.side];
  const [cw, ch] = a.cellPx;
  if (a.projection === "isometric") {
    // A célula da porta de B ocupa a célula vizinha da porta de A (muretas finas entre as salas).
    const shift = [da.cell[0] + dx - db.cell[0], da.cell[1] + dy - db.cell[1]] as const;
    const cellShift = [((shift[0] - shift[1]) * cw) / 2, ((shift[0] + shift[1]) * ch) / 2];
    return { ok: true, problems, offsetPx: [Math.round(a.gridOrigin[0] - b.gridOrigin[0] + cellShift[0]!), Math.round(a.gridOrigin[1] - b.gridOrigin[1] + cellShift[1]!)], method: "grid" };
  }
  // Top-down/oblíqua: imagens encostadas parede com parede, células da porta alinhadas.
  const [aw, ah] = [a.picture.rect[2], a.picture.rect[3]];
  const [bw, bh] = [b.picture.rect[2], b.picture.rect[3]];
  const alignX = a.gridOrigin[0] + da.cell[0] * cw - (b.gridOrigin[0] + db.cell[0] * cw);
  const alignY = a.gridOrigin[1] + da.cell[1] * ch - (b.gridOrigin[1] + db.cell[1] * ch);
  const offset: [number, number] = dx !== 0 ? [dx > 0 ? aw : -bw, alignY] : [alignX, dy > 0 ? ah : -bh];
  return { ok: true, problems, offsetPx: offset, method: "grid" };
}

// ---------------------------------------------------------------------------
// Móveis na sala
// ---------------------------------------------------------------------------

export interface FurnitureObject {
  supportPoint: readonly [number, number];
  footprintCells: readonly [number, number];
  logicalSize: readonly [number, number];
  collision: readonly (readonly [number, number, number, number])[];
  shadow?: { offset: readonly [number, number]; rect: readonly [number, number, number, number] } | null;
}

/** Células do footprint com o apoio no centro (top-down/oblíqua) ou na célula sob o apoio (isométrica). */
export function furnitureCells(room: Pick<RoomPayload, "projection" | "cellPx" | "gridOrigin">, supportAt: readonly [number, number], footprint: readonly [number, number]): [number, number][] {
  const [fw, fh] = footprint;
  let first: [number, number];
  if (room.projection === "isometric") {
    const [i, j] = isoScreenToCell([supportAt[0], supportAt[1] - 0.01], room.cellPx, room.gridOrigin);
    first = [i - Math.floor((fw - 1) / 2), j - Math.floor((fh - 1) / 2)];
  } else {
    first = [Math.round((supportAt[0] - room.gridOrigin[0]) / room.cellPx[0] - fw / 2), Math.round((supportAt[1] - room.gridOrigin[1]) / room.cellPx[1] - fh / 2)];
  }
  const cells: [number, number][] = [];
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) cells.push([first[0] + x, first[1] + y]);
  return cells;
}

/** Apoio e footprint do móvel caem no piso da sala? (o prompt não decide; a planta sim). */
export function furnitureProblems(room: Pick<RoomPayload, "projection" | "cellPx" | "gridOrigin" | "floorPlan">, supportAt: readonly [number, number], object: Pick<FurnitureObject, "footprintCells">): LocalizedText[] {
  const problems: LocalizedText[] = [];
  const under = roomCellAt(room, supportAt);
  if (!isFloor(room.floorPlan, under[0], under[1])) problems.push(tx(`Apoio em ${supportAt.join(",")} fora do piso (célula ${under.join(",")})`, `Support point at ${supportAt.join(",")} is off the floor (cell ${under.join(",")})`));
  const off = furnitureCells(room, supportAt, object.footprintCells).filter(([c, r]) => !isFloor(room.floorPlan, c, r));
  if (off.length) problems.push(tx(`Footprint sai do piso nas células ${off.map((c) => c.join(",")).join("; ")}`, `Footprint leaves the floor at cells ${off.map((c) => c.join(",")).join("; ")}`));
  return problems;
}

/** Onde desenhar o móvel e a sombra (canto superior esquerdo) para o apoio cair em `supportAt`. */
export function furnitureDrawPositions(supportAt: readonly [number, number], object: Pick<FurnitureObject, "supportPoint" | "shadow">) {
  const x = supportAt[0] - object.supportPoint[0];
  const y = supportAt[1] - object.supportPoint[1];
  return { object: [x, y] as [number, number], shadow: object.shadow ? ([x + object.shadow.offset[0], y + object.shadow.offset[1]] as [number, number]) : null };
}

/** Ordem de desenho dos móveis: de trás para a frente pelo apoio (y, depois x). */
export function furnitureOrder<T extends { supportAtPx: readonly [number, number]; placementId: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.supportAtPx[1] - b.supportAtPx[1] || a.supportAtPx[0] - b.supportAtPx[0] || a.placementId.localeCompare(b.placementId));
}

/** Retângulos de colisão do móvel em px da sala (a colisão revisada do prop, não a caixa do PNG). */
export function furnitureCollisionPx(supportAt: readonly [number, number], object: Pick<FurnitureObject, "supportPoint" | "collision">): [number, number, number, number][] {
  const [x, y] = [supportAt[0] - object.supportPoint[0], supportAt[1] - object.supportPoint[1]];
  return object.collision.map(([rx, ry, rw, rh]) => [x + rx, y + ry, rw, rh]);
}
