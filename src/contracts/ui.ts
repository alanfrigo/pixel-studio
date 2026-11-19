import { z } from "zod";
import {
  checkUnique,
  HexColor,
  Id,
  Insets,
  Int,
  LanguageTag,
  NonNegInt,
  Offset,
  PixelIndex,
  pixelIndexInside,
  PosInt,
  Rect,
  rectFits,
  Size,
  Slug,
} from "./common";

/**
 * UI do jogo (07, 06 §nine-slice). Pixels lógicos inteiros, origem superior
 * esquerda. Texto é dado separado da arte: o componente guarda a chave e uma
 * amostra editável.
 */

export const UiState = z.enum(["normal", "hover", "pressed", "disabled", "selected", "empty", "occupied"]);
export type UiState = z.infer<typeof UiState>;

export const AtlasRegion = z.strictObject({ fileId: Id, rect: Rect });

/**
 * Transformação local explícita de uma aparência (07 §estados, cartão U3):
 * rampa da paleta do projeto (± degraus), realce do miolo e deslocamento do
 * miolo com o contorno fixo. Funciona sem IA e não é geração de estado.
 */
export const UiTransform = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ramp"), steps: z.number().int().min(-3).max(3) }),
  z.strictObject({ kind: z.literal("highlight"), amount: z.number().min(0.05).max(0.6) }),
  z.strictObject({ kind: z.literal("offset"), dx: z.number().int().min(-2).max(2), dy: z.number().int().min(-2).max(2) }),
]);
export type UiTransform = z.infer<typeof UiTransform>;

/**
 * Origem de cada aparência (cartão U3): importada, recortada de um template,
 * derivada por imagem + referência do componente aprovado (rota genérica, NÃO
 * é geração nativa de estados) ou transformação local explícita.
 */
export const StateOrigin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("imported") }),
  z.strictObject({ kind: z.literal("template_split"), templateRevisionId: Id, rect: Rect }),
  z.strictObject({ kind: z.literal("generated_reference"), referenceRevisionId: Id, referenceState: UiState }),
  z.strictObject({ kind: z.literal("local_transform"), sourceRevisionId: Id, sourceState: UiState, transform: UiTransform }),
]);
export type StateOrigin = z.infer<typeof StateOrigin>;

export const StateImage = z.strictObject({ state: UiState, fileId: Id, rect: Rect, origin: StateOrigin.optional() });

/** Origem do foco: importado ou overlay desenhado localmente na cor de foco reservada. */
export const FocusOrigin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("imported") }),
  z.strictObject({ kind: z.literal("local_overlay"), sourceRevisionId: Id, color: HexColor, widthPx: z.number().int().min(1).max(3) }),
]);
export type FocusOrigin = z.infer<typeof FocusOrigin>;

/** Foco é indicador; guardar se é sobreposição ou imagem completa. */
export const FocusIndicator = z.strictObject({
  mode: z.enum(["overlay", "full_image"]),
  fileId: Id,
  rect: Rect,
  origin: FocusOrigin.optional(),
});

export const Stretch = z.strictObject({
  center: z.enum(["stretch", "tile"]),
  edges: z.enum(["stretch", "tile"]),
});

export const TextKey = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, "Chave de texto deve ser como inventory.use");

export const TextSlot = z.strictObject({
  key: TextKey,
  /** Amostra editável, ex.: "Usar". */
  sample: z.string().min(1).max(500),
  align: z.enum(["start", "center", "end"]),
  verticalAlign: z.enum(["top", "middle", "bottom"]),
  wrap: z.enum(["none", "word"]),
  overflow: z.enum(["grow", "paginate", "ellipsis", "report"]),
  fontRevisionId: Id.nullable(),
});
export type TextSlot = z.infer<typeof TextSlot>;

type Ctx = z.RefinementCtx;

function checkInsetsLeaveCenter(ctx: Ctx, insets: Insets | null, size: Size, path: string, what: string) {
  if (!insets) return;
  if (insets.left + insets.right >= size[0] || insets.top + insets.bottom >= size[1]) {
    ctx.addIssue({ code: "custom", message: `${what} deixa a área central sem pixels`, path: [path] });
  }
}

function checkStateCells(ctx: Ctx, rects: { rect: Rect }[], size: Size, path: string) {
  rects.forEach((item, i) => {
    if (item.rect[2] !== size[0] || item.rect[3] !== size[1]) {
      ctx.addIssue({ code: "custom", message: "Cada estado deve manter a célula do tamanho lógico", path: [path, i, "rect"] });
    }
  });
}

function checkRequiredStates(ctx: Ctx, states: { state: UiState }[], required: UiState[], complete: boolean) {
  checkUnique(ctx, states, (s) => s.state, "Estado", ["states"]);
  if (!complete) return;
  const present = new Set(states.map((s) => s.state));
  const missing = required.filter((s) => !present.has(s));
  if (missing.length > 0) {
    ctx.addIssue({ code: "custom", message: `Componente marcado completo sem os estados: ${missing.join(", ")}`, path: ["complete"] });
  }
}

export const ButtonPayload = z
  .strictObject({
    logicalSize: Size,
    states: z.array(StateImage).min(1),
    requiredStates: z.array(UiState).min(1),
    focus: FocusIndicator.nullable(),
    nineSlice: Insets.nullable(),
    contentPadding: Insets,
    stretch: Stretch,
    /** Retângulo interativo local; `null` = componente inteiro. */
    interactiveRect: Rect.nullable(),
    text: TextSlot.nullable(),
    /** Nome acessível para botões só com ícone. */
    accessibleName: z.string().max(120).nullable(),
    complete: z.boolean(),
  })
  .superRefine((b, ctx) => {
    checkStateCells(ctx, b.states, b.logicalSize, "states");
    checkRequiredStates(ctx, b.states, b.requiredStates, b.complete);
    if (!b.requiredStates.includes("normal")) {
      ctx.addIssue({ code: "custom", message: "Botão exige o estado normal", path: ["requiredStates"] });
    }
    checkInsetsLeaveCenter(ctx, b.nineSlice, b.logicalSize, "nineSlice", "nineSlice");
    checkInsetsLeaveCenter(ctx, b.contentPadding, b.logicalSize, "contentPadding", "contentPadding");
    if (b.focus && (b.focus.rect[2] !== b.logicalSize[0] || b.focus.rect[3] !== b.logicalSize[1])) {
      ctx.addIssue({ code: "custom", message: "Foco deve ter o tamanho lógico do botão", path: ["focus", "rect"] });
    }
    if (b.interactiveRect && !rectFits(b.interactiveRect, [b.interactiveRect[0], b.interactiveRect[1]], b.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Área interativa fora do componente", path: ["interactiveRect"] });
    }
    if (!b.text && !b.accessibleName) {
      ctx.addIssue({ code: "custom", message: "Botão sem texto precisa de nome acessível", path: ["accessibleName"] });
    }
  });
export type ButtonPayload = z.infer<typeof ButtonPayload>;

export const PanelPayload = z
  .strictObject({
    logicalSize: Size,
    image: AtlasRegion,
    nineSlice: Insets,
    contentPadding: Insets,
    stretch: Stretch,
    minSize: Size,
  })
  .superRefine((p, ctx) => {
    if (p.image.rect[2] !== p.logicalSize[0] || p.image.rect[3] !== p.logicalSize[1]) {
      ctx.addIssue({ code: "custom", message: "Imagem do painel deve ter o tamanho lógico", path: ["image", "rect"] });
    }
    checkInsetsLeaveCenter(ctx, p.nineSlice, p.logicalSize, "nineSlice", "nineSlice");
    checkInsetsLeaveCenter(ctx, p.contentPadding, p.logicalSize, "contentPadding", "contentPadding");
  });
export type PanelPayload = z.infer<typeof PanelPayload>;

export const SlotPayload = z
  .strictObject({
    logicalSize: Size,
    states: z.array(StateImage).min(1),
    requiredStates: z.array(UiState).min(1),
    nineSlice: Insets.nullable(),
    /** Área local onde o ícone do item é desenhado. */
    iconRect: Rect,
    /** Âncora do contador de quantidade (texto). */
    counterAnchor: PixelIndex,
    counterAlign: z.enum(["start", "end"]),
    complete: z.boolean(),
  })
  .superRefine((s, ctx) => {
    checkStateCells(ctx, s.states, s.logicalSize, "states");
    checkRequiredStates(ctx, s.states, s.requiredStates, s.complete);
    checkInsetsLeaveCenter(ctx, s.nineSlice, s.logicalSize, "nineSlice", "nineSlice");
    if (!rectFits(s.iconRect, [s.iconRect[0], s.iconRect[1]], s.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Área do ícone fora do slot", path: ["iconRect"] });
    }
    if (!pixelIndexInside(s.counterAnchor, s.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Contador fora do slot", path: ["counterAnchor"] });
    }
  });
export type SlotPayload = z.infer<typeof SlotPayload>;

/**
 * Medidor (barra de vida). Valor normalizado `clamp((v-min)/(max-min), 0, 1)`;
 * a prévia em pixels arredonda para baixo.
 */
export const MeterPayload = z
  .strictObject({
    logicalSize: Size,
    track: AtlasRegion,
    fill: z.strictObject({ fileId: Id, rect: Rect, offset: Offset }),
    frame: AtlasRegion,
    usefulRect: Rect,
    axis: z.enum(["horizontal", "vertical"]),
    direction: z.enum(["forward", "reverse"]),
    range: z.strictObject({ min: z.number(), max: z.number() }),
    rounding: z.literal("floor"),
    nineSlice: Insets.nullable(),
  })
  .superRefine((m, ctx) => {
    if (!(m.range.max > m.range.min)) {
      ctx.addIssue({ code: "custom", message: "Faixa do medidor exige max > min", path: ["range"] });
    }
    for (const part of ["track", "frame"] as const) {
      const r = m[part].rect;
      if (r[2] !== m.logicalSize[0] || r[3] !== m.logicalSize[1]) {
        ctx.addIssue({ code: "custom", message: `${part} deve ter o tamanho lógico`, path: [part, "rect"] });
      }
    }
    if (!rectFits(m.usefulRect, [m.usefulRect[0], m.usefulRect[1]], m.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Área útil fora do medidor", path: ["usefulRect"] });
    }
    if (!rectFits(m.fill.rect, m.fill.offset, m.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Preenchimento fora do medidor", path: ["fill"] });
    }
  });
export type MeterPayload = z.infer<typeof MeterPayload>;

export const MenuItemPayload = z.strictObject({
  buttonRevisionId: Id,
  iconRevisionId: Id.nullable(),
  actionId: Slug,
  text: TextSlot,
  shortcut: z.string().max(32).nullable(),
  selectable: z.boolean(),
});
export type MenuItemPayload = z.infer<typeof MenuItemPayload>;

const Anchors = z.strictObject({
  left: z.number().min(0).max(1),
  top: z.number().min(0).max(1),
  right: z.number().min(0).max(1),
  bottom: z.number().min(0).max(1),
});

const AnchorOffsets = z.strictObject({ left: Int, top: Int, right: Int, bottom: Int });

/** Papel semântico de um elemento da tela (diálogo: título, corpo, retrato e indicador separados). */
export const UiElementRole = z.enum(["dialogue", "title", "body", "portrait", "continue_indicator", "menu", "inventory", "hud"]);
export type UiElementRole = z.infer<typeof UiElementRole>;

/** Grupo em grade (inventário): os filhos ocupam células de tamanho fixo com espaçamento inteiro. */
export const GridLayout = z.strictObject({
  kind: z.literal("grid"),
  columns: PosInt.max(32),
  rows: PosInt.max(32),
  cell: Size,
  gap: z.tuple([NonNegInt, NonNegInt]),
});
export type GridLayout = z.infer<typeof GridLayout>;

/** Offsets do filho `index` (ordem de leitura) numa grade: âncoras no canto superior esquerdo do grupo. */
export function gridCellOffsets(layout: GridLayout, index: number) {
  const col = index % layout.columns;
  const row = Math.floor(index / layout.columns);
  const left = col * (layout.cell[0] + layout.gap[0]);
  const top = row * (layout.cell[1] + layout.gap[1]);
  return { left, top, right: left + layout.cell[0], bottom: top + layout.cell[1] };
}

export const ScreenInstance = z.strictObject({
  instanceId: Id,
  parentId: Id.nullable(),
  /** `null` = grupo sem arte própria (ou elemento de texto, com `text`). */
  componentRevisionId: Id.nullable(),
  anchors: Anchors,
  offsets: AnchorOffsets,
  /** Ordem de desenho entre irmãos. */
  order: Int,
  hidden: z.boolean(),
  overrides: z.strictObject({
    textKey: TextKey.optional(),
    text: z.string().max(500).optional(),
    iconRevisionId: Id.optional(),
    value: z.number().optional(),
    state: UiState.optional(),
    /** Cartão U3: quantidade mostrada no contador do slot. */
    quantity: NonNegInt.max(9999).optional(),
  }),
  /** Cartão U3: papel semântico (título, corpo, retrato, indicador de continuação, menu, inventário, HUD). */
  role: UiElementRole.optional(),
  /** Cartão U3: elemento de texto sem arte (área = retângulo da instância; quebra e excesso declarados). */
  text: TextSlot.optional(),
  /** Cartão U3: grupo em grade com espaçamento inteiro (inventário). */
  layout: GridLayout.optional(),
  /** Cartão U3: grupo bloqueado para edição (preserva as coordenadas relativas). */
  locked: z.boolean().optional(),
});
export type ScreenInstance = z.infer<typeof ScreenInstance>;

/**
 * Catálogo de textos da tela (07 §texto do jogo): cada chave com a amostra em
 * cada idioma. A rasterização da legenda acontece na prévia e na engine.
 */
export const TextCatalog = z
  .strictObject({
    languages: z.array(LanguageTag).min(1).max(8),
    entries: z.array(z.strictObject({ key: TextKey, text: z.record(z.string(), z.string().min(1).max(500)) })).max(400),
  })
  .superRefine((c, ctx) => {
    checkUnique(ctx, c.languages, (l) => l, "Idioma", ["languages"]);
    checkUnique(ctx, c.entries, (e) => e.key, "Chave de texto", ["entries"]);
    const langs = new Set(c.languages);
    c.entries.forEach((e, i) => {
      for (const lang of Object.keys(e.text)) {
        if (!langs.has(lang)) ctx.addIssue({ code: "custom", message: `Idioma ${lang} fora da lista do catálogo`, path: ["entries", i, "text", lang] });
      }
    });
  });
export type TextCatalog = z.infer<typeof TextCatalog>;

export const ScreenPayload = z
  .strictObject({
    referenceResolution: Size,
    /** Fundo de inspeção (`exported: false`) ou parte da tela exportada. */
    background: z.strictObject({ revisionId: Id, exported: z.boolean() }).nullable(),
    instances: z.array(ScreenInstance).min(1),
    /** Navegação de foco independente da ordem de desenho. */
    focusOrder: z.array(Id),
    /** Cartão U3: catálogo de amostras por idioma (as instâncias guardam só a chave). */
    textCatalog: TextCatalog.optional(),
    /** Cartão U3: resoluções lógicas em que a tela foi conferida (ex.: 320×180 e 400×300). */
    testedResolutions: z.array(Size).max(8).optional(),
  })
  .superRefine((s, ctx) => {
    checkUnique(ctx, s.instances, (i) => i.instanceId, "Instância", ["instances"]);
    checkUnique(ctx, s.focusOrder, (id) => id, "Foco", ["focusOrder"]);
    const byId = new Map(s.instances.map((i) => [i.instanceId, i]));
    s.instances.forEach((inst, i) => {
      if (inst.parentId !== null && !byId.has(inst.parentId)) {
        ctx.addIssue({ code: "custom", message: `Pai inexistente: ${inst.parentId}`, path: ["instances", i, "parentId"] });
      }
      if (inst.anchors.left > inst.anchors.right || inst.anchors.top > inst.anchors.bottom) {
        ctx.addIssue({ code: "custom", message: "Âncoras invertidas", path: ["instances", i, "anchors"] });
      }
      if (inst.text && inst.componentRevisionId !== null) {
        ctx.addIssue({ code: "custom", message: "Elemento de texto não tem arte própria (a legenda de um componente vai em overrides)", path: ["instances", i, "text"] });
      }
      if (inst.layout && inst.componentRevisionId !== null) {
        ctx.addIssue({ code: "custom", message: "Grade é propriedade de um grupo (sem arte própria)", path: ["instances", i, "layout"] });
      }
      const seen = new Set<string>();
      let cur = inst;
      while (cur.parentId !== null) {
        if (seen.has(cur.instanceId)) {
          ctx.addIssue({ code: "custom", message: "Ciclo na hierarquia da tela", path: ["instances", i] });
          break;
        }
        seen.add(cur.instanceId);
        const next = byId.get(cur.parentId);
        if (!next) break;
        cur = next;
      }
    });
    // Cartão U3: filhos de uma grade ficam nas células, em ordem, com espaçamento inteiro.
    s.instances.forEach((group, gi) => {
      if (!group.layout) return;
      const children = s.instances.filter((c) => c.parentId === group.instanceId).sort((a, b) => a.order - b.order);
      if (children.length > group.layout.columns * group.layout.rows) {
        ctx.addIssue({ code: "custom", message: `Grade ${group.layout.columns}×${group.layout.rows} não comporta ${children.length} itens`, path: ["instances", gi, "layout"] });
      }
      children.forEach((child, k) => {
        const want = gridCellOffsets(group.layout!, k);
        const a = child.anchors;
        const o = child.offsets;
        if (a.left !== 0 || a.top !== 0 || a.right !== 0 || a.bottom !== 0 || o.left !== want.left || o.top !== want.top || o.right !== want.right || o.bottom !== want.bottom) {
          ctx.addIssue({ code: "custom", message: `${child.instanceId} fora da célula ${k + 1} da grade`, path: ["instances", s.instances.indexOf(child), "offsets"] });
        }
      });
    });
    s.focusOrder.forEach((id, i) => {
      if (!byId.has(id)) ctx.addIssue({ code: "custom", message: `Foco aponta instância inexistente: ${id}`, path: ["focusOrder", i] });
    });
  });
export type ScreenPayload = z.infer<typeof ScreenPayload>;

// ---------------------------------------------------------------------------
// Cartão U3: template de UI (imagem achatada + células declaradas + proposta de separação)
// ---------------------------------------------------------------------------

export const UI_COMPONENT_TYPES = ["button", "panel", "slot", "meter", "menu_item"] as const;
export const UiComponentType = z.enum(UI_COMPONENT_TYPES);
export type UiComponentType = z.infer<typeof UiComponentType>;

/** Trilho, preenchimento e moldura da barra são peças separadas no template (o split de um contorno não cria três camadas). */
export const MeterPart = z.enum(["track", "fill", "frame"]);
export type MeterPart = z.infer<typeof MeterPart>;

export const TemplateCell = z.strictObject({
  localId: Id,
  /** Componente a que a célula pertence (as três partes da barra compartilham o mesmo). */
  componentId: Id,
  componentType: UiComponentType,
  meterPart: MeterPart.nullable(),
  /** Célula declarada no template (pixels lógicos). */
  cell: Rect,
  requiredStates: z.array(UiState),
});
export type TemplateCell = z.infer<typeof TemplateCell>;

/**
 * Template gerado: uma imagem ACHATADA com as peças nas células declaradas.
 * Ainda não é um conjunto de componentes editáveis: cada peça vira componente
 * só pelo recorte local explícito, revisado pelo artista.
 */
export const TemplatePayload = z
  .strictObject({
    logicalSize: Size,
    image: AtlasRegion,
    flattened: z.literal(true),
    cells: z.array(TemplateCell).min(1).max(32),
    /** Proposta local de separação: conteúdo encontrado dentro de cada célula (`null` = célula vazia). */
    proposals: z.array(z.strictObject({ localId: Id, rect: Rect.nullable(), touchesCellEdge: z.boolean() })),
  })
  .superRefine((t, ctx) => {
    checkUnique(ctx, t.cells, (c) => c.localId, "Célula", ["cells"]);
    if (t.image.rect[2] !== t.logicalSize[0] || t.image.rect[3] !== t.logicalSize[1]) {
      ctx.addIssue({ code: "custom", message: "Imagem do template deve ter o tamanho lógico", path: ["image", "rect"] });
    }
    t.cells.forEach((c, i) => {
      if (!rectFits(c.cell, [c.cell[0], c.cell[1]], t.logicalSize)) ctx.addIssue({ code: "custom", message: `Célula ${c.localId} fora do template`, path: ["cells", i, "cell"] });
      if ((c.componentType === "meter") !== (c.meterPart !== null)) ctx.addIssue({ code: "custom", message: "Só a barra declara parte (trilho/preenchimento/moldura)", path: ["cells", i, "meterPart"] });
    });
    const ids = new Set(t.cells.map((c) => c.localId));
    t.proposals.forEach((p, i) => {
      if (!ids.has(p.localId)) ctx.addIssue({ code: "custom", message: `Proposta para célula inexistente: ${p.localId}`, path: ["proposals", i] });
    });
  });
export type TemplatePayload = z.infer<typeof TemplatePayload>;

// ---------------------------------------------------------------------------
// Cartão U3: receitas do processador Python (`python/pixel_pipeline/ui.py`)
// ---------------------------------------------------------------------------

const PyRect = z.tuple([NonNegInt, NonNegInt, PosInt, PosInt]);

export const UI_PYTHON_RECIPES = {
  /** Guia raster do template: células cinza na cor-chave (ampliada por fator inteiro). */
  ui_template_guide: z.strictObject({
    version: z.literal(1),
    size: Size,
    scale: PosInt.max(32),
    backgroundKey: HexColor,
    cells: z.array(z.strictObject({ localId: Id, rect: PyRect, kind: z.enum(["piece", "fill", "frame"]) })).min(1).max(32),
  }),
  /** Proposta de separação: conteúdo (alfa) dentro de cada célula, células vazias e conteúdo encostado na borda. */
  ui_template_split: z.strictObject({
    version: z.literal(1),
    cells: z.array(z.strictObject({ localId: Id, rect: PyRect })).min(1).max(32),
    zoom: PosInt.max(8),
    /** Cor-chave a limpar também em áreas fechadas (miolo da moldura), não só a ligada à borda; gera a saída `cleaned`. */
    backgroundKey: HexColor.nullable().optional(),
  }),
  /** Recorte local explícito (separar recorta pixels, não gera arte) e cobertura opcional de áreas que devem ficar vazias. */
  ui_crop: z.strictObject({
    version: z.literal(1),
    crops: z.array(z.strictObject({ key: Id, rect: PyRect, emptyRect: PyRect.nullable() })).min(1).max(32),
  }),
  /** Guia da folha de estados: célula 0 = estado-base aprovado; demais = moldura-guia cinza (fundo de cor-chave). */
  ui_state_guide: z.strictObject({
    version: z.literal(1),
    sheetSize: Size,
    scale: PosInt.max(32),
    backgroundKey: HexColor,
    cells: z.array(PyRect).min(2).max(16),
  }),
  /**
   * Folha de estados recebida (entrada `candidate`, já na grade lógica e sem
   * fundo) × estado-base (`source`): recorta cada célula, corrige só
   * translação inteira e confere célula, contorno, miolo e padding.
   */
  ui_state_sheet: z.strictObject({
    version: z.literal(1),
    cell: Size,
    cells: z.array(z.strictObject({ state: UiState, rect: PyRect })).min(1).max(15),
    nineSlice: Insets.nullable(),
    contentPadding: Insets.nullable(),
    searchPx: NonNegInt.max(8),
    outlineTolerance: z.number().min(0).max(1),
  }),
  /** Transformação local explícita (rampa da paleta, realce do miolo, deslocamento do miolo com contorno fixo). */
  ui_state_transform: z.strictObject({
    version: z.literal(1),
    transform: UiTransform,
    palette: z.array(HexColor).max(64),
    keepBorderPx: NonNegInt.max(4),
  }),
  /** Overlay de foco local: contorno da silhueta na cor de foco, transparente no resto. */
  ui_focus_overlay: z.strictObject({
    version: z.literal(1),
    color: HexColor,
    widthPx: z.number().int().min(1).max(3),
  }),
} as const;
