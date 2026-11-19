import { LocalizedText } from "@/i18n/locales";
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
  Insets,
  LanguageTag,
  NonNegInt,
  PosInt,
  Rect,
  ReferenceRole,
  Sha256Hex,
  Size,
  Slug,
} from "./common";
import { InpaintMaskConvention } from "./mask";
import { Direction, ProjectionKind, WorldToViewMap } from "./projection";
import { Playback } from "./sprites";
import { MeterPart, UiState } from "./ui";
import { Codepoint } from "./dialogue-audio";
import { TilesetGuide } from "./world";
import { OverlayCoverageParams } from "./equipment";
import { ROOM_MAX_COLS, ROOM_MAX_ROWS, ROOM_PROJECTIONS, SCENE_LAYER_DEPTHS } from "./scenes";
import { ITEM_KINDS } from "./manifest";
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

const AssetReferenceSource = z.union([
  PlanSource.extend({ fileId: Id, role: ReferenceRole }),
  z.strictObject({ ordinal: NonNegInt, uploadId: Id, sha256: Sha256Hex, role: ReferenceRole }),
]);

/** Unidade de trabalho com chave estável (vista, trecho, estado, componente, take). */
export const PlanPart = z.strictObject({
  partKey: z.string().regex(/^[a-z_]+:[A-Za-z0-9._:-]+$/, "partKey deve ser unidade:valor, ex.: view:SE"),
  unit: z.enum(["image", "view", "segment", "state", "component", "take", "strip", "glyph_set", "tileset"]),
  label: z.string().min(1).max(120),
});
export type PlanPart = z.infer<typeof PlanPart>;

/** Texto da estimativa: string (planos antigos, um idioma) ou bilíngue `{en, "pt-BR"}`; a interface escolhe o idioma. */
const EstimateText = z.union([z.string().min(1).max(500), LocalizedText]);

export const CostEstimate = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("known"), amount: CostAmount, basis: EstimateText }),
  z.strictObject({ kind: z.literal("range"), min: CostAmount, max: CostAmount, basis: EstimateText }),
  /** Custo desconhecido permanece desconhecido; nunca estimativa zero inventada. */
  z.strictObject({ kind: z.literal("unknown"), reason: EstimateText }),
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

/**
 * Cartão U3 · folha de estados de UM componente na rota genérica: grade de
 * células do mesmo tamanho lógico com espaçamento inteiro; a célula 0 mostra o
 * estado-base aprovado e as seguintes recebem `states` na ordem.
 */
export const UiStateSheet = z.strictObject({
  componentRevisionId: Id,
  baseState: UiState,
  cell: Size,
  columns: z.number().int().min(1).max(8),
  rows: z.number().int().min(1).max(8),
  gapPx: NonNegInt.max(64),
  states: z.array(UiState).min(1).max(7),
  sheetSize: Size,
  /** Área da legenda/miolo do componente, conferida em cada estado. */
  contentPadding: Insets.nullable().optional(),
});
export type UiStateSheet = z.infer<typeof UiStateSheet>;

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
          /** Cartão U3: componente a que a peça pertence (as três partes da barra compartilham), célula no template e parte da barra. */
          componentId: Id.optional(),
          cell: Rect.optional(),
          meterPart: MeterPart.optional(),
        }),
      )
      .min(1),
    /**
     * Cartão U3 · rota genérica: o layout vira guia raster (primeira
     * referência) em fundo de cor-chave; o modelo pinta as peças nas células e
     * a separação é local. Ausente = operação nativa de template.
     */
    guide: z.strictObject({ backgroundKey: HexColor }).optional(),
  }),
  generate_ui_states: z.strictObject({
    componentRevisionIds: z.array(Id).min(1),
    requiredStates: z.array(UiState).min(1),
    /** Cartão U3: cada estado descrito por nome e descrição. */
    stateDescriptions: z.array(z.strictObject({ state: UiState, description: z.string().min(1).max(300) })).optional(),
    /**
     * Cartão U3 · rota genérica: uma folha por componente (célula 1 = estado-base
     * aprovado como referência; demais = estados pedidos, mesma célula), com
     * fundo de cor-chave. NÃO é geração nativa de estados. Ausente = nativa.
     */
    sheets: z.array(UiStateSheet).min(1).max(8).optional(),
    backgroundKey: HexColor.optional(),
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
    /**
     * Cartão D1 · `image_references` = rota genérica: o retrato é desenhado por
     * imagem + referência da vista aprovada do personagem e conferido
     * localmente. Ausente = operação nativa de retrato (capacidade `portrait`).
     */
    route: z.literal("image_references").optional(),
    framing: z.enum(["bust", "head"]).optional(),
    transparent: z.boolean().optional(),
    /** Rota sem alfa: fundo de cor-chave pedido no prompt e removido localmente. */
    backgroundKey: HexColor.nullable().optional(),
  }),
  generate_visemes: z.strictObject({
    portraitRevisionId: Id,
    expressionKey: Slug,
    visemeCount: z.number().int().min(1).max(32),
    /** D1: IDs dos visemes na ordem da grade; mesma quantidade e ordem em toda expressão. */
    visemeIds: z.array(Slug).min(1).max(32).optional(),
    visemeSet: Slug.optional(),
    /** Descrição da expressão (ex.: "sorriso largo, olhos semicerrados"). */
    expressionBrief: z.string().max(500).optional(),
    /** Regiões do retrato aprovado: o rosto pode mudar com a expressão; só a boca muda entre visemes. */
    faceRect: Rect.optional(),
    mouthRect: Rect.optional(),
    /** Rota genérica: folha desenhada por imagem + referência do retrato aprovado na grade declarada (não é viseme nativo). */
    sheet: ReferenceSheet.optional(),
  }),
  generate_pixel_font: z.strictObject({
    weight: z.enum(["light", "regular", "bold"]),
    glyphSize: PosInt,
    requiredCodepoints: z.array(Codepoint).min(1),
    /**
     * D1 · rota genérica: cada parte é uma página de glyphs desenhada na grade
     * do gabarito (imagem + referências) e montada localmente em atlas bitmap
     * com métricas medidas. `extend` desenha só os glyphs ausentes com
     * referência dos glyphs-base aprovados. Ausente = fonte pixel nativa.
     */
    guide: z
      .strictObject({
        mode: z.enum(["base", "extend"]),
        cell: Size,
        columns: z.number().int().min(1).max(16),
        rows: z.number().int().min(1).max(16),
        baselineY: PosInt,
        padLeft: NonNegInt,
        capHeight: PosInt,
        tracking: NonNegInt.max(4),
        backgroundKey: HexColor,
        inkColor: HexColor,
        pages: z.array(z.strictObject({ partKey: z.string().min(1).max(64), codepoints: z.array(Codepoint).min(1).max(256) })).min(1).max(16),
        baseRevisionId: Id.nullable(),
      })
      .optional(),
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
    plan("generate_asset").extend({ sources: z.array(AssetReferenceSource).max(16) }),
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
    checkUnique<PlanSource | z.infer<typeof AssetReferenceSource>>(ctx, p.sources, (s) => "uploadId" in s ? `upload:${s.uploadId}` : `revision:${s.revisionId}/${s.fileId}`, "Fonte", ["sources"]);
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
      case "generate_asset": {
        if (p.sources.length > 0) requires("image_references");
        const { family, kind, transparent } = p.params;
        if (!(family === "character" && kind === "base") && !(family === "item" && ITEM_KINDS.some((itemKind) => itemKind === kind))) {
          ctx.addIssue({ code: "custom", message: "A geração por imagem publica em character/base ou em um tipo de item", path: ["params", "kind"] });
        }
        if (family === "character" && !transparent) {
          ctx.addIssue({ code: "custom", message: "A base de personagem exige fundo transparente", path: ["params", "transparent"] });
        }
        break;
      }
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
      // Cartão U3: sem capacidade nativa, o template vai como guia raster e os estados como folha por imagem + referência.
      case "generate_ui_template": {
        requires(p.params.guide ? "image_references" : "ui_template");
        checkUnique(ctx, p.params.requestedComponents, (c) => c.localId, "Peça", ["params", "requestedComponents"]);
        const [tw, th] = p.params.logicalSize;
        p.params.requestedComponents.forEach((c, i) => {
          if (p.params.guide && !c.cell) ctx.addIssue({ code: "custom", message: `Peça ${c.localId} sem célula na guia`, path: ["params", "requestedComponents", i, "cell"] });
          if (c.cell && (c.cell[0] + c.cell[2] > tw || c.cell[1] + c.cell[3] > th)) {
            ctx.addIssue({ code: "custom", message: `Célula de ${c.localId} fora do template ${tw}×${th}`, path: ["params", "requestedComponents", i, "cell"] });
          }
          if ((c.componentType === "meter") !== Boolean(c.meterPart) && p.params.guide) {
            ctx.addIssue({ code: "custom", message: "Na guia, a barra é pedida como trilho, preenchimento e moldura separados", path: ["params", "requestedComponents", i, "meterPart"] });
          }
        });
        break;
      }
      case "generate_ui_states": {
        requires(p.params.sheets ? "image_references" : "ui_states");
        const sheets = p.params.sheets ?? [];
        checkUnique(ctx, sheets, (s) => s.componentRevisionId, "Folha", ["params", "sheets"]);
        sheets.forEach((sheet, i) => {
          if (!p.params.componentRevisionIds.includes(sheet.componentRevisionId)) ctx.addIssue({ code: "custom", message: `Folha de componente fora do plano: ${sheet.componentRevisionId}`, path: ["params", "sheets", i] });
          if (sheet.columns * sheet.rows < sheet.states.length + 1) ctx.addIssue({ code: "custom", message: `Folha ${sheet.columns}×${sheet.rows} não comporta base + ${sheet.states.length} estados`, path: ["params", "sheets", i] });
          if (sheet.states.includes(sheet.baseState)) ctx.addIssue({ code: "custom", message: "O estado-base aprovado não é gerado de novo", path: ["params", "sheets", i, "states"] });
          const want = [sheet.gapPx + sheet.columns * (sheet.cell[0] + sheet.gapPx), sheet.gapPx + sheet.rows * (sheet.cell[1] + sheet.gapPx)];
          if (sheet.sheetSize[0] !== want[0] || sheet.sheetSize[1] !== want[1]) ctx.addIssue({ code: "custom", message: `Folha deve medir ${want.join("×")}`, path: ["params", "sheets", i, "sheetSize"] });
        });
        if (p.params.sheets && p.params.componentRevisionIds.some((id) => !sheets.some((s) => s.componentRevisionId === id))) {
          ctx.addIssue({ code: "custom", message: "Cada componente do plano tem a sua folha", path: ["params", "sheets"] });
        }
        break;
      }
      // Cartão D1: rota genérica (imagem + referências) ou capacidade nativa declarada; nunca as duas.
      case "generate_portrait":
        requires(p.params.route ? "image_references" : "portrait");
        if (p.params.route && !p.sources.some((s) => s.role === "identity" && s.revisionId === p.params.characterRevisionId)) {
          ctx.addIssue({ code: "custom", message: "A vista do personagem deve estar congelada nas fontes (papel identity)", path: ["sources"] });
        }
        break;
      case "generate_visemes": {
        requires(p.params.sheet ? "image_references" : "visemes");
        const ids = p.params.visemeIds;
        if (ids && ids.length !== p.params.visemeCount) {
          ctx.addIssue({ code: "custom", message: `visemeIds tem ${ids.length} itens; visemeCount = ${p.params.visemeCount}`, path: ["params", "visemeIds"] });
        }
        if (ids && new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "visemes repetidos", path: ["params", "visemeIds"] });
        if (p.params.sheet) {
          checkSheetCells(ctx, p.params.sheet, p.params.visemeCount);
          if (!ids || p.params.sheet.frameIds.join("|") !== ids.join("|")) {
            ctx.addIssue({ code: "custom", message: "A folha declara os visemes na mesma ordem de visemeIds", path: ["params", "sheet", "frameIds"] });
          }
          if (!p.params.faceRect || !p.params.mouthRect) ctx.addIssue({ code: "custom", message: "Rota genérica exige faceRect e mouthRect do retrato", path: ["params"] });
          if (!p.sources.some((s) => s.role === "identity" && s.revisionId === p.params.portraitRevisionId)) {
            ctx.addIssue({ code: "custom", message: "O retrato aprovado deve estar congelado nas fontes (papel identity)", path: ["sources"] });
          }
        }
        break;
      }
      case "generate_pixel_font": {
        const guide = p.params.guide;
        requires(guide ? "image_references" : "pixel_font");
        if (!guide) break;
        if (guide.pages.map((g) => g.partKey).join("|") !== p.parts.map((part) => part.partKey).join("|")) {
          ctx.addIssue({ code: "custom", message: "Cada parte do plano é uma página do gabarito, na mesma ordem", path: ["params", "guide", "pages"] });
        }
        guide.pages.forEach((page, i) => {
          if (page.codepoints.length > guide.columns * guide.rows) {
            ctx.addIssue({ code: "custom", message: `Página ${page.partKey} não comporta ${page.codepoints.length} glyphs`, path: ["params", "guide", "pages", i] });
          }
        });
        const paged = guide.pages.flatMap((page) => page.codepoints);
        const required = new Set(p.params.requiredCodepoints);
        if (paged.length !== required.size || paged.some((c) => !required.has(c))) {
          ctx.addIssue({ code: "custom", message: "As páginas cobrem exatamente os codepoints pedidos, sem repetição", path: ["params", "guide", "pages"] });
        }
        if (guide.baselineY > guide.cell[1] || guide.capHeight > guide.baselineY) {
          ctx.addIssue({ code: "custom", message: "Baseline/altura de maiúscula fora da célula", path: ["params", "guide", "baselineY"] });
        }
        if (guide.mode === "extend" && (!guide.baseRevisionId || !p.sources.some((s) => s.revisionId === guide.baseRevisionId))) {
          ctx.addIssue({ code: "custom", message: "Extensão exige a revisão-base da fonte congelada nas fontes", path: ["params", "guide", "baseRevisionId"] });
        }
        break;
      }
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
