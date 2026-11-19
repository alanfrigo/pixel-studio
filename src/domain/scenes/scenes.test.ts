import { describe, expect, it } from "vitest";
import { type IsoTilesetPayload, RoomPayload, ScenePayload, SceneLayerPayload, TilemapPayload } from "@/contracts";
import { isoWorldToView } from "@/domain/projection";
import { characterView, isoDrawList, isoWorld, occludersOf, stepActor, viewForWorld } from "./iso-walk";
import { cameraSpan, cameraStops, layerCopies, layerLeavesGap, layerOrigin } from "./parallax";
import { doorGeometry, floorPlanProblems, fullFloorPlan, furnitureProblems, isFloor, linkDoors, roomCellAt, roomGrid } from "./room";
import { kitTilesetPayload, proposeMaskOrder, roomEntrances, roomVertices, sheetCells } from "./room-map";

/** Planta 7 × 6 escrita em linhas: `#` piso, `.` rocha. */
function planFromRows(rows: readonly string[]): RoomPayload["floorPlan"] {
  return { size: [7, 6], cells: rows.flatMap((row) => Array.from({ length: 7 }, (_, c) => row[c] === "#")) };
}

const L_PLAN = planFromRows(["####...", "####...", "#######", "#######", "#######", "#######"]);

describe("planta e portas (cartão T2)", () => {
  it("aceita a sala inteira e a sala em L com portas nas paredes", () => {
    expect(floorPlanProblems(fullFloorPlan(), [{ doorId: "s", cell: [3, 5], side: "S" }, { doorId: "w", cell: [0, 2], side: "W" }])).toEqual([]);
    expect(floorPlanProblems(L_PLAN, [{ doorId: "n", cell: [5, 2], side: "N" }])).toEqual([]);
    expect([isFloor(L_PLAN, 3, 0), isFloor(L_PLAN, 4, 0), isFloor(L_PLAN, 6, 2)]).toEqual([true, false, true]);
  });

  it("aponta porta fora da parede, passagem lateral de uma célula, canto interno colado e piso em ilhas", () => {
    const msgs = (plan = fullFloorPlan(), doors: Parameters<typeof floorPlanProblems>[1]) => floorPlanProblems(plan, doors).map((p) => p.message["pt-BR"]);
    expect(msgs(undefined, [{ doorId: "meio", cell: [3, 3], side: "N" }])[0]).toMatch(/não é parede/);
    expect(msgs(undefined, [{ doorId: "w", cell: [0, 5], side: "W" }])[0]).toMatch(/duas células/);
    // L: porta E na coluna 3 (linhas 0–1) com canto interno logo abaixo (linha 2 se estende à direita).
    expect(msgs(L_PLAN, [{ doorId: "e", cell: [3, 0], side: "E" }]).join(" ")).toMatch(/canto interno/);
    const islands = fullFloorPlan();
    islands.cells = islands.cells.map((_, i) => i % 7 !== 3);
    expect(msgs(islands, [{ doorId: "w", cell: [0, 0], side: "W" }]).join(" ")).toMatch(/uma peça só/);
    expect(msgs(undefined, [])[0]).toMatch(/1 a 8 portas/);
    // Mesma mensagem em inglês para o editor no outro idioma.
    expect(floorPlanProblems(fullFloorPlan(), [{ doorId: "meio", cell: [3, 3], side: "N" }])[0]!.message.en).toBe("meio: the N side of 3,3 is not a wall");
  });

  it("duas salas: portas opostas ligam com mesma vista e escala; lados e escalas diferentes são recusados", () => {
    const grid = roomGrid("top_down", 32);
    const room = (doors: RoomPayload["doors"], tileSize = 32) => ({ projection: "top_down" as const, cellPx: grid.cellPx, gridOrigin: grid.gridOrigin, tileSize, doors, picture: { fileId: "p", rect: [0, 0, 256, 256] as [number, number, number, number] } });
    const a = room([{ doorId: "leste", cell: [6, 2], side: "E", anchorPx: null, triggerPx: null, arrivePx: null }]);
    const b = room([{ doorId: "oeste", cell: [0, 2], side: "W", anchorPx: null, triggerPx: null, arrivePx: null }]);
    expect(linkDoors(a, "leste", b, "oeste")).toMatchObject({ ok: true, offsetPx: [256, 0], method: "grid" });
    expect(linkDoors(a, "leste", a, "leste").problems[0]?.["pt-BR"]).toMatch(/Lados não se encontram/);
    expect(linkDoors(a, "leste", room(b.doors, 16), "oeste").problems[0]?.en).toMatch(/Different scales/);
    // Âncoras nas portas (top-down): B = A + âncoraA − âncoraB.
    const withAnchors = (r: typeof a, anchor: [number, number]) => ({ ...r, doors: r.doors.map((d) => ({ ...d, anchorPx: anchor })) });
    expect(linkDoors(withAnchors(a, [240, 128]), "leste", withAnchors(b, [16, 128]), "oeste")).toMatchObject({ ok: true, offsetPx: [224, 0], method: "anchors" });
    expect(doorGeometry({ projection: "top_down", cellPx: [32, 32], gridOrigin: [16, 48] }, { cell: [3, 5], side: "S" }).anchorPx).toEqual([128, 256]);
  });

  it("móvel: apoio e footprint precisam cair no piso", () => {
    const room = { projection: "top_down" as const, cellPx: [32, 32] as [number, number], gridOrigin: [16, 48] as [number, number], floorPlan: L_PLAN };
    expect(roomCellAt(room, [128, 120])).toEqual([3, 2]);
    expect(furnitureProblems(room, [128, 120], { footprintCells: [1, 1] })).toEqual([]);
    expect(furnitureProblems(room, [200, 70], { footprintCells: [1, 1] })[0]?.["pt-BR"]).toMatch(/fora do piso/);
    expect(furnitureProblems(room, [140, 64], { footprintCells: [2, 1] }).map((p) => p["pt-BR"]).join(" ")).toMatch(/Footprint sai do piso/);
  });
});

describe("kit → mapa editável", () => {
  it("planta vira vértices piso/parede com borda; portas viram entradas com o mesmo ID", () => {
    const { size, vertices } = roomVertices(L_PLAN);
    expect(size).toEqual([9, 8]);
    expect(vertices[0]).toBe(1); // canto do mapa: parede
    expect(vertices[1 * 10 + 1]).toBe(0); // vértice que toca a célula (0,0) da sala: piso
    expect(vertices[1 * 10 + 8]).toBe(1); // canto superior direito do L é rocha
    expect(roomEntrances({ doors: [{ doorId: "s", cell: [3, 5], side: "S", anchorPx: null, triggerPx: null, arrivePx: null }] })).toEqual([{ entranceId: "s", name: "Porta S", cell: [4, 6], side: "S" }]);
  });

  it("folha mapeada por chave: 16 máscaras completam; falta de máscara não declara completo", () => {
    const rects = sheetCells([128, 160], [32, 32]);
    expect(rects).toHaveLength(20);
    const keys = proposeMaskOrder(20);
    keys[16] = { kind: "door", side: "N" };
    const full = kitTilesetPayload({ fileId: "atlas", cell: [32, 32], margin: 0, spacing: 0, rects, keys });
    expect(full.payload.complete).toBe(true);
    expect(full.doors).toEqual([{ side: "N", rect: [0, 128, 32, 32] }]);
    const partial = kitTilesetPayload({ fileId: "atlas", cell: [32, 32], margin: 0, spacing: 0, rects, keys: keys.slice(0, 15) });
    expect([partial.payload.complete, partial.missing]).toEqual([false, [15]]);
  });
});

describe("paralaxe por eixo", () => {
  const sky = { size: [64, 48] as const, offset: [0, 0] as const, parallax: { x: 0.25, y: 0 }, repeat: { x: true, y: false } };
  it("plano repetido cobre a tela e volta ao lugar após um período", () => {
    expect(layerOrigin(sky, [100, 0])).toEqual([-25, 0]);
    expect(layerCopies(sky, [100, 0], [80, 48]).map(([x]) => x)).toEqual([-25, 39]);
    expect(layerCopies(sky, [256, 0], [80, 48])).toEqual(layerCopies(sky, [0, 0], [80, 48]));
    expect(cameraSpan([sky], [80, 48])).toBe(512); // duas larguras do céu com fator 0,25
    expect(cameraStops(512, 4)).toEqual([0, 128, 256, 384, 512]);
    expect(layerLeavesGap({ ...sky, size: [96, 48], repeat: { x: false, y: false } }, 512, [80, 48])).toBe(true); // plano largo sai da tela
    expect(layerLeavesGap({ ...sky, size: [16, 16], offset: [40, 4], repeat: { x: false, y: false } }, 512, [80, 48])).toBe(false); // sol: finito por intenção
  });
});

describe("isométrico com personagem: direções, apoio, colisão e oclusão", () => {
  const tileset: IsoTilesetPayload = {
    projection: "isometric",
    groundDiamondSize: [64, 32],
    logicalCellSize: [32, 32],
    elevationStepPx: 8,
    sortRule: "depth_ij_elevation_v1",
    atlas: { fileId: "atlas", margin: 0, spacing: 0 },
    pieces: [
      { pieceKey: "chao", kind: "floor", name: "Chão", rect: [0, 0, 64, 32], logicalSize: [64, 32], groundOrigin: [32, 0], supportPoint: [32, 16], footprintCells: [1, 1], elevation: 0, occluderRect: null, blocksMovement: false },
      { pieceKey: "arvore", kind: "prop", name: "Árvore alta", rect: [64, 0, 48, 96], logicalSize: [48, 96], groundOrigin: [24, 76], supportPoint: [24, 92], footprintCells: [1, 1], elevation: 0, occluderRect: [0, 0, 48, 66], blocksMovement: true },
    ],
  };
  const map = TilemapPayload.parse({
    projection: "isometric",
    size: [6, 6],
    cellSize: [64, 32],
    seed: 1,
    units: { cell: "cell", offset: "px", polygon: "px" },
    terrain: { mode: "isometric", tilesetRevisionId: "ts", rule: "iso-v1", cells: Array.from({ length: 36 }, (_, i) => ({ pieceKey: "chao", elevation: i === 4 * 6 + 3 ? 1 : 0 })) },
    objects: [{ objectId: "arvore-1", objectRevisionId: null, pieceKey: "arvore", cell: [3, 3], offsetPx: [0, 0] }],
    collisions: [],
    regions: [],
    entrances: [],
    passages: [],
  });

  it("E no mundo seleciona SE na tela; N seleciona NE (tabela de 04), sem girar bitmap", () => {
    expect(viewForWorld("E")).toBe("SE");
    expect(viewForWorld("N")).toBe("NE");
    expect(viewForWorld("S")).toBe("SW");
    expect(viewForWorld("W")).toBe("NW");
    expect(isoWorldToView().NE).toBe("E");
    const base = { views: [{ direction: "SE" as const, fileId: "v", rect: [0, 0, 16, 32] as [number, number, number, number], sourceOffset: [0, 0] as [number, number] }] };
    expect(characterView(base, "E")).toMatchObject({ view: "SE", art: { direction: "SE" } });
    expect(characterView(base, "N")).toEqual({ view: "NE", art: null }); // vista ausente fica ausente (sem espelho)
  });

  it("colisão pelo footprint do prop, apoio seguindo a elevação do piso e personagem atrás/à frente do prop alto", () => {
    const world = isoWorld(map, tileset);
    const start = { cell: [2, 3] as [number, number], facing: "E" as const };
    expect(stepActor(world, start, "E")).toMatchObject({ moved: false, reason: { "pt-BR": expect.stringMatching(/footprint/), en: expect.stringMatching(/footprint/) } });
    // (2,2) fica logo atrás do tronco na tela (i−j igual, i+j menor); (4,4) logo à frente.
    const behind = isoDrawList(world, { cell: [2, 2], facing: "SE" }, { size: [16, 32], pivot: [8, 30] });
    expect(occludersOf(behind.items)).toEqual(["arvore-1"]); // atrás da copa
    const front = isoDrawList(world, { cell: [4, 4], facing: "NW" }, { size: [16, 32], pivot: [8, 30] });
    expect(occludersOf(front.items)).toEqual([]); // à frente: desenhado depois do prop
    const raised = isoDrawList(world, { cell: [3, 4], facing: "S" }, { size: [16, 32], pivot: [8, 30] });
    const flat = isoDrawList(world, { cell: [2, 4], facing: "S" }, { size: [16, 32], pivot: [8, 30] });
    expect(raised.elevation).toBe(1);
    // Uma linha de losango abaixo (+16 px) e um degrau acima (−8 px): o apoio acompanha o piso.
    expect(raised.actorSupport[1] - flat.actorSupport[1]).toBe(16 - 8);
    expect(stepActor(world, { cell: [0, 0], facing: "N" }, "N")).toMatchObject({ moved: false, reason: { "pt-BR": "borda do mapa", en: "edge of the map" } });
  });
});

describe("contratos de cena e sala", () => {
  it("imagem plana não declara planos; cena em camadas exige teste da câmera; plano sem continuidade não repete", () => {
    const flat = { outputKind: "flat_image", projection: "side", logicalSize: [8, 8], image: { fileId: "i", rect: [0, 0, 8, 8] }, layers: [], supportPoints: [], characterScale: null, groundLineY: null, editable: { map: false, collisions: false, objects: false }, cameraTest: null };
    expect(ScenePayload.safeParse(flat).success).toBe(true);
    expect(ScenePayload.safeParse({ ...flat, editable: { map: true, collisions: false, objects: false } }).success).toBe(false);
    expect(ScenePayload.safeParse({ ...flat, layers: [{ layerId: "a", name: "a", layerRevisionId: "r", offset: [0, 0], parallax: { x: 1, y: 0 }, repeat: { x: true, y: false } }] }).success).toBe(false);
    const layer = { fileId: "l", rect: [0, 0, 8, 8], logicalSize: [8, 8], depth: "far", obtained: "imported", requestedRepeat: { x: true, y: false }, repeat: { x: true, y: false }, continuity: { x: null, y: null }, groundLineY: null, derivation: null };
    expect(SceneLayerPayload.safeParse(layer).success).toBe(false);
    expect(SceneLayerPayload.safeParse({ ...layer, obtained: "derived_local_reviewed" }).success).toBe(false); // derivação sem origem/máscara
  });
});
