import { z } from "zod";
import { Capability } from "./capabilities";
import {
  AssetFamily,
  checkOrdinals,
  checkUnique,
  CostAmount,
  DurationMs,
  HexColor,
  Id,
  LanguageTag,
  NonNegInt,
  PosInt,
  ReferenceRole,
  Sha256Hex,
  Size,
  Slug,
} from "./common";
import { InpaintMaskConvention } from "./mask";
import { Direction, ProjectionKind, WorldToViewMap } from "./projection";
import { Playback } from "./sprites";
import { UiState } from "./ui";
import { Codepoint } from "./dialogue-audio";
import { TilesetGuide } from "./world";
import { OverlayCoverageParams } from "./equipment";
import { ROOM_MAX_COLS, ROOM_MAX_ROWS, ROOM_PROJECTIONS, SCENE_LAYER_DEPTHS } from "./scenes";
import { TEMPORAL_PLAN_PARAMS } from "./temporal";

/**
 * Plano de geração congelado (02a §entradas tipadas). Os nomes pertencem ao
 * domínio local; o adaptador traduz para o schema de cada provedor. Mudança de
 * entrada exige recalcular o plano (novo digest).
 */

export const PLAN_VERSION = 1 as const;

/** Papel de uma fonte congelada. Referências visuais + entradas estruturais. */
export const SourceRole = z.enum([...ReferenceRole.options, "base", "source", "edit_mask", "motion", "first_frame", "last_frame"]);
export type SourceRole = z.infer<typeof SourceRole>;

export const PlanSource = z.strictObject({
  ordinal: NonNegInt,
  revisionId: Id,
  /** `null` para revisões só de dados (ex.: movimento); o hash é o digest canônico do payload. */
  fileId: Id.nullable(),
  sha256: Sha256Hex,
  role: SourceRole,
});
export type PlanSource = z.infer<typeof PlanSource>;

/** Unidade de trabalho com chave estável (vista, trecho, estado, componente, take). */
export const PlanPart = z.strictObject({
  partKey: z.string().regex(/^[a-z_]+:[A-Za-z0-9._:-]+$/, "partKey deve ser unidade:valor, ex.: view:SE"),
  unit: z.enum(["image", "view", "segment", "state", "component", "take", "strip", "glyph_set", "tileset"]),
  label: z.string().min(1).max(120),
});
export type PlanPart = z.infer<typeof PlanPart>;

export const CostEstimate = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("known"), amount: CostAmount, basis: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal("range"), min: CostAmount, max: CostAmount, basis: z.string().min(1).max(500) }),
  /** Custo desconhecido permanece desconhecido; nunca estimativa zero inventada. */
  z.strictObject({ kind: z.literal("unknown"), reason: z.string().min(1).max(500) }),
]);
export type CostEstimate = z.infer<typeof CostEstimate>;

export const PlanLimits = z.strictObject({
  maxSubmissions: PosInt,
  costCeiling: CostAmount.nullable(),
  estimate: CostEstimate,
});

export const PlanPrompt = z.strictObject({
  /** Texto livre literal do artista. */
  brief: z.string().max(4000),
  /** Texto final compilado, inspecionável antes do envio. */
  compiled: z.string().max(8000),
  language: LanguageTag,
});

const FrameRef = z.strictObject({ clipRevisionId: Id, frameId: Id });

/**
 * Estratégia por imagem + referências numa rota genérica (03a: "se uma rota
 * genérica aceita guias raster e gera tiras, exibir essa estratégia e seus
 * limites separadamente"). Presente no plano = o modelo desenha uma folha de
 * quadros na grade declarada (ou uma vista isolada), fatiada e alinhada
 * localmente; NÃO é animação nativa, esqueleto estruturado nem rotação nativa.
 * Ausente = operação nativa do provedor.
 */
export const ReferenceSheet = z.strictObject({
  columns: z.number().int().min(1).max(8),
  rows: z.number().int().min(1).max(8),
  /** Célula lógica de cada quadro. */
  cell: Size,
  /** Rota sem alfa: fundo de cor-chave pedido no prompt e removido localmente. */
  backgroundKey: HexColor.nullable(),
  /** IDs dos quadros na ordem de leitura da grade (o fatiamento local os usa sem consultar o catálogo). */
  frameIds: z.array(Id).min(1).max(64),
});
export type ReferenceSheet = z.infer<typeof ReferenceSheet>;

// ---------------------------------------------------------------------------
// Parâmetros por operação
// ---------------------------------------------------------------------------

const ops = {
  generate_asset: z.strictObject({
    family: AssetFamily,
    kind: Slug,
    logicalSize: Size,
    transparent: z.boolean(),
    variants: z.number().int().min(1).max(8),
    /**
     * Rota sem alfa: o prompt pede este fundo de cor-chave fora da paleta e o
     * pós-processamento local o remove (03 §transparência).
     */
    backgroundKey: HexColor.nullable().optional(),
  }),
  animate_preset: z.strictObject({
    presetRevisionId: Id,
    baseRevisionId: Id,
    action: Slug,
    stance: Slug.nullable(),
    directions: z.array(Direction).min(1).max(8),
    mode: z.enum(["text", "skeleton"]),
    durationsMs: z.array(DurationMs).min(1).max(64),
    playback: Playback,
    /** Modo esqueleto do preset: movimento aprovado congelado nas fontes. */
    motionRevisionId: Id.nullable().optional(),
    sheet: ReferenceSheet.optional(),
  }),
  animate_text: z.strictObject({
    baseRevisionId: Id,
    actionText: z.string().min(1).max(1000),
    direction: Direction,
    durationsMs: z.array(DurationMs).min(1).max(64),
    playback: Playback,
    startFrame: FrameRef.nullable(),
    endFrame: FrameRef.nullable(),
    sheet: ReferenceSheet.optional(),
  }),
  animate_skeleton: z.strictObject({
    baseRevisionId: Id,
    /** Poses enviadas como dados estruturados, não só texto. */
    motionRevisionId: Id,
    actionText: z.string().min(1).max(1000),
    direction: Direction,
    playback: Playback,
    /** Rota genérica: as poses viram uma guia raster (papel `pose`), nunca anunciada como esqueleto. */
    sheet: ReferenceSheet.optional(),
  }),
  rotate_views: z.strictObject({
    identityRevisionId: Id,
    requestedViews: z.array(Direction).min(1).max(8),
    approvedViews: z.array(Direction).max(8),
    asymmetries: z.array(z.string().min(1).max(200)),
    projection: ProjectionKind,
    worldToView: WorldToViewMap.nullable(),
    /** Vista aprovada usada como fonte (a direção de origem da rotação). */
    sourceView: Direction.optional(),
    /** Rota genérica: a nova vista é desenhada por imagem + referência, não por rotação nativa. */
    sheet: ReferenceSheet.optional(),
  }),
  inpaint: z.strictObject({
    sourceRevisionId: Id,
    sourceFileId: Id,
    editMaskFileId: Id,
    maskConvention: InpaintMaskConvention,
    logicalSize: Size,
    /** `native-mask` exige máscara nativa; `candidate-composite` é escolha explícita. */
    mode: z.enum(["native-mask", "candidate-composite"]),
    instruction: z.string().min(1).max(1000),
  }),
  create_state: z.strictObject({
    identityAssetId: Id,
    baseRevisionId: Id,
    predecessorStateRevisionId: Id.nullable(),
    stateKey: Slug,
    description: z.string().min(1).max(1000),
    directions: z.array(Direction).min(1).max(8),
    // Cartão S3: sujeito, célula, estado já aprovado mantido e folha desenhada por imagem + referências.
    ...TEMPORAL_PLAN_PARAMS.create_state,
    sheet: ReferenceSheet,
  }),
  generate_scene: z.strictObject({
    logicalSize: Size,
    projection: ProjectionKind,
    /** Imagem plana não promete camadas nem mapa editável. */
    outputKind: z.enum(["flat_image", "layers"]),
    requiredElements: z.array(z.string().min(1).max(200)),
    /** T2: composição e iluminação pedidas (a perspectiva é `projection`; a resolução, `logicalSize`). */
    composition: z.string().max(500).optional(),
    lighting: z.string().max(200).optional(),
    /** T2 · `layers`: o plano gera UM plano declarado; cada plano é gerado separadamente. */
    layer: z
      .strictObject({ name: z.string().min(1).max(64), depth: z.enum(SCENE_LAYER_DEPTHS), repeatX: z.boolean(), transparent: z.boolean() })
      .optional(),
    /** Rota sem alfa: fundo de cor-chave pedido no prompt e removido localmente. */
    backgroundKey: HexColor.nullable().optional(),
  }),
  generate_room: z.strictObject({
    theme: z.string().min(1).max(500),
    floorPlan: z.strictObject({ size: Size, cells: z.array(z.boolean()).min(1) }),
    doors: z.array(z.strictObject({ doorId: Id, cell: z.tuple([NonNegInt, NonNegInt]), side: z.enum(["N", "E", "S", "W"]) })),
    projection: z.enum(ROOM_PROJECTIONS),
    tileSize: PosInt,
    styleRoomRevisionId: Id.nullable(),
    /**
     * T2: a planta vira guia raster (primeira referência) na grade declarada
     * da imagem; o modelo pinta por cima. Não é geração nativa de sala.
     */
    guide: z.strictObject({ pictureSize: Size, cellPx: Size, gridOrigin: z.tuple([z.number().int(), z.number().int()]), backgroundKey: HexColor }),
  }),
  /** T2: prop independente (árvore, baú, coluna); colisão e apoio são revisados depois, não vêm do prompt. */
  generate_map_object: z.strictObject({
    logicalSize: Size,
    projection: z.enum(["top_down", "three_quarter", "side"]),
    transparent: z.boolean(),
    backgroundKey: HexColor.nullable(),
    variants: z.number().int().min(1).max(4),
  }),
  generate_texture: z.strictObject({
    materialBrief: z.string().min(1).max(500),
    logicalSize: Size,
    repeatAxes: z.strictObject({ x: z.boolean(), y: z.boolean() }),
    /** Limiar declarado do material (emenda/interior); padrão do construtor quando ausente. */
    seamThreshold: z.number().positive().max(20).optional(),
  }),
  generate_tileset: z.discriminatedUnion("layout", [
    z.strictObject({
      layout: z.literal("corner"),
      projection: z.enum(["top_down", "three_quarter"]),
      cellSize: Size,
      terrainPair: z.tuple([Slug, Slug]),
      guide: TilesetGuide.optional(),
    }),
    z.strictObject({
      layout: z.literal("sidescroller"),
      cellSize: Size,
      platformMaterial: z.string().min(1).max(200),
      surfaceMaterial: z.string().min(1).max(200),
      requiredConfigurations: z.array(Slug).min(1),
      guide: TilesetGuide.optional(),
    }),
    z.strictObject({
      layout: z.literal("isometric"),
      diamond: Size,
      guide: TilesetGuide,
    }),
  ]),
  generate_ui_template: z.strictObject({
    logicalSize: Size,
    requestedComponents: z
      .array(
        z.strictObject({
          localId: Id,
          componentType: z.enum(["button", "panel", "slot", "meter", "menu_item"]),
          logicalSize: Size,
          requiredStates: z.array(UiState),
        }),
      )
      .min(1),
  }),
  generate_ui_states: z.strictObject({
    componentRevisionIds: z.array(Id).min(1),
    requiredStates: z.array(UiState).min(1),
  }),
  generate_vfx: z.strictObject({
    logicalSize: Size,
    durationsMs: z.array(DurationMs).min(1).max(64),
    loop: z.boolean(),
    alpha: z.enum(["binary", "partial"]),
  }),
  generate_portrait: z.strictObject({
    characterRevisionId: Id,
    logicalSize: Size,
  }),
  generate_visemes: z.strictObject({
    portraitRevisionId: Id,
    expressionKey: Slug,
    visemeCount: z.number().int().min(1).max(32),
  }),
  generate_pixel_font: z.strictObject({
    weight: z.enum(["light", "regular", "bold"]),
    glyphSize: PosInt,
    requiredCodepoints: z.array(Codepoint).min(1),
  }),
  generate_audio: z.strictObject({
    kind: z.enum(["music", "sfx"]),
    durationMs: PosInt,
    vocal: z.boolean().nullable(),
    lyrics: z.string().max(10_000).nullable(),
    loop: z.boolean(),
  }),
  /** Cartão S2: cobertura de roupa por frame ou vista rígida de uma peça ("Criar peça para este personagem"). */
  generate_overlay_coverage: OverlayCoverageParams,
  /** Cartão S3: animação de objeto (folha por imagem + referências), interpolação, edição de trecho, roupa e correção de quadro. */
  animate_object: z.strictObject({ ...TEMPORAL_PLAN_PARAMS.animate_object, sheet: ReferenceSheet }),
  interpolate_frames: z.strictObject({ ...TEMPORAL_PLAN_PARAMS.interpolate_frames, sheet: ReferenceSheet.optional() }),
  edit_animation: z.strictObject({ ...TEMPORAL_PLAN_PARAMS.edit_animation, sheet: ReferenceSheet.optional() }),
  transfer_outfit: z.strictObject({ ...TEMPORAL_PLAN_PARAMS.transfer_outfit, sheet: ReferenceSheet.optional() }),
  correct_frame: z.strictObject({ ...TEMPORAL_PLAN_PARAMS.correct_frame, sheet: ReferenceSheet.optional() }),
} as const;

export type PlanOperation = keyof typeof ops;
export const PLAN_OPERATIONS = Object.keys(ops) as PlanOperation[];

const envelope = {
  planVersion: z.literal(PLAN_VERSION),
  projectId: Id,
  styleRevisionId: Id,
  recipeRevisionId: Id,
  providerProfileId: Id,
  prompt: PlanPrompt,
  /** Ordem significativa: a primeira é a base quando a operação depende dela. */
  sources: z.array(PlanSource).max(16),
  requiredCapabilities: z.array(Capability).min(1),
  parts: z.array(PlanPart).min(1),
  limits: PlanLimits,
};

function plan<O extends PlanOperation>(operation: O) {
  return z.strictObject({ ...envelope, operation: z.literal(operation), params: ops[operation] });
}

export const GenerationPlan = z
  .discriminatedUnion("operation", [
    plan("generate_asset"),
    plan("animate_preset"),
    plan("animate_text"),
    plan("animate_skeleton"),
    plan("rotate_views"),
    plan("inpaint"),
    plan("create_state"),
    plan("generate_scene"),
    plan("generate_room"),
    plan("generate_texture"),
    plan("generate_tileset"),
    plan("generate_ui_template"),
    plan("generate_ui_states"),
    plan("generate_vfx"),
    plan("generate_portrait"),
    plan("generate_visemes"),
    plan("generate_pixel_font"),
    plan("generate_audio"),
    plan("generate_overlay_coverage"),
    plan("generate_map_object"),
    plan("animate_object"),
    plan("interpolate_frames"),
    plan("edit_animation"),
    plan("transfer_outfit"),
    plan("correct_frame"),
  ])
  .superRefine((p, ctx) => {
    checkOrdinals(ctx, p.sources, ["sources"]);
    checkUnique(ctx, p.sources, (s) => `${s.revisionId}/${s.fileId}`, "Fonte", ["sources"]);
    checkUnique(ctx, p.parts, (part) => part.partKey, "Parte", ["parts"]);
    checkUnique(ctx, p.requiredCapabilities, (c) => c, "Capacidade", ["requiredCapabilities"]);
    const requires = (cap: Capability) => {
      if (!p.requiredCapabilities.includes(cap)) {
        ctx.addIssue({ code: "custom", message: `Operação ${p.operation} exige a capacidade ${cap}`, path: ["requiredCapabilities"] });
      }
    };
    if (p.limits.estimate.kind !== "unknown" && p.limits.costCeiling) {
      const est = p.limits.estimate.kind === "known" ? p.limits.estimate.amount : p.limits.estimate.max;
      if (est.unit === p.limits.costCeiling.unit && est.amount > p.limits.costCeiling.amount) {
        ctx.addIssue({ code: "custom", message: "Estimativa excede o teto autorizado", path: ["limits"] });
      }
    }
    switch (p.operation) {
      case "inpaint": {
        if (p.params.mode === "native-mask") requires("native_mask");
        else requires("image_edit");
        const mask = p.sources.find((s) => s.role === "edit_mask");
        const source = p.sources[0];
        if (!source || source.role !== "source" || source.revisionId !== p.params.sourceRevisionId || source.fileId !== p.params.sourceFileId) {
          ctx.addIssue({ code: "custom", message: "Inpainting exige a fonte como primeira entrada", path: ["sources", 0] });
        }
        if (!mask || mask.fileId !== p.params.editMaskFileId) {
          ctx.addIssue({ code: "custom", message: "Inpainting exige a máscara de edição congelada nas fontes", path: ["sources"] });
        }
        break;
      }
      case "animate_skeleton":
        // Rota genérica recebe guia raster (referência visual), não keypoints: a capacidade exigida é outra.
        requires(p.params.sheet ? "image_references" : "skeleton_keypoints");
        if (!p.sources.some((s) => s.role === "motion" && s.revisionId === p.params.motionRevisionId)) {
          ctx.addIssue({ code: "custom", message: "Revisão de movimento deve estar congelada nas fontes", path: ["sources"] });
        }
        break;
      case "animate_text":
        requires(p.params.sheet ? "image_references" : "text_animation");
        checkSheetCells(ctx, p.params.sheet, p.params.durationsMs.length);
        break;
      case "animate_preset":
        requires(p.params.sheet ? "image_references" : p.params.mode === "skeleton" ? "skeleton_keypoints" : "text_animation");
        checkSheetCells(ctx, p.params.sheet, p.params.durationsMs.length);
        if (p.params.mode === "skeleton" && !p.sources.some((s) => s.role === "motion" && s.revisionId === p.params.motionRevisionId)) {
          ctx.addIssue({ code: "custom", message: "Preset em modo esqueleto exige a revisão de movimento congelada nas fontes", path: ["sources"] });
        }
        break;
      case "rotate_views": {
        const overlap = p.params.requestedViews.filter((d) => p.params.approvedViews.includes(d));
        if (overlap.length > 0) {
          ctx.addIssue({ code: "custom", message: `Vistas já aprovadas não são regeradas: ${overlap.join(", ")}`, path: ["params", "requestedViews"] });
        }
        if (p.params.projection === "isometric") {
          requires("isometric_views");
          if (!p.params.worldToView) {
            ctx.addIssue({ code: "custom", message: "Isométrico exige mapa mundo → vista", path: ["params", "worldToView"] });
          }
        }
        break;
      }
      // Cartão S3: rota nativa exige a capacidade própria; a folha por imagem + referências exige `image_references`.
      // Estado e animação de objeto só existem como folha desenhada por imagem + referências.
      case "create_state":
        requires("image_references");
        checkSheetCells(ctx, p.params.sheet, p.params.directions.length);
        break;
      case "animate_object":
        requires("image_references");
        checkSheetCells(ctx, p.params.sheet, p.params.durationsMs.length);
        if (p.params.endFrame && p.params.endFrame.direction !== p.params.direction) {
          ctx.addIssue({ code: "custom", message: "O quadro final da interpolação usa a mesma direção", path: ["params", "endFrame"] });
        }
        break;
      case "interpolate_frames":
        requires(p.params.sheet ? "image_references" : "frame_interpolation");
        if (p.params.sheet && p.params.count === null) ctx.addIssue({ code: "custom", message: "Rota genérica declara a contagem de intermediários", path: ["params", "count"] });
        if (p.params.sheet) checkSheetCells(ctx, p.params.sheet, p.params.count ?? 0);
        break;
      case "edit_animation":
      case "transfer_outfit":
        requires(p.params.sheet ? "image_references" : p.operation === "edit_animation" ? "animation_edit" : "outfit_transfer");
        checkSheetCells(ctx, p.params.sheet, p.params.frameIds.length);
        if (p.params.frames.map((f) => f.frameId).join("|") !== p.params.frameIds.join("|")) {
          ctx.addIssue({ code: "custom", message: "Composição congelada diverge dos quadros selecionados", path: ["params", "frames"] });
        }
        break;
      case "correct_frame":
        requires(p.params.mode === "native-mask" ? "native_mask" : "image_edit");
        if (p.params.frames[0]?.frameId !== p.params.frameId) ctx.addIssue({ code: "custom", message: "O quadro alvo vem primeiro na composição", path: ["params", "frames"] });
        if (p.params.editMaskFileId && !p.sources.some((s) => s.role === "edit_mask" && s.fileId === p.params.editMaskFileId)) {
          ctx.addIssue({ code: "custom", message: "A máscara de edição deve estar congelada nas fontes", path: ["sources"] });
        }
        break;
      case "generate_overlay_coverage": {
        // Cartão S2: a cobertura parte de frames aprovados da base (congelados nas fontes); a vista rígida, de texto.
        if (p.params.mode === "coverage") {
          requires("image_references");
          const frozen = new Set(p.sources.map((s) => s.revisionId));
          p.params.strips.forEach((strip, i) => {
            if (!frozen.has(strip.clipRevisionId)) ctx.addIssue({ code: "custom", message: `Clipe ${strip.clipRevisionId} da tira deve estar congelado nas fontes`, path: ["params", "strips", i] });
            if (strip.frames.length > strip.columns * strip.rows) ctx.addIssue({ code: "custom", message: `Tira ${strip.stripKey} não comporta ${strip.frames.length} frames`, path: ["params", "strips", i] });
          });
        } else {
          requires("text_to_image");
        }
        break;
      }
      case "generate_room": {
        const [cols, rows] = p.params.floorPlan.size;
        if (p.params.floorPlan.cells.length !== cols * rows) {
          ctx.addIssue({ code: "custom", message: `Planta deve ter ${cols * rows} células`, path: ["params", "floorPlan", "cells"] });
        }
        // T2: a planta vai como guia raster (referência visual) na grade declarada.
        requires("image_references");
        if (cols > ROOM_MAX_COLS || rows > ROOM_MAX_ROWS) {
          ctx.addIssue({ code: "custom", message: `Planta limitada a ${ROOM_MAX_COLS} × ${ROOM_MAX_ROWS} células`, path: ["params", "floorPlan", "size"] });
        }
        break;
      }
      case "generate_scene":
        if ((p.params.outputKind === "layers") !== Boolean(p.params.layer)) {
          ctx.addIssue({ code: "custom", message: "Cena em camadas gera um plano declarado por vez (e só ela declara plano)", path: ["params", "layer"] });
        }
        break;
      case "generate_map_object":
        requires("text_to_image");
        break;
      default:
        break;
    }
  });
export type GenerationPlan = z.infer<typeof GenerationPlan>;

/** A grade declarada da folha comporta todos os quadros pedidos (células sobrando ficam vazias e declaradas). */
function checkSheetCells(ctx: z.RefinementCtx, sheet: ReferenceSheet | undefined, frames: number) {
  if (sheet && sheet.columns * sheet.rows < frames) {
    ctx.addIssue({ code: "custom", message: `Folha ${sheet.columns}×${sheet.rows} não comporta ${frames} quadros`, path: ["params", "sheet"] });
  }
  if (sheet && sheet.frameIds.length !== frames) {
    ctx.addIssue({ code: "custom", message: `A folha declara ${sheet.frameIds.length} quadros; o plano pede ${frames}`, path: ["params", "sheet", "frameIds"] });
  }
  if (sheet && new Set(sheet.frameIds).size !== sheet.frameIds.length) {
    ctx.addIssue({ code: "custom", message: "IDs de quadro repetidos na folha", path: ["params", "sheet", "frameIds"] });
  }
}
