import { z } from "zod";
import { type LocalizedText, tx } from "@/i18n/locales";
import { checkUnique, DurationMs, GridPoint, HexColor, Id, Int, NonNegInt, Offset, PosInt, Rect, Size, Slug } from "./common";

/**
 * Texturas e tilesets (06). Cenas, salas, mapas e mundos entram com os cartões
 * T1/T2; este módulo cobre o necessário para a clareira (grama ↔ água).
 */

// ---------------------------------------------------------------------------
// Textura repetível
// ---------------------------------------------------------------------------

const SeamAxisReport = z.strictObject({
  /** Diferença RGBA média na junção de bordas opostas. */
  seamDelta: z.number().nonnegative(),
  /** Diferença RGBA média entre vizinhos internos (referência). */
  interiorDelta: z.number().nonnegative(),
  passed: z.boolean(),
});

export const TexturePayload = z
  .strictObject({
    fileId: Id,
    rect: Rect,
    logicalSize: Size,
    material: z.string().min(1).max(120),
    repeatAxes: z.strictObject({ x: z.boolean(), y: z.boolean() }),
    /**
     * Eixos pedidos na geração/importação (T1). Uma candidata cuja emenda foi
     * reprovada fica guardada com `repeatAxes` sem eixo e este campo registra o
     * pedido: amostra de material, não textura repetível.
     */
    requestedAxes: z.strictObject({ x: z.boolean(), y: z.boolean() }).optional(),
    seamReport: z.strictObject({
      method: Slug,
      /** Limiar declarado por material. */
      threshold: z.number().nonnegative(),
      x: SeamAxisReport.nullable(),
      y: SeamAxisReport.nullable(),
    }),
  })
  .superRefine((tex, ctx) => {
    if (tex.rect[2] !== tex.logicalSize[0] || tex.rect[3] !== tex.logicalSize[1]) {
      ctx.addIssue({ code: "custom", message: "Região da textura deve ter o tamanho lógico (sem extrusão)", path: ["rect"] });
    }
    if (!tex.repeatAxes.x && !tex.repeatAxes.y && !tex.requestedAxes) {
      // Sem eixo aprovado só como amostra de material que registra o pedido reprovado.
      ctx.addIssue({ code: "custom", message: "Textura repetível precisa de ao menos um eixo", path: ["repeatAxes"] });
    }
    if (tex.requestedAxes && ((tex.repeatAxes.x && !tex.requestedAxes.x) || (tex.repeatAxes.y && !tex.requestedAxes.y))) {
      ctx.addIssue({ code: "custom", message: "Eixo aprovado precisa ter sido pedido", path: ["repeatAxes"] });
    }
    for (const axis of ["x", "y"] as const) {
      if (tex.repeatAxes[axis]) {
        const report = tex.seamReport[axis];
        if (!report || !report.passed) {
          ctx.addIssue({
            code: "custom",
            message: `Eixo ${axis} declarado repetível sem relatório de emenda aprovado`,
            path: ["seamReport", axis],
          });
        }
      }
    }
  });
export type TexturePayload = z.infer<typeof TexturePayload>;

// ---------------------------------------------------------------------------
// Tileset de transição por cantos entre dois terrenos (06 §autotile)
// ---------------------------------------------------------------------------

/** Bits do terreno B por canto: NO=1, NE=2, SE=4, SO=8. */
export const CORNER_BITS = { NW: 1, NE: 2, SE: 4, SW: 8 } as const;
export const ALL_CORNER_MASKS: readonly number[] = Array.from({ length: 16 }, (_, i) => i);

export const Terrain = z.strictObject({
  terrainId: Slug,
  name: z.string().min(1).max(64),
  /** Cor de identificação (ex.: wangset do Tiled). */
  color: HexColor,
});

export const CornerTile = z.strictObject({
  tileKey: Id,
  mask: z.number().int().min(0).max(15),
  variant: NonNegInt,
  weight: PosInt,
  rect: Rect,
  /** Tile animado: fases com duração própria. Vazio = estático. */
  frames: z.array(z.strictObject({ rect: Rect, durationMs: DurationMs })),
});

export const CornerTilesetPayload = z
  .strictObject({
    projection: z.enum(["top_down", "three_quarter"]),
    cellSize: Size,
    atlas: z.strictObject({
      fileId: Id,
      margin: NonNegInt,
      spacing: NonNegInt,
    }),
    /** `[A, B]`: o bit marca B no canto. */
    terrains: z.tuple([Terrain, Terrain]),
    /** Diagonais ambíguas: B em NO+SE (5) e em NE+SO (10). */
    diagonals: z.strictObject({
      mask5: z.enum(["connected", "separate"]),
      mask10: z.enum(["connected", "separate"]),
    }),
    tiles: z.array(CornerTile).min(1),
    /** Só pode ser `true` com as 16 máscaras cobertas. */
    complete: z.boolean(),
  })
  .superRefine((ts, ctx) => {
    if (ts.terrains[0].terrainId === ts.terrains[1].terrainId) {
      ctx.addIssue({ code: "custom", message: "Os dois terrenos devem ser distintos", path: ["terrains"] });
    }
    checkUnique(ctx, ts.tiles, (t) => t.tileKey, "Tile", ["tiles"]);
    checkUnique(ctx, ts.tiles, (t) => `${t.mask}/${t.variant}`, "Máscara/variante", ["tiles"]);
    ts.tiles.forEach((tile, i) => {
      const rects = [tile.rect, ...tile.frames.map((f) => f.rect)];
      rects.forEach((r) => {
        if (r[2] !== ts.cellSize[0] || r[3] !== ts.cellSize[1]) {
          ctx.addIssue({ code: "custom", message: "Região do tile deve ter o tamanho da célula", path: ["tiles", i] });
        }
      });
    });
    if (ts.complete) {
      const missing = missingCornerMasks(ts.tiles.map((t) => t.mask));
      if (missing.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `Conjunto marcado completo sem as máscaras: ${missing.join(", ")}`,
          path: ["complete"],
        });
      }
    }
  });
export type CornerTilesetPayload = z.infer<typeof CornerTilesetPayload>;

export function missingCornerMasks(masks: readonly number[]): number[] {
  const present = new Set(masks);
  return ALL_CORNER_MASKS.filter((m) => !present.has(m));
}

// ---------------------------------------------------------------------------
// T1 · tileset lateral, tiles isométricos, objetos de mapa e mapa editável
// ---------------------------------------------------------------------------

/**
 * Tabela própria do tileset lateral (06 §cobertura lateral). A configuração
 * vem das faces expostas da célula sólida (topo, esquerda, direita, base) e
 * dos cantos internos (ar só na diagonal de cima). NÃO reaproveita os bits de
 * canto do top-down: cada chave nomeia uma peça de plataforma.
 */
export const SIDE_CONFIGURATIONS = [
  "surface_middle",
  "surface_left",
  "surface_right",
  "surface_single",
  "interior",
  "wall_left",
  "wall_right",
  "column_middle",
  "ceiling_middle",
  "ceiling_left",
  "ceiling_right",
  "column_bottom",
  "thin_middle",
  "thin_left",
  "thin_right",
  "block_single",
  "inner_corner_left",
  "inner_corner_right",
] as const;
export const SideConfiguration = z.enum(SIDE_CONFIGURATIONS);
export type SideConfiguration = z.infer<typeof SideConfiguration>;

/** Mínimo para plataforma longa, duas bordas, vão, degrau e canto interno (06 §cobertura lateral). */
export const DEFAULT_SIDE_REQUIRED: readonly SideConfiguration[] = [
  "surface_middle",
  "surface_left",
  "surface_right",
  "interior",
  "wall_left",
  "wall_right",
  "inner_corner_left",
  "inner_corner_right",
];

const AtlasRef = z.strictObject({ fileId: Id, margin: NonNegInt, spacing: NonNegInt });
const TileFrames = z.array(z.strictObject({ rect: Rect, durationMs: DurationMs }));

export const SideTile = z.strictObject({
  tileKey: Id,
  configuration: SideConfiguration,
  variant: NonNegInt,
  weight: PosInt,
  rect: Rect,
  frames: TileFrames,
});

export const SideTilesetPayload = z
  .strictObject({
    projection: z.literal("side"),
    cellSize: Size,
    atlas: AtlasRef,
    /** Corpo da plataforma (o material de baixo). */
    platformMaterial: z.string().min(1).max(200),
    /** Superfície caminhável (a faixa de transição por cima). */
    surfaceMaterial: z.string().min(1).max(200),
    /** Linha caminhável: y (px) do topo da superfície nas células com topo exposto. */
    walkableLineY: NonNegInt,
    requiredConfigurations: z.array(SideConfiguration).min(1),
    tiles: z.array(SideTile).min(1),
    /** Só `true` com todas as configurações exigidas presentes. */
    complete: z.boolean(),
  })
  .superRefine((ts, ctx) => {
    checkUnique(ctx, ts.tiles, (t) => t.tileKey, "Tile", ["tiles"]);
    checkUnique(ctx, ts.tiles, (t) => `${t.configuration}/${t.variant}`, "Configuração/variante", ["tiles"]);
    checkUnique(ctx, ts.requiredConfigurations, (c) => c, "Configuração exigida", ["requiredConfigurations"]);
    if (ts.walkableLineY >= ts.cellSize[1]) {
      ctx.addIssue({ code: "custom", message: "Linha caminhável fora da célula", path: ["walkableLineY"] });
    }
    ts.tiles.forEach((tile, i) => {
      for (const r of [tile.rect, ...tile.frames.map((f) => f.rect)]) {
        if (r[2] !== ts.cellSize[0] || r[3] !== ts.cellSize[1]) {
          ctx.addIssue({ code: "custom", message: "Região do tile deve ter o tamanho da célula", path: ["tiles", i] });
        }
      }
    });
    if (ts.complete) {
      const missing = missingSideConfigurations(ts.requiredConfigurations, ts.tiles.map((t) => t.configuration));
      if (missing.length > 0) {
        ctx.addIssue({ code: "custom", message: `Conjunto lateral marcado completo sem: ${missing.join(", ")}`, path: ["complete"] });
      }
    }
  });
export type SideTilesetPayload = z.infer<typeof SideTilesetPayload>;

export function missingSideConfigurations(required: readonly SideConfiguration[], present: readonly SideConfiguration[]): SideConfiguration[] {
  const have = new Set(present);
  return required.filter((c) => !have.has(c));
}

/**
 * Peça isométrica (06 §payload isométrico). Coordenadas em px da imagem da
 * peça: `groundOrigin` é o vértice superior do losango do footprint no chão
 * (elevação 0 da peça) e `supportPoint` o centro desse losango, onde a peça
 * pousa. São metadados locais, não parâmetros presumidos do provedor.
 */
export const IsoPiece = z.strictObject({
  pieceKey: Id,
  kind: z.enum(["floor", "block", "prop"]),
  name: z.string().min(1).max(64),
  rect: Rect,
  logicalSize: Size,
  groundOrigin: GridPoint,
  supportPoint: GridPoint,
  footprintCells: z.tuple([PosInt, PosInt]),
  /** Degraus de elevação do topo da peça (bloco/degrau); chão = 0. */
  elevation: NonNegInt,
  /** Região da peça (px locais) que pode cobrir um personagem atrás dela (ex.: copa). */
  occluderRect: Rect.nullable(),
  /** As células do footprint bloqueiam a passagem. */
  blocksMovement: z.boolean(),
});
export type IsoPiece = z.infer<typeof IsoPiece>;

export const IsoTilesetPayload = z
  .strictObject({
    projection: z.literal("isometric"),
    /** Losango do chão `[largura, altura]` em px, ex.: `[64, 32]`. */
    groundDiamondSize: Size,
    /** Célula lógica do mundo (ortogonal) que o losango representa. */
    logicalCellSize: Size,
    elevationStepPx: NonNegInt,
    /** Ordem de desenho: profundidade i+j, depois elevação, depois chão < bloco < prop. */
    sortRule: z.literal("depth_ij_elevation_v1"),
    atlas: AtlasRef,
    pieces: z.array(IsoPiece).min(1),
  })
  .superRefine((ts, ctx) => {
    const [dw, dh] = ts.groundDiamondSize;
    if (dw % 2 !== 0 || dh % 2 !== 0) ctx.addIssue({ code: "custom", message: "Losango deve ter largura e altura pares", path: ["groundDiamondSize"] });
    checkUnique(ctx, ts.pieces, (p) => p.pieceKey, "Peça", ["pieces"]);
    ts.pieces.forEach((p, i) => {
      const path = ["pieces", i];
      const [w, h] = p.logicalSize;
      if (p.rect[2] !== w || p.rect[3] !== h) ctx.addIssue({ code: "custom", message: "Região da peça deve ter o tamanho lógico", path: [...path, "rect"] });
      for (const key of ["groundOrigin", "supportPoint"] as const) {
        if (p[key][0] > w || p[key][1] > h) ctx.addIssue({ code: "custom", message: `${key} fora da peça`, path: [...path, key] });
      }
      const [fw, fh] = p.footprintCells;
      // Centro do footprint = vértice superior + ((fw − fh)·W/4, (fw + fh)·H/4), em inteiros.
      const dx = 4 * (p.supportPoint[0] - p.groundOrigin[0]);
      const dy = 4 * (p.supportPoint[1] - p.groundOrigin[1]);
      if (dx !== (fw - fh) * dw || dy !== (fw + fh) * dh) {
        ctx.addIssue({ code: "custom", message: "Ponto de apoio deve ser o centro do losango do footprint", path: [...path, "supportPoint"] });
      }
      if (p.kind === "floor" && (fw !== 1 || fh !== 1 || p.elevation !== 0)) {
        ctx.addIssue({ code: "custom", message: "Peça de chão ocupa 1 célula sem elevação", path });
      }
      if (p.occluderRect && (p.occluderRect[0] + p.occluderRect[2] > w || p.occluderRect[1] + p.occluderRect[3] > h)) {
        ctx.addIssue({ code: "custom", message: "Região de oclusão fora da peça", path: [...path, "occluderRect"] });
      }
    });
  });
export type IsoTilesetPayload = z.infer<typeof IsoTilesetPayload>;

/**
 * Objeto de mapa top-down/lateral (06 §derivar o kit): área ocupada em células
 * e ponto de apoio em px. A copa pode cobrir o personagem enquanto a colisão
 * segue o tronco. O prompt não cria colisão confiável: ela é revisada aqui.
 */
export const MapObjectPayload = z
  .strictObject({
    /** T2: `isometric` = móvel de sala isométrica (apoio no centro do losango do footprint). */
    projection: z.enum(["top_down", "three_quarter", "side", "isometric"]),
    fileId: Id,
    rect: Rect,
    logicalSize: Size,
    /** Ponto de apoio (px da imagem): pousa no centro do footprint. */
    supportPoint: GridPoint,
    footprintCells: z.tuple([PosInt, PosInt]),
    /** Retângulos de colisão em px da imagem (ex.: só o tronco). Vazio = não bloqueia. */
    collision: z.array(Rect).max(16),
    /** Pixels com y menor que este (px da imagem) cobrem o personagem atrás (copa). */
    occlusionAboveY: NonNegInt.nullable(),
    /**
     * T2: sombra separada (arquivo próprio), desenhada antes do objeto; `offset`
     * é a posição do canto da sombra relativa ao canto da imagem do objeto.
     */
    shadow: z.strictObject({ fileId: Id, rect: Rect, offset: Offset }).nullable().optional(),
    /** T2: móvel extraído de uma sala (proveniência; o prop é reutilizável em outras salas e mapas). */
    sourceRoom: z
      .strictObject({
        roomRevisionId: Id,
        pieceName: z.string().min(1).max(64),
        /** Retângulo da peça na imagem da sala de origem. */
        rectInRoom: Rect,
        /** Recorte local revisado com máscara explícita. */
        method: z.enum(["local_mask_cutout"]),
      })
      .nullable()
      .optional(),
  })
  .superRefine((o, ctx) => {
    const [w, h] = o.logicalSize;
    if (o.rect[2] !== w || o.rect[3] !== h) ctx.addIssue({ code: "custom", message: "Região do objeto deve ter o tamanho lógico", path: ["rect"] });
    if (o.supportPoint[0] > w || o.supportPoint[1] > h) ctx.addIssue({ code: "custom", message: "Ponto de apoio fora da imagem", path: ["supportPoint"] });
    o.collision.forEach((r, i) => {
      if (r[0] + r[2] > w || r[1] + r[3] > h) ctx.addIssue({ code: "custom", message: "Colisão fora da imagem", path: ["collision", i] });
    });
    if (o.occlusionAboveY !== null && o.occlusionAboveY > h) ctx.addIssue({ code: "custom", message: "Linha de oclusão fora da imagem", path: ["occlusionAboveY"] });
  });
export type MapObjectPayload = z.infer<typeof MapObjectPayload>;

const CellCoord = z.tuple([NonNegInt, NonNegInt]);
const Bit = z.union([z.literal(0), z.literal(1)]);
export const MAX_MAP_SIDE = 128;

export const CornerMapTerrain = z.strictObject({
  mode: z.literal("corner"),
  tilesetRevisionId: Id,
  /** Versão da regra: máscara por cantos + sorteio estável de variante. */
  rule: z.literal("corner-v1"),
  /** Terreno por vértice (0 = A, 1 = B), linha a linha: (cols+1)×(rows+1). */
  vertices: z.array(Bit),
  /** Terrenos caminháveis `[A, B]`. Célula bloqueada com 2+ cantos não caminháveis. */
  walkable: z.tuple([z.boolean(), z.boolean()]),
  /** Variante fixada manualmente pelo artista. */
  overrides: z.array(z.strictObject({ cell: CellCoord, tileKey: Id })),
  /** Tile resolvido por célula, linha a linha, com a revisão de tileset acima (`null` = máscara ausente no conjunto). */
  resolved: z.array(Id.nullable()),
});

export const SideMapTerrain = z.strictObject({
  mode: z.literal("side"),
  tilesetRevisionId: Id,
  rule: z.literal("side-v1"),
  /** Célula sólida (1) ou ar (0), linha a linha. */
  solid: z.array(Bit),
  /** Configuração resolvida por célula (null = ar). Ausente no tileset = lacuna visível. */
  resolved: z.array(SideConfiguration.nullable()),
});

export const IsoMapTerrain = z.strictObject({
  mode: z.literal("isometric"),
  tilesetRevisionId: Id,
  rule: z.literal("iso-v1"),
  /** Peça de chão/bloco por célula (null = vazio) e elevação em degraus. */
  cells: z.array(z.strictObject({ pieceKey: Id.nullable(), elevation: NonNegInt })),
});

export const MapPlacement = z.strictObject({
  objectId: Id,
  /** Objeto de mapa publicado (top-down/lateral)… */
  objectRevisionId: Id.nullable(),
  /** …ou peça `prop` do tileset isométrico do próprio mapa. */
  pieceKey: Id.nullable(),
  /** Célula do canto superior esquerdo do footprint. */
  cell: CellCoord,
  /** Ajuste fino em px a partir do centro do footprint. */
  offsetPx: Offset,
  label: z.string().min(1).max(64).optional(),
});
export type MapPlacement = z.infer<typeof MapPlacement>;

export const MapCollision = z.discriminatedUnion("kind", [
  z.strictObject({ collisionId: Id, kind: z.literal("cells"), cells: z.array(CellCoord).min(1).max(4096) }),
  /** Polígono em px do mapa (origem no canto superior esquerdo). */
  z.strictObject({ collisionId: Id, kind: z.literal("polygon"), points: z.array(z.tuple([Int, Int])).min(3).max(64) }),
]);
export type MapCollision = z.infer<typeof MapCollision>;

export const MapRegion = z.strictObject({
  regionId: Id,
  name: z.string().min(1).max(64),
  kind: z.enum(["area", "spawn", "trigger", "no_build"]),
  /** Retângulo em células `[x, y, w, h]`. */
  rect: Rect,
});

export const MapEntrance = z.strictObject({
  /** ID estável: o mundo liga (colocação, porta) sem dependência entre mapas. */
  entranceId: Id,
  name: z.string().min(1).max(64),
  cell: CellCoord,
  side: z.enum(["N", "E", "S", "W"]),
});

/**
 * Mapa editável de uma região (06 §montar a região): grade lógica de terreno,
 * regra resolvida, objetos, colisões, regiões e portas — não um screenshot.
 */

/** Erro de validação zod com texto bilíngue: `message` em português e `params.messages` com os dois idiomas para a interface. */
function localizedIssue(ctx: z.RefinementCtx, text: LocalizedText, path: (string | number)[]) {
  ctx.addIssue({ code: "custom", message: text["pt-BR"], params: { messages: text }, path });
}

export const TilemapPayload = z
  .strictObject({
    projection: z.enum(["top_down", "three_quarter", "side", "isometric"]),
    /** `[colunas, linhas]`. */
    size: Size,
    /** Célula em px (isométrico: o losango). */
    cellSize: Size,
    /** Semente do sorteio estável de variantes. */
    seed: NonNegInt,
    /** Unidades: `cell`/`rect` de região em células; `offsetPx` e polígonos em px do mapa. */
    units: z.strictObject({ cell: z.literal("cell"), offset: z.literal("px"), polygon: z.literal("px") }),
    terrain: z.discriminatedUnion("mode", [CornerMapTerrain, SideMapTerrain, IsoMapTerrain]),
    objects: z.array(MapPlacement).max(1024),
    collisions: z.array(MapCollision).max(256),
    regions: z.array(MapRegion).max(256),
    entrances: z.array(MapEntrance).max(64),
    /** Passagens exigidas entre entradas (conferidas ao publicar). */
    passages: z.array(z.strictObject({ from: Id, to: Id })).max(64),
  })
  .superRefine((m, ctx) => {
    const [cols, rows] = m.size;
    if (cols > MAX_MAP_SIDE || rows > MAX_MAP_SIDE) {
      localizedIssue(ctx, tx(`Mapa limitado a ${MAX_MAP_SIDE}×${MAX_MAP_SIDE} células`, `Maps are limited to ${MAX_MAP_SIDE}×${MAX_MAP_SIDE} cells`), ["size"]);
      return;
    }
    const inside = (c: readonly [number, number]) => c[0] < cols && c[1] < rows;
    const t = m.terrain;
    const expectMode = m.projection === "side" ? "side" : m.projection === "isometric" ? "isometric" : "corner";
    if (t.mode !== expectMode) localizedIssue(ctx, tx(`Projeção ${m.projection} usa terreno ${expectMode}`, `Projection ${m.projection} uses ${expectMode} terrain`), ["terrain", "mode"]);
    const lengths: [string, number, number][] =
      t.mode === "corner"
        ? [["vertices", t.vertices.length, (cols + 1) * (rows + 1)], ["resolved", t.resolved.length, cols * rows]]
        : t.mode === "side"
          ? [["solid", t.solid.length, cols * rows], ["resolved", t.resolved.length, cols * rows]]
          : [["cells", t.cells.length, cols * rows]];
    for (const [key, got, want] of lengths) {
      if (got !== want) localizedIssue(ctx, tx(`${key} deve ter ${want} valores (recebido ${got})`, `${key} must have ${want} values (got ${got})`), ["terrain", key]);
    }
    if (t.mode === "corner") {
      checkUnique(ctx, t.overrides, (o) => `${o.cell[0]},${o.cell[1]}`, "Substituição", ["terrain", "overrides"]);
      t.overrides.forEach((o, i) => {
        if (!inside(o.cell)) localizedIssue(ctx, tx("Substituição fora do mapa", "Override outside the map"), ["terrain", "overrides", i]);
      });
    }
    checkUnique(ctx, m.objects, (o) => o.objectId, "Objeto", ["objects"]);
    m.objects.forEach((o, i) => {
      if (!inside(o.cell)) localizedIssue(ctx, tx("Objeto fora do mapa", "Object outside the map"), ["objects", i, "cell"]);
      if ((o.objectRevisionId === null) === (o.pieceKey === null)) {
        localizedIssue(ctx, tx("Objeto aponta para uma revisão de objeto OU para uma peça isométrica", "An object points to an object revision OR to an isometric piece"), ["objects", i]);
      }
      if (o.pieceKey !== null && m.projection !== "isometric") {
        localizedIssue(ctx, tx("Peça de tileset como objeto só no isométrico", "Tileset pieces can be objects only in isometric maps"), ["objects", i, "pieceKey"]);
      }
    });
    checkUnique(ctx, m.collisions, (c) => c.collisionId, "Colisão", ["collisions"]);
    m.collisions.forEach((c, i) => {
      if (c.kind === "cells" && c.cells.some((cell) => !inside(cell))) localizedIssue(ctx, tx("Colisão fora do mapa", "Collision outside the map"), ["collisions", i]);
    });
    checkUnique(ctx, m.regions, (r) => r.regionId, "Região", ["regions"]);
    m.regions.forEach((r, i) => {
      if (r.rect[0] + r.rect[2] > cols || r.rect[1] + r.rect[3] > rows) localizedIssue(ctx, tx("Região fora do mapa", "Region outside the map"), ["regions", i, "rect"]);
    });
    checkUnique(ctx, m.entrances, (e) => e.entranceId, "Entrada", ["entrances"]);
    m.entrances.forEach((e, i) => {
      if (!inside(e.cell)) localizedIssue(ctx, tx("Entrada fora do mapa", "Entrance outside the map"), ["entrances", i, "cell"]);
    });
    const ids = new Set(m.entrances.map((e) => e.entranceId));
    m.passages.forEach((p, i) => {
      for (const end of ["from", "to"] as const) {
        if (!ids.has(p[end])) localizedIssue(ctx, tx(`Passagem cita entrada inexistente: ${p[end]}`, `Passage refers to a missing entrance: ${p[end]}`), ["passages", i, end]);
      }
    });
  });
export type TilemapPayload = z.infer<typeof TilemapPayload>;

// ---------------------------------------------------------------------------
// Receitas do processador Python para o mundo (registradas em python-protocol)
// ---------------------------------------------------------------------------

const TileRegion = z.strictObject({
  key: Id,
  rect: Rect,
  mask: z.number().int().min(0).max(15).optional(),
  configuration: SideConfiguration.optional(),
});

const IsoPieceGeometry = z.strictObject({
  key: Id,
  kind: z.enum(["floor", "block", "prop"]),
  rect: Rect,
  groundOrigin: GridPoint,
  supportPoint: GridPoint,
  footprintCells: z.tuple([PosInt, PosInt]),
  elevation: NonNegInt,
});

export const WORLD_PYTHON_RECIPES = {
  /** Emendas da textura: junção de bordas opostas × diferença interna, mosaico 3×3 e deslocamento cíclico. */
  texture_seams: z.strictObject({
    version: z.literal(1),
    axes: z.strictObject({ x: z.boolean(), y: z.boolean() }),
    /** Limiar declarado do material: emenda/interior máximo aceito. */
    threshold: z.number().positive().max(20),
    zoom: PosInt.max(16),
  }),
  /** Gabaritos locais das 16 máscaras por cantos a partir de duas texturas (entradas `layer` 0 = A, 1 = B). */
  corner_guides: z.strictObject({
    version: z.literal(1),
    cellSize: Size,
    diagonals: z.strictObject({ mask5: z.enum(["connected", "separate"]), mask10: z.enum(["connected", "separate"]) }),
    /** Faixa de borda travada em px: só depende dos dois cantos daquele lado. */
    bandPx: z.number().int().min(1).max(16),
    seed: NonNegInt,
  }),
  /** Gabaritos da tabela lateral (entradas `layer` 0 = corpo, 1 = superfície). */
  side_guides: z.strictObject({
    version: z.literal(1),
    cellSize: Size,
    configurations: z.array(SideConfiguration).min(1).max(64),
    surfaceDepthPx: PosInt,
    columns: PosInt.max(16),
  }),
  /** Emendas de um atlas: pares compatíveis (cantos) ou vizinhos da amostra (lateral) e mosaico da amostra. */
  tileset_seams: z.strictObject({
    version: z.literal(1),
    layout: z.enum(["corner", "side"]),
    cellSize: Size,
    tiles: z.array(TileRegion).min(1).max(512),
    threshold: z.number().positive().max(20),
    /** Borda travada: compara a faixa externa ao gabarito (entrada `layer`). 0 = modo livre. */
    lockedBandPx: z.number().int().min(0).max(16),
    /** Mapa de amostra: chave do tile por célula (linha a linha); "" = vazio. */
    sample: z.strictObject({ size: Size, cells: z.array(z.string().max(128)) }),
    zoom: PosInt.max(16),
  }),
  /** Máscara de edição (255 edita) do miolo de cada região, sem a faixa travada nem a borda do alfa. */
  tile_edit_mask: z.strictObject({
    version: z.literal(1),
    regions: z.array(z.strictObject({ rect: Rect, bandPx: NonNegInt })).min(1).max(512),
    alphaEdgePx: z.number().int().min(0).max(4),
  }),
  /** Peças isométricas locais: textura projetada no losango (chão e bloco) + prop opcional (entrada `layer` 1). */
  iso_pieces: z.strictObject({
    version: z.literal(1),
    diamond: Size,
    blockHeightPx: NonNegInt,
  }),
  /** Losangos, apoio e oclusão: cobertura do losango, retalho 2×2 sem buraco/sobreposição e apoio do prop. */
  iso_check: z.strictObject({
    version: z.literal(1),
    diamond: Size,
    elevationStepPx: NonNegInt,
    pieces: z.array(IsoPieceGeometry).min(1).max(256),
    patch: z.strictObject({
      size: Size,
      cells: z.array(z.strictObject({ key: Id.nullable(), elevation: NonNegInt })),
      props: z.array(z.strictObject({ key: Id, cell: CellCoord })),
      /** Células onde desenhar o personagem de teste (atrás/à frente do prop). */
      probes: z.array(CellCoord),
    }),
    zoom: PosInt.max(16),
  }),
} as const;

/**
 * Geração guiada de tileset (T1): o gabarito local aprovado vai ao modelo como
 * guia; a faixa de borda travada é reaplicada depois da resposta. Rota
 * genérica com referências, não geração nativa de tileset.
 */
export const TilesetGuide = z.strictObject({
  /** Revisão aprovada do gabarito (mesmo asset do tileset). */
  revisionId: Id,
  /** Tamanho do atlas do gabarito; o candidato volta a essa grade. */
  atlasSize: Size,
  lockedBandPx: z.number().int().min(0).max(16),
  /**
   * Geometria congelada do gabarito: regiões editáveis (miolo dos tiles ou
   * losangos de chão/bloco; props ficam protegidos) e as chaves usadas para
   * conferir as emendas do resultado.
   */
  geometry: z.discriminatedUnion("layout", [
    z.strictObject({ layout: z.literal("corner"), cellSize: Size, tiles: z.array(z.strictObject({ key: Id, rect: Rect, mask: z.number().int().min(0).max(15) })).min(1).max(256) }),
    z.strictObject({ layout: z.literal("side"), cellSize: Size, tiles: z.array(z.strictObject({ key: Id, rect: Rect, configuration: SideConfiguration })).min(1).max(256) }),
    z.strictObject({ layout: z.literal("isometric"), diamond: Size, elevationStepPx: NonNegInt, pieces: z.array(IsoPieceGeometry).min(1).max(256) }),
  ]),
});
export type TilesetGuide = z.infer<typeof TilesetGuide>;
export type TilesetGeometry = TilesetGuide["geometry"];
