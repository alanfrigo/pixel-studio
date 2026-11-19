import { z } from "zod";
import {
  checkUnique,
  Id,
  Insets,
  Int,
  Offset,
  PixelIndex,
  pixelIndexInside,
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

export const StateImage = z.strictObject({ state: UiState, fileId: Id, rect: Rect });

/** Foco é indicador; guardar se é sobreposição ou imagem completa. */
export const FocusIndicator = z.strictObject({
  mode: z.enum(["overlay", "full_image"]),
  fileId: Id,
  rect: Rect,
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

export const ScreenInstance = z.strictObject({
  instanceId: Id,
  parentId: Id.nullable(),
  /** `null` = grupo sem arte própria. */
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
  }),
});

export const ScreenPayload = z
  .strictObject({
    referenceResolution: Size,
    /** Fundo de inspeção (`exported: false`) ou parte da tela exportada. */
    background: z.strictObject({ revisionId: Id, exported: z.boolean() }).nullable(),
    instances: z.array(ScreenInstance).min(1),
    /** Navegação de foco independente da ordem de desenho. */
    focusOrder: z.array(Id),
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
    s.focusOrder.forEach((id, i) => {
      if (!byId.has(id)) ctx.addIssue({ code: "custom", message: `Foco aponta instância inexistente: ${id}`, path: ["focusOrder", i] });
    });
  });
export type ScreenPayload = z.infer<typeof ScreenPayload>;
