import { z } from "zod";
import { checkUnique, GridPoint, HexColor, Id, Int, NonNegInt, Offset, PosInt, Rect, Size, Slug } from "./common";
import { ProjectionKind } from "./projection";

/**
 * Cenas ilustradas, planos de paralaxe e salas (cartão T2 · 06 §cenas, salas e
 * texturas como saídas próprias). Uma imagem de cenário não contém mapa,
 * colisão nem objetos editáveis: cada saída tem contrato próprio. Móveis
 * extraídos de uma sala são `map/object` (props reutilizáveis do T1).
 */

const Img = z.strictObject({ fileId: Id, rect: Rect });
const Axes = z.strictObject({ x: z.boolean(), y: z.boolean() });

// ---------------------------------------------------------------------------
// Plano de paralaxe (map/scene_layer)
// ---------------------------------------------------------------------------

export const SCENE_LAYER_ORIGINS = ["generated_separately", "imported", "derived_local_reviewed"] as const;
export const SCENE_LAYER_DEPTHS = ["sky", "far", "mid", "near", "ground"] as const;

/** Emenda da repetição medida localmente (bordas opostas × vizinhos internos). */
export const LayerContinuity = z.strictObject({
  method: Slug,
  threshold: z.number().positive().max(20),
  seamDelta: z.number().nonnegative(),
  interiorDelta: z.number().nonnegative(),
  passed: z.boolean(),
});

/**
 * Um plano é um arquivo próprio e diz como foi obtido. Derivar planos de uma
 * imagem plana é derivação local revisada (com máscara e tratamento das áreas
 * antes ocultas), nunca decomposição nativa.
 */
export const SceneLayerPayload = z
  .strictObject({
    fileId: Id,
    rect: Rect,
    logicalSize: Size,
    depth: z.enum(SCENE_LAYER_DEPTHS),
    obtained: z.enum(SCENE_LAYER_ORIGINS),
    /** Eixos pedidos; só viram repetíveis com a continuidade aprovada. */
    requestedRepeat: Axes,
    repeat: Axes,
    continuity: z.strictObject({ x: LayerContinuity.nullable(), y: LayerContinuity.nullable() }),
    /** Linha do chão (px do plano) quando o plano tem superfície caminhável (lateral). */
    groundLineY: NonNegInt.nullable(),
    derivation: z
      .strictObject({
        /** Imagem plana de origem (proveniência). */
        sourceRevisionId: Id,
        /** Máscara revisada usada na separação (255 = pertence ao plano), na grade da imagem plana. */
        mask: Img,
        /** O que ficou atrás do plano retirado: reconstruído por inpainting (E1) ou transparente revisado. */
        hiddenAreas: z.enum(["reconstructed_inpaint", "transparent_reviewed"]),
        inpaintRevisionId: Id.nullable(),
      })
      .nullable(),
  })
  .superRefine((l, ctx) => {
    const [w, h] = l.logicalSize;
    if (l.rect[2] !== w || l.rect[3] !== h) ctx.addIssue({ code: "custom", message: "Região do plano deve ter o tamanho lógico", path: ["rect"] });
    for (const axis of ["x", "y"] as const) {
      if (l.repeat[axis] && !l.requestedRepeat[axis]) ctx.addIssue({ code: "custom", message: `Repetição em ${axis} não foi pedida`, path: ["repeat", axis] });
      if (l.repeat[axis] && !l.continuity[axis]?.passed) {
        ctx.addIssue({ code: "custom", message: `Plano repetível em ${axis} sem continuidade aprovada`, path: ["continuity", axis] });
      }
    }
    if ((l.obtained === "derived_local_reviewed") !== (l.derivation !== null)) {
      ctx.addIssue({ code: "custom", message: "Derivação local exige origem, máscara e tratamento das áreas ocultas (e só ela os tem)", path: ["derivation"] });
    }
    if (l.derivation && (l.derivation.hiddenAreas === "reconstructed_inpaint") !== (l.derivation.inpaintRevisionId !== null)) {
      ctx.addIssue({ code: "custom", message: "Área reconstruída cita a revisão de inpainting (e só ela)", path: ["derivation", "inpaintRevisionId"] });
    }
    if (l.groundLineY !== null && l.groundLineY >= h) ctx.addIssue({ code: "custom", message: "Linha do chão fora do plano", path: ["groundLineY"] });
  });
export type SceneLayerPayload = z.infer<typeof SceneLayerPayload>;

// ---------------------------------------------------------------------------
// Cena ilustrada (map/scene)
// ---------------------------------------------------------------------------

export const SceneLayerPlacement = z.strictObject({
  layerId: Slug,
  name: z.string().min(1).max(64),
  /** Revisão do plano (dependência runtime). */
  layerRevisionId: Id,
  /** Posição do plano com a câmera na origem, em px da cena. */
  offset: Offset,
  /** Deslocamento do plano na tela = offset − câmera × fator. 0 = preso à tela, 1 = acompanha o mundo. */
  parallax: z.strictObject({ x: z.number().min(0).max(4), y: z.number().min(0).max(4) }),
  /** Repetição usada na cena: só eixos aprovados no plano. */
  repeat: Axes,
});
export type SceneLayerPlacement = z.infer<typeof SceneLayerPlacement>;

export const ScenePayload = z
  .strictObject({
    /** `flat_image`: imagem plana, sem planos; `layers`: planos declarados, cada um com seu arquivo. */
    outputKind: z.enum(["flat_image", "layers"]),
    projection: ProjectionKind,
    logicalSize: Size,
    /** PNG completo: a imagem plana ou a composição dos planos com a câmera na origem. */
    image: Img,
    /** Trás → frente. */
    layers: z.array(SceneLayerPlacement).max(16),
    /** Pontos de apoio anotados (px da cena): onde um personagem pousa. Não são colisão. */
    supportPoints: z.array(z.strictObject({ pointId: Slug, label: z.string().min(1).max(64), at: GridPoint })).max(64),
    /** Escala revisada com o personagem sobreposto: altura do personagem em px da cena. */
    characterScale: z.strictObject({ characterRevisionId: Id, heightPx: PosInt }).nullable(),
    /** Lateral: linha do chão em px da cena (câmera na origem). */
    groundLineY: NonNegInt.nullable(),
    /** Uma cena ilustrada não é mapa: sem grade, colisões nem objetos editáveis. */
    editable: z.strictObject({ map: z.literal(false), collisions: z.literal(false), objects: z.literal(false) }),
    /** Câmera deslocada por duas larguras do fundo: loop horizontal e continuidade do chão. */
    cameraTest: z
      .strictObject({
        spanPx: PosInt,
        steps: PosInt,
        uncoveredFrames: NonNegInt,
        loopPassed: z.boolean(),
        groundContinuous: z.boolean().nullable(),
      })
      .nullable(),
  })
  .superRefine((s, ctx) => {
    const [w, h] = s.logicalSize;
    if (s.image.rect[2] !== w || s.image.rect[3] !== h) ctx.addIssue({ code: "custom", message: "PNG completo deve ter o tamanho lógico da cena", path: ["image", "rect"] });
    if (s.outputKind === "flat_image") {
      if (s.layers.length > 0) ctx.addIssue({ code: "custom", message: "Imagem plana não declara planos (não há decomposição nativa)", path: ["layers"] });
      if (s.cameraTest !== null) ctx.addIssue({ code: "custom", message: "Imagem plana não tem teste de paralaxe", path: ["cameraTest"] });
    } else {
      if (s.layers.length < 2) ctx.addIssue({ code: "custom", message: "Cena em camadas declara ao menos dois planos", path: ["layers"] });
      if (s.cameraTest === null) ctx.addIssue({ code: "custom", message: "Cena em camadas exige o teste da câmera", path: ["cameraTest"] });
    }
    checkUnique(ctx, s.layers, (l) => l.layerId, "Plano", ["layers"]);
    checkUnique(ctx, s.supportPoints, (p) => p.pointId, "Ponto de apoio", ["supportPoints"]);
    s.supportPoints.forEach((p, i) => {
      if (p.at[0] > w || p.at[1] > h) ctx.addIssue({ code: "custom", message: "Ponto de apoio fora da cena", path: ["supportPoints", i, "at"] });
    });
    if (s.groundLineY !== null && s.groundLineY >= h) ctx.addIssue({ code: "custom", message: "Linha do chão fora da cena", path: ["groundLineY"] });
  });
export type ScenePayload = z.infer<typeof ScenePayload>;

// ---------------------------------------------------------------------------
// Sala (map/room)
// ---------------------------------------------------------------------------

/** Planta da sala: até 7 colunas × 6 linhas (a guia raster e as regras de portas assumem esse limite). */
export const ROOM_MAX_COLS = 7;
export const ROOM_MAX_ROWS = 6;
export const ROOM_TILE_SIZES = [16, 24, 32, 48, 64] as const;
export const ROOM_PROJECTIONS = ["top_down", "isometric", "oblique"] as const;
export type RoomProjection = (typeof ROOM_PROJECTIONS)[number];

const CellCoord = z.tuple([NonNegInt, NonNegInt]);
const Side = z.enum(["N", "E", "S", "W"]);

export const RoomFloorPlan = z.strictObject({
  /** `[colunas, linhas]`, no máximo 7 × 6. */
  size: z.tuple([PosInt, PosInt]),
  /** Piso (true) ou rocha (false), linha a linha. */
  cells: z.array(z.boolean()).min(1).max(ROOM_MAX_COLS * ROOM_MAX_ROWS),
});
export type RoomFloorPlan = z.infer<typeof RoomFloorPlan>;

export const RoomDoor = z.strictObject({
  doorId: Id,
  /** Célula do piso junto à parede (E/W: a de cima da passagem de duas células). */
  cell: CellCoord,
  side: Side,
  /** Geometria de junção em px da imagem (derivada da grade ou revisada). */
  anchorPx: z.tuple([Int, Int]).nullable(),
  triggerPx: Rect.nullable(),
  arrivePx: z.tuple([Int, Int]).nullable(),
});
export type RoomDoor = z.infer<typeof RoomDoor>;

export const RoomFurniture = z.strictObject({
  placementId: Id,
  /** Prop reutilizável (`map/object`, dependência runtime). */
  objectRevisionId: Id,
  /** Onde o ponto de apoio do móvel pousa, em px da imagem da sala. */
  supportAtPx: z.tuple([Int, Int]),
  label: z.string().min(1).max(64).optional(),
});
export type RoomFurniture = z.infer<typeof RoomFurniture>;

/**
 * Área de onde uma peça saiu. O que ficava atrás nunca foi pintado: se o
 * contorno é piso/parede, a área é reconstruída por inpainting (E1); só área
 * sobre rocha transparente pode ficar apenas sem alfa. Apagar o alfa não é
 * reconstrução.
 */
export const RoomExposedArea = z
  .strictObject({
    areaId: Id,
    pieceName: z.string().min(1).max(64),
    rect: Rect,
    /** Máscara da área (255 = antes coberta pela peça/sombra), na grade da imagem da sala. */
    mask: Img,
    measured: z.strictObject({ pixels: PosInt, contextOpaque: z.number().min(0).max(1) }),
    status: z.enum(["reconstructed_inpaint", "transparent_reviewed"]),
    inpaintRevisionId: Id.nullable(),
  })
  .superRefine((a, ctx) => {
    if ((a.status === "reconstructed_inpaint") !== (a.inpaintRevisionId !== null)) {
      ctx.addIssue({ code: "custom", message: "Reconstrução por inpainting cita a revisão do inpainting (e só ela)", path: ["inpaintRevisionId"] });
    }
  });
export type RoomExposedArea = z.infer<typeof RoomExposedArea>;

/**
 * Chaves de versões anteriores da sala que só existiam com valor `null` nas
 * rotas genéricas (ID externo e kit recebido). Removidas na leitura para que
 * revisões já gravadas continuem válidas; com valor, a revisão é recusada.
 */
const LEGACY_NULL_ROOM_KEYS = ["external", "kit"] as const;

function dropLegacyRoomKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!LEGACY_NULL_ROOM_KEYS.some((k) => k in record && record[k] === null)) return value;
  const copy = { ...record };
  for (const k of LEGACY_NULL_ROOM_KEYS) if (copy[k] === null) delete copy[k];
  return copy;
}

const RoomPayloadObject = z
  .strictObject({
    projection: z.enum(ROOM_PROJECTIONS),
    theme: z.string().min(1).max(500),
    floorPlan: RoomFloorPlan,
    doors: z.array(RoomDoor).min(1).max(8),
    /** `tile_size` declarado: escala do desenho (isométrica/oblíqua); na top-down a imagem usa células de 32 px. */
    tileSize: z.number().int().refine((v) => (ROOM_TILE_SIZES as readonly number[]).includes(v), { message: "tileSize deve ser 16, 24, 32, 48 ou 64" }),
    /** Grade na imagem: top-down 32×32; isométrica losango [T, T/2]; oblíqua [T, T]. */
    cellPx: Size,
    /** Canto superior esquerdo (top-down/oblíqua) ou vértice superior (isométrica) da célula (0,0), em px. */
    gridOrigin: z.tuple([Int, Int]),
    /** A sala como pintada/aprovada (PNG completo, rocha transparente). */
    picture: Img,
    /** Piso/paredes sem os móveis extraídos; desenhar os móveis por cima. `null` = sala pintada inteira. */
    background: Img.nullable(),
    /** Desenhado por cima dos móveis (isométrica: muretas da frente). */
    overlay: Img.nullable(),
    /** Piso caminhável em px da imagem (móveis pintados bloqueiam à parte). */
    walkable: z.array(Rect).max(64),
    route: z.enum(["generic_image_references", "imported"]),
    /** Sala aprovada de mesma vista usada como estilo (proveniência). */
    styleRoomRevisionId: Id.nullable(),
    /** Revisão da sala de que esta deriva (proveniência). */
    sourceRoomRevisionId: Id.nullable(),
    /** Porta desta sala ligada à porta de outra sala (dependência runtime da sala vizinha). */
    connections: z.array(z.strictObject({ doorId: Id, toRoomRevisionId: Id, toDoorId: Id })).max(8),
    furniture: z.array(RoomFurniture).max(64),
    exposedAreas: z.array(RoomExposedArea).max(64),
  })
  .superRefine((r, ctx) => {
    const [cols, rows] = r.floorPlan.size;
    if (cols > ROOM_MAX_COLS || rows > ROOM_MAX_ROWS) {
      ctx.addIssue({ code: "custom", message: `Planta limitada a ${ROOM_MAX_COLS} × ${ROOM_MAX_ROWS} células`, path: ["floorPlan", "size"] });
      return;
    }
    if (r.floorPlan.cells.length !== cols * rows) ctx.addIssue({ code: "custom", message: `Planta deve ter ${cols * rows} células`, path: ["floorPlan", "cells"] });
    if (!r.floorPlan.cells.some(Boolean)) ctx.addIssue({ code: "custom", message: "Planta sem piso", path: ["floorPlan", "cells"] });
    checkUnique(ctx, r.doors, (d) => d.doorId, "Porta", ["doors"]);
    r.doors.forEach((d, i) => {
      const [c, row] = d.cell;
      if (c >= cols || row >= rows || !r.floorPlan.cells[row * cols + c]) {
        ctx.addIssue({ code: "custom", message: "Porta precisa estar numa célula de piso", path: ["doors", i, "cell"] });
      }
    });
    if (r.projection === "oblique") {
      // Sala oblíqua: só paredes, portas e piso.
      if (r.furniture.length > 0 || r.exposedAreas.length > 0) ctx.addIssue({ code: "custom", message: "Sala oblíqua não tem móveis a extrair nem a colocar", path: ["furniture"] });
    }
    const doorIds = new Set(r.doors.map((d) => d.doorId));
    checkUnique(ctx, r.connections, (c) => c.doorId, "Ligação de porta", ["connections"]);
    r.connections.forEach((c, i) => {
      if (!doorIds.has(c.doorId)) ctx.addIssue({ code: "custom", message: `Ligação cita porta inexistente: ${c.doorId}`, path: ["connections", i, "doorId"] });
    });
    checkUnique(ctx, r.furniture, (f) => f.placementId, "Móvel", ["furniture"]);
    checkUnique(ctx, r.exposedAreas, (a) => a.areaId, "Área exposta", ["exposedAreas"]);
    if (r.exposedAreas.length > 0 && r.background === null) {
      ctx.addIssue({ code: "custom", message: "Área exposta exige o fundo reconstruído (background)", path: ["background"] });
    }
  });

export const RoomPayload = z.preprocess(dropLegacyRoomKeys, RoomPayloadObject);
export type RoomPayload = z.infer<typeof RoomPayload>;

// ---------------------------------------------------------------------------
// Receitas do processador Python para cenas e salas (`scenes.py`)
// ---------------------------------------------------------------------------

const LayerPlacementRecipe = z.strictObject({
  inputOrdinal: NonNegInt,
  offset: Offset,
  parallax: z.strictObject({ x: z.number().min(0).max(4), y: z.number().min(0).max(4) }),
  repeat: Axes,
});

export const SCENE_PYTHON_RECIPES = {
  /**
   * Cena/plano/sala → tamanho lógico sem faixas: recorte central na proporção
   * do alvo (quando o provedor devolve outra) e redução por fator inteiro ou
   * cor majoritária do bloco. Alfa opcionalmente binarizado (pixel art).
   */
  scene_fit: z.strictObject({
    version: z.literal(1),
    targetSize: Size,
    alphaThreshold: z.number().int().min(1).max(255).nullable(),
  }),
  /** Continuidade da repetição de um plano (bordas opostas × interior), mosaico 3× e linha do chão. */
  scene_layer_check: z.strictObject({
    version: z.literal(1),
    axes: Axes,
    threshold: z.number().positive().max(20),
    groundLineY: NonNegInt.nullable(),
    zoom: PosInt.max(16),
  }),
  /**
   * Composição dos planos (entradas `layer`) com a câmera: imagem na origem,
   * tira de quadros ao longo de `spanPx`, buracos e continuidade do chão.
   */
  scene_compose: z.strictObject({
    version: z.literal(1),
    canvas: Size,
    layers: z.array(LayerPlacementRecipe).min(1).max(16),
    spanPx: NonNegInt,
    steps: PosInt.max(64),
    groundLineY: NonNegInt.nullable(),
    zoom: PosInt.max(8),
  }),
  /** Personagem (`layer` 1) sobreposto à cena (`source`) em escala, pousado nos pontos de apoio. */
  scene_overlay: z.strictObject({
    version: z.literal(1),
    points: z.array(GridPoint).min(1).max(16),
    /** Vista do personagem: recorte no arquivo, posição na célula lógica e apoio no chão (pivô) na célula. */
    character: z.strictObject({ logicalSize: Size, rect: Rect, offset: Offset, pivot: GridPoint }),
    zoom: PosInt.max(8),
  }),
  /** Guia raster da planta (rota genérica): piso, paredes, rocha (cor-chave) e portas na grade da imagem. */
  room_guide: z.strictObject({
    version: z.literal(1),
    projection: z.enum(ROOM_PROJECTIONS),
    pictureSize: Size,
    cellPx: Size,
    gridOrigin: z.tuple([Int, Int]),
    size: z.tuple([PosInt, PosInt]),
    cells: z.array(z.boolean()).min(1).max(ROOM_MAX_COLS * ROOM_MAX_ROWS),
    doors: z.array(z.strictObject({ cell: CellCoord, side: Side })).max(8),
    colors: z.strictObject({ floor: HexColor, wall: HexColor, rock: HexColor, door: HexColor }),
  }),
  /**
   * Recorte local revisado de um móvel: máscara explícita (`editMask`) e
   * sombra opcional (`removeMask`) → peça, sombra, máscara da área exposta,
   * fundo sem a peça (só para área sobre rocha) e medidas do contorno.
   */
  room_cutout: z.strictObject({
    version: z.literal(1),
    dilatePx: z.number().int().min(0).max(8),
    contextRingPx: z.number().int().min(1).max(8),
    alphaThreshold: z.number().int().min(1).max(255),
  }),
  /** Sala montada: fundo (`source`), sombras e móveis (`layer`) ordenados pelo apoio, com recorte nas bordas. */
  room_compose: z.strictObject({
    version: z.literal(1),
    canvas: Size,
    items: z.array(z.strictObject({ inputOrdinal: NonNegInt, at: z.tuple([Int, Int]) })).max(256),
    zoom: PosInt.max(8),
  }),
} as const;
