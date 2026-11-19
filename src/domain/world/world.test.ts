import { describe, expect, it } from "vitest";
import { type CornerTilesetPayload, IsoTilesetPayload, MapObjectPayload, SideTilesetPayload, TilemapPayload } from "@/contracts";
import { isoCellTop } from "../projection";
import { type Bit, CORNER_SAMPLE, compatibleCornerPairs, cornerMask, chooseVariant, resolveCornerMap, tiledWangId } from "./corner";
import { inIsoDiamond, isoDrawPosition, isoScreenToCell, isoSupportScreen } from "./iso";
import { asCornerMap, checkPassages, emptyCornerMap, fillCornerVertices, isCornerMap, moveObject, paintCornerVertex, reresolveCorner } from "./map";
import { resolveSideMap, SIDE_SAMPLE, sideConfiguration } from "./side";

const tileset = (variants = 1): Pick<CornerTilesetPayload, "tiles" | "terrains" | "projection"> => ({
  projection: "top_down",
  terrains: [
    { terrainId: "grass", name: "Grama", color: "#469632" },
    { terrainId: "water", name: "Água", color: "#3264c8" },
  ],
  tiles: Array.from({ length: 16 * variants }, (_, i) => ({
    tileKey: `gw-${i % 16}${i >= 16 ? `-v${Math.floor(i / 16)}` : ""}`,
    mask: i % 16,
    variant: Math.floor(i / 16),
    weight: 1,
    rect: [((i % 16) % 4) * 32, Math.floor((i % 16) / 4) * 32, 32, 32] as [number, number, number, number],
    frames: [],
  })),
});

describe("autotile por cantos", () => {
  it("máscara pelos vértices compartilhados e Wang ID do Tiled (máscara 9 = água a oeste)", () => {
    // 2×2 células, vértices 3×3: água só no vértice central.
    const v: Bit[] = [0, 0, 0, 0, 1, 0, 0, 0, 0];
    expect([cornerMask(v, 2, 0, 0), cornerMask(v, 2, 1, 0), cornerMask(v, 2, 0, 1), cornerMask(v, 2, 1, 1)]).toEqual([4, 8, 2, 1]);
    expect(tiledWangId(9)).toEqual([0, 1, 0, 1, 0, 2, 0, 2]);
  });

  it("64 pares compatíveis por eixo com um tile por máscara", () => {
    const pairs = compatibleCornerPairs(Array.from({ length: 16 }, (_, i) => i));
    expect(pairs.filter((p) => p.axis === "x")).toHaveLength(64);
    expect(pairs.filter((p) => p.axis === "y")).toHaveLength(64);
  });

  it("variante estável pela semente, coordenada global, conjunto e regra; ordem das candidatas não importa", () => {
    const ts = tileset(3).tiles.filter((t) => t.mask === 0);
    const a = chooseVariant(ts, 7, [3, 4], "grass/water", "corner-v1");
    expect(chooseVariant([...ts].reverse(), 7, [3, 4], "grass/water", "corner-v1")).toEqual(a);
    const picks = new Set(Array.from({ length: 40 }, (_, i) => chooseVariant(ts, 7, [i, 0], "grass/water", "corner-v1")!.tileKey));
    expect(picks.size).toBeGreaterThan(1);
  });

  it("a amostra de lago usa as diagonais e aponta máscara ausente", () => {
    const full = resolveCornerMap(CORNER_SAMPLE.vertices, CORNER_SAMPLE.size, tileset(), { seed: 1, setKey: "s" });
    expect(full.missing).toEqual([]);
    expect(new Set(full.masks).has(5) || new Set(full.masks).has(10)).toBe(true);
    const without9 = { tiles: tileset().tiles.filter((t) => t.mask !== 9) };
    const res = resolveCornerMap(CORNER_SAMPLE.vertices, CORNER_SAMPLE.size, without9, { seed: 1, setKey: "s" });
    if (full.masks.includes(9)) expect(res.missing).toEqual([9]);
  });

  it("repintar um vértice recalcula só as até quatro células que o tocam", () => {
    const map = emptyCornerMap({ size: [12, 8], cellSize: [32, 32], tilesetRevisionId: "ts-1", tileset: tileset() });
    if (!isCornerMap(map)) throw new Error("mapa");
    const { map: painted, changedCells } = paintCornerVertex(map, tileset(), 5, 3, 1);
    expect(changedCells).toHaveLength(4);
    const changed = painted.terrain.resolved.map((k, i) => (k !== map.terrain.resolved[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed.sort((a, b) => a - b)).toEqual([2 * 12 + 4, 2 * 12 + 5, 3 * 12 + 4, 3 * 12 + 5]);
    expect(TilemapPayload.safeParse(painted).success).toBe(true);
    // Canto do mapa: só uma célula.
    expect(paintCornerVertex(map, tileset(), 0, 0, 1).changedCells).toEqual([[0, 0]]);
  });
});

describe("tabela lateral própria", () => {
  it("plataforma longa, bordas, vão, degraus e cantos internos", () => {
    const at = (x: number, y: number) => sideConfiguration(SIDE_SAMPLE.solid, SIDE_SAMPLE.size, x, y);
    expect(at(0, 0)).toBeNull();
    expect(at(3, 3)).toBe("surface_right"); // borda antes do vão
    expect(at(6, 3)).toBe("surface_left"); // borda depois do vão
    expect(at(7, 3)).toBe("inner_corner_left"); // degrau: ar só na diagonal de cima
    expect(at(1, 3)).toBe("inner_corner_right");
    expect(at(3, 4)).toBe("wall_right");
    expect(at(8, 2)).toBe("surface_middle");
    expect(at(9, 4)).toBe("interior");
  });

  it("configuração usada e ausente no tileset vira lacuna visível", () => {
    const tiles: SideTilesetPayload["tiles"] = ["surface_middle", "surface_left", "surface_right", "interior", "wall_left", "wall_right", "inner_corner_left"].map((c, i) => ({
      tileKey: `side-${c}`,
      configuration: c as SideTilesetPayload["tiles"][number]["configuration"],
      variant: 0,
      weight: 1,
      rect: [i * 16, 0, 16, 16],
      frames: [],
    }));
    const res = resolveSideMap(SIDE_SAMPLE.solid, SIDE_SAMPLE.size, { tiles });
    expect(res.gaps).toEqual(["inner_corner_right"]);
    expect(res.tileKeys[3 * 12 + 1]).toBeNull();
  });
});

describe("projeção isométrica", () => {
  const diamond = [64, 32] as const;
  it("vértice (ox + (i−j)·32, oy + (i+j)·16) e prop apoiado 16 px abaixo dele", () => {
    expect(isoCellTop(2, 1, diamond, [100, 10])).toEqual([132, 58]);
    expect(isoSupportScreen([2, 1], [1, 1], diamond, 0, [100, 10])).toEqual([132, 74]);
    const tree = { supportPoint: [24, 92] as [number, number], footprintCells: [1, 1] as [number, number] };
    const [x, y] = isoDrawPosition(tree, [2, 1], diamond, 0, [100, 10]);
    expect([x + 24, y + 92]).toEqual([132, 74]); // o apoio do prop alto cai no centro da célula
  });

  it("seleção pelo losango, não pela caixa do PNG: o chão sob a copa é a célula de trás", () => {
    // Ponto alto na tela, coberto pela copa do prop da célula (1,1), pertence à célula (0,0).
    expect(isoScreenToCell([0, 20], diamond)).toEqual([0, 0]);
    expect(isoScreenToCell([0, 50], diamond)).toEqual([1, 1]);
  });

  it("losangos vizinhos particionam o plano (regra do centro do pixel)", () => {
    let overlaps = 0;
    let holes = 0;
    for (let y = 16; y < 48; y++) {
      for (let x = -32; x < 32; x++) {
        const n = [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].filter(([i, j]) => inIsoDiamond(x, y, isoCellTop(i!, j!, diamond), diamond)).length;
        if (n > 1) overlaps++;
        if (n === 0 && Math.abs(x + 0.5) / 32 + Math.abs(y + 0.5 - 32) / 32 < 1) holes++;
      }
    }
    expect([overlaps, holes]).toEqual([0, 0]);
  });

  it("contrato: apoio no centro do losango do footprint", () => {
    const piece = (supportPoint: [number, number]) => ({
      projection: "isometric",
      groundDiamondSize: [64, 32],
      logicalCellSize: [32, 32],
      elevationStepPx: 16,
      sortRule: "depth_ij_elevation_v1",
      atlas: { fileId: "a", margin: 0, spacing: 0 },
      pieces: [{ pieceKey: "tree", kind: "prop", name: "Árvore", rect: [0, 0, 48, 96], logicalSize: [48, 96], groundOrigin: [24, 76], supportPoint, footprintCells: [1, 1], elevation: 0, occluderRect: [0, 0, 48, 60], blocksMovement: true }],
    });
    expect(IsoTilesetPayload.safeParse(piece([24, 92])).success).toBe(true);
    expect(IsoTilesetPayload.safeParse(piece([24, 90])).success).toBe(false);
  });
});

describe("mapa editável", () => {
  const tree: Pick<MapObjectPayload, "supportPoint" | "footprintCells" | "collision"> = { supportPoint: [16, 44], footprintCells: [1, 1], collision: [[13, 40, 6, 6]] };

  function demoMap(): TilemapPayload {
    let map = asCornerMap(emptyCornerMap({ size: [12, 8], cellSize: [32, 32], tilesetRevisionId: "ts-1", tileset: tileset() }));
    // Lago no meio (vértices de água), deixando uma passagem pela linha de baixo.
    for (let vy = 1; vy <= 6; vy++) for (let vx = 5; vx <= 7; vx++) map = paintCornerVertex(map, tileset(), vx, vy, 1).map;
    return {
      ...map,
      objects: [{ objectId: "arvore-1", objectRevisionId: "tree-r1", pieceKey: null, cell: [2, 3] as [number, number], offsetPx: [0, 0] as [number, number] }],
      entrances: [
        { entranceId: "porta-oeste", name: "Oeste", cell: [0, 3] as [number, number], side: "W" as const },
        { entranceId: "porta-leste", name: "Leste", cell: [11, 3] as [number, number], side: "E" as const },
      ],
      passages: [{ from: "porta-oeste", to: "porta-leste" }],
    };
  }
  const ctx = { objects: new Map([["tree-r1", tree]]) };

  it("passagem entre portas contorna o lago; a árvore bloqueia só a célula do tronco", () => {
    const map = demoMap();
    expect(TilemapPayload.safeParse(map).success).toBe(true);
    const res = checkPassages(map, ctx);
    expect(res.supported).toBe(true);
    expect(res.results[0]).toMatchObject({ connected: true });
    expect(res.blocked![3 * 12 + 2]).toBe(true); // tronco
    expect(res.blocked![2 * 12 + 2]).toBe(false); // copa não bloqueia
  });

  it("fechar o vau de baixo com água interrompe a passagem; mover a árvore não altera o terreno", () => {
    let closed = asCornerMap(demoMap());
    // Faixa de água de cima a baixo (vértices x = 5..7) fecha os dois vaus.
    for (let vy = 0; vy <= 8; vy++) for (let vx = 5; vx <= 7; vx++) closed = paintCornerVertex(closed, tileset(), vx, vy, 1).map;
    const blocked = checkPassages(closed, ctx);
    expect(blocked.results[0]).toMatchObject({ connected: false, reason: { "pt-BR": "Sem caminho entre as entradas", en: "No path between the entrances" } });
    // Preenchimento: secar o lago a partir de um vértice de água devolve a passagem.
    const dried = fillCornerVertices(closed, tileset(), 6, 4, 0);
    expect(dried.terrain.vertices.every((v) => v === 0)).toBe(true);
    expect(checkPassages(dried, ctx).results[0]).toMatchObject({ connected: true, steps: 11 + 2 });
    const moved = moveObject(demoMap(), "arvore-1", [4, 7]);
    expect(moved.terrain).toEqual(demoMap().terrain);
    expect(moved.objects[0]!.cell).toEqual([4, 7]);
  });

  it("trocar a revisão do tileset re-resolve sem mudar traçado nem colocações", () => {
    const map = asCornerMap(demoMap());
    const other = { ...tileset(), tiles: tileset().tiles.map((t) => ({ ...t, tileKey: `novo-${t.mask}` })) };
    const swapped = reresolveCorner({ ...map, terrain: { ...map.terrain, tilesetRevisionId: "ts-2" } }, other);
    expect(swapped.terrain.vertices).toEqual(map.terrain.vertices);
    expect(swapped.objects).toEqual(map.objects);
    expect(swapped.terrain.resolved.every((k) => k?.startsWith("novo-"))).toBe(true);
  });
});
