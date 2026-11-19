import { z } from "zod";
import { checkUnique, DurationMs, HexColor, Id, Int, LanguageTag, NonNegInt, PixelIndex, PosInt, Rect, Size, Slug } from "./common";
import { TextKey } from "./ui";

/**
 * Retratos/fala, fontes e áudio (07 §tipografia e retratos, 02a §áudio).
 * Fontes e áudio têm validação própria, sem exigir dimensões raster do áudio.
 */

// ---------------------------------------------------------------------------
// Retrato, expressão (visemes) e fala
// ---------------------------------------------------------------------------

/**
 * Conjunto de visemes do cartão D1 (`pixel-studio-v1`): mesma quantidade e
 * ordem em toda expressão, numa grade 4 × 2 declarada. A ordem de leitura da
 * grade é a ordem deste array. Regra letra → viseme em `src/domain/dialogue/visemes.ts`.
 */
export const VISEME_SET_ID = "pixel-studio-v1";
export const VISEME_IDS = ["rest", "ai", "e", "o", "u", "mbp", "fv", "cons"] as const;
export type VisemeId = (typeof VISEME_IDS)[number];
export const VISEME_GRID = { columns: 4, rows: 2 } as const;

const rectInside = (r: readonly number[], [w, h]: readonly number[]) => r[0]! + r[2]! <= w! && r[1]! + r[3]! <= h!;

export const PortraitPayload = z
  .strictObject({
    characterRevisionId: Id,
    fileId: Id,
    rect: Rect,
    logicalSize: Size,
    /** Ponto de alinhamento facial (centro do rosto), revisado pelo artista. */
    faceAnchor: PixelIndex,
    /** D1: região do rosto que expressões podem mudar (olhos, sobrancelhas, boca). Fora dela = identidade protegida. */
    faceRect: Rect.optional(),
    /** D1: região da boca, a única que muda entre visemes de uma mesma expressão. */
    mouthRect: Rect.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.faceAnchor[0] >= p.logicalSize[0] || p.faceAnchor[1] >= p.logicalSize[1]) {
      ctx.addIssue({ code: "custom", message: "Âncora facial fora do retrato", path: ["faceAnchor"] });
    }
    for (const key of ["faceRect", "mouthRect"] as const) {
      const r = p[key];
      if (r && !rectInside(r, p.logicalSize)) ctx.addIssue({ code: "custom", message: `${key} fora do retrato`, path: [key] });
    }
  });
export type PortraitPayload = z.infer<typeof PortraitPayload>;

/** Grade declarada da folha de visemes (células do tamanho lógico do retrato). */
export const VisemeGrid = z.strictObject({ columns: z.number().int().min(1).max(8), rows: z.number().int().min(1).max(8), cell: Size });

export const ExpressionPayload = z
  .strictObject({
    portraitRevisionId: Id,
    expressionKey: Slug,
    /** Mesma quantidade/ordem de visemes entre expressões. */
    visemes: z.array(z.strictObject({ visemeId: Slug, fileId: Id, rect: Rect })).min(1).max(32),
    /** D1: conjunto/ordem de visemes (ex.: `pixel-studio-v1`), para conferir compatibilidade entre expressões. */
    visemeSet: Slug.optional(),
    /** D1: grade declarada da folha (ordem de leitura = ordem de `visemes`). */
    grid: VisemeGrid.optional(),
  })
  .superRefine((e, ctx) => {
    checkUnique(ctx, e.visemes, (v) => v.visemeId, "Viseme", ["visemes"]);
    if (e.grid && e.visemes.length > e.grid.columns * e.grid.rows) {
      ctx.addIssue({ code: "custom", message: `Grade ${e.grid.columns}×${e.grid.rows} não comporta ${e.visemes.length} visemes`, path: ["grid"] });
    }
  });
export type ExpressionPayload = z.infer<typeof ExpressionPayload>;

/**
 * Parâmetros temporais da regra letra → viseme (D1). Fixados na revisão da
 * fala: reabrir e recalcular reproduz a mesma sequência. Não é síntese de voz
 * nem reconhecimento fonético de áudio.
 */
export const SpeechTiming = z.strictObject({
  rule: z.literal("letters-v1"),
  vowelMs: DurationMs,
  consonantMs: DurationMs,
  /** Vírgula, ponto e vírgula, dois-pontos e travessão. */
  pauseMs: DurationMs,
  /** Ponto final, exclamação, interrogação e reticências. */
  stopMs: DurationMs,
  /** Boca em repouso ao fim da fala. */
  endRestMs: DurationMs,
});
export type SpeechTiming = z.infer<typeof SpeechTiming>;

export const SpeechPayload = z
  .strictObject({
    textKey: TextKey,
    language: LanguageTag,
    /** Texto em NFC. */
    sampleText: z.string().min(1).max(2000),
    expressionRevisionId: Id,
    /** D1: regra e parâmetros que geraram a sequência (reprodutível sem nova geração). */
    timing: SpeechTiming.optional(),
    /** Plano temporal; posições de boca não sintetizam voz. */
    timeline: z
      .array(
        z.strictObject({
          visemeId: Slug,
          durationMs: DurationMs,
          textPosition: NonNegInt,
        }),
      )
      .min(1),
  })
  .superRefine((s, ctx) => {
    if (s.sampleText !== s.sampleText.normalize("NFC")) {
      ctx.addIssue({ code: "custom", message: "Texto deve estar normalizado em NFC", path: ["sampleText"] });
    }
    const length = [...s.sampleText].length;
    s.timeline.forEach((step, i) => {
      if (step.textPosition > length) {
        ctx.addIssue({ code: "custom", message: "Posição além do fim do texto", path: ["timeline", i, "textPosition"] });
      }
    });
  });
export type SpeechPayload = z.infer<typeof SpeechPayload>;

// ---------------------------------------------------------------------------
// Fonte bitmap
// ---------------------------------------------------------------------------

export const Codepoint = z.number().int().min(0).max(0x10ffff);

export const Glyph = z.strictObject({
  codepoint: Codepoint,
  fileId: Id,
  rect: Rect,
  /** Relativos à baseline, Y positivo para baixo, posicionamento inteiro. */
  bearingX: Int,
  bearingY: Int,
  advanceX: NonNegInt,
  origin: z.enum(["generated", "extended", "imported"]),
  /** D1: glyph estendido = revisão-base da fonte cujos glyphs aprovados serviram de referência. */
  baseRevisionId: Id.optional(),
});
export type Glyph = z.infer<typeof Glyph>;

export const FontPayload = z
  .strictObject({
    nativeGlyphPx: PosInt,
    metrics: z.strictObject({
      ascent: NonNegInt,
      descent: NonNegInt,
      lineHeight: PosInt,
      spaceAdvance: NonNegInt,
      /** D1: distância do topo da linha até a baseline (= ascent nas fontes montadas pelo Studio). */
      baseline: NonNegInt.optional(),
    }),
    glyphs: z.array(Glyph).min(1),
    kerning: z.array(z.strictObject({ left: Codepoint, right: Codepoint, amount: Int })),
    /** Cobertura declarada; cada codepoint precisa de glyph inspecionado. */
    declaredCoverage: z.array(Codepoint).min(1),
    missingGlyph: z.discriminatedUnion("policy", [
      z.strictObject({ policy: z.literal("report") }),
      z.strictObject({ policy: z.literal("fallback"), fallbackCodepoint: Codepoint }),
    ]),
    /** TTF opcional declara apenas a cobertura realmente inspecionada. */
    ttf: z
      .strictObject({
        fileId: Id,
        inspectedCoverage: z.array(Codepoint).min(1),
      })
      .nullable(),
    license: z.strictObject({
      name: z.string().min(1).max(120),
      provenance: z.string().min(1).max(500),
    }),
  })
  .superRefine((font, ctx) => {
    checkUnique(ctx, font.glyphs, (g) => String(g.codepoint), "Glyph", ["glyphs"]);
    checkUnique(ctx, font.declaredCoverage, (c) => String(c), "Codepoint", ["declaredCoverage"]);
    const present = new Set(font.glyphs.map((g) => g.codepoint));
    const unbacked = font.declaredCoverage.filter((c) => !present.has(c));
    if (unbacked.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `Cobertura declarada sem glyph: ${unbacked.map(formatCodepoint).join(", ")}`,
        path: ["declaredCoverage"],
      });
    }
    if (font.missingGlyph.policy === "fallback" && !present.has(font.missingGlyph.fallbackCodepoint)) {
      ctx.addIssue({ code: "custom", message: "Glyph de substituição ausente", path: ["missingGlyph"] });
    }
    font.kerning.forEach((pair, i) => {
      if (!present.has(pair.left) || !present.has(pair.right)) {
        ctx.addIssue({ code: "custom", message: "Kerning cita glyph ausente", path: ["kerning", i] });
      }
    });
  });
export type FontPayload = z.infer<typeof FontPayload>;

export function formatCodepoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${String.fromCodePoint(cp)})`;
}

// ---------------------------------------------------------------------------
// Processamento local do D1 (python/pixel_pipeline/dialogue.py e font.py)
// ---------------------------------------------------------------------------

const GlyphRecipe = z.strictObject({ codepoint: Codepoint, page: NonNegInt, rect: Rect, bearingX: Int, bearingY: Int, advanceX: NonNegInt });
const FontMetricsRecipe = z.strictObject({ ascent: NonNegInt, descent: NonNegInt, lineHeight: PosInt, spaceAdvance: NonNegInt });
const GlyphCellGrid = {
  columns: z.number().int().min(1).max(16),
  rows: z.number().int().min(1).max(16),
  cell: Size,
  /** Linha logo abaixo do corpo dos glyphs, contada do topo da célula. */
  baselineY: PosInt,
  /** Origem da caneta na célula (x). */
  padLeft: NonNegInt,
  capHeight: PosInt,
};

export const DIALOGUE_PYTHON_RECIPES = {
  /** Retrato normalizado (`source`) × vista do personagem (`layer`): paleta, escala, conteúdo e regiões sugeridas. */
  portrait_check: z.strictObject({ version: z.literal(1), zoom: PosInt.max(16) }),
  /** Guia da folha de visemes: o retrato aprovado repetido na grade, boca marcada por contorno. */
  viseme_guide: z.strictObject({
    version: z.literal(1),
    columns: z.number().int().min(1).max(8),
    rows: z.number().int().min(1).max(8),
    cell: Size,
    mouthRect: Rect,
    markColor: HexColor,
    /** Rota sem alfa: achata a transparência sobre a cor-chave. */
    flattenOnto: HexColor.nullable(),
    scale: PosInt.max(32),
  }),
  /** Folha de visemes normalizada (`source`) × retrato (`layer`): fatia na grade e mede a estabilidade do rosto. */
  expression_sheet: z.strictObject({
    version: z.literal(1),
    columns: z.number().int().min(1).max(8),
    rows: z.number().int().min(1).max(8),
    cell: Size,
    frameIds: z.array(Slug).min(1).max(32),
    restId: Slug,
    faceRect: Rect,
    mouthRect: Rect,
    /** Fração máxima de pixels alterados fora da boca (dentro da folha) e fora do rosto (× retrato). */
    thresholds: z.strictObject({ outsideMouth: z.number().min(0).max(1), outsideFace: z.number().min(0).max(1) }),
    zoom: PosInt.max(16),
  }),
  /** Duas expressões lado a lado: quadros de repouso comparados fora da boca. */
  expression_compare: z.strictObject({ version: z.literal(1), rectA: Rect, rectB: Rect, mouthRect: Rect, zoom: PosInt.max(16) }),
  /** Prévia derivada de uma fala: GIF animado e tira PNG a partir dos visemes aprovados (não é o plano). */
  speech_preview: z.strictObject({
    version: z.literal(1),
    frames: z.array(z.strictObject({ rect: Rect, durationMs: DurationMs })).min(1).max(2000),
    zoom: PosInt.max(8),
    stripMax: PosInt.max(64),
  }),
  /** Gabarito de glyphs: células, baseline e letra-fantasma por célula (posição e tamanho, não estilo). */
  font_guide: z.strictObject({
    version: z.literal(1),
    ...GlyphCellGrid,
    codepoints: z.array(Codepoint.nullable()).min(1).max(256),
    scale: PosInt.max(32),
  }),
  /** Folha de glyphs normalizada (`source`): página binarizada, tinta por célula e métricas medidas. */
  font_measure: z.strictObject({
    version: z.literal(1),
    ...GlyphCellGrid,
    codepoints: z.array(Codepoint.nullable()).min(1).max(256),
    alphaThreshold: z.number().int().min(1).max(255),
    tracking: NonNegInt.max(4),
    /** Alinha à baseline da página os glyphs sem descendente (só métrica; pixels intactos). */
    snapBaseline: z.boolean(),
    /**
     * Cor-chave do fundo pedido ao modelo: a remoção pela borda não alcança o
     * miolo fechado de letras (o, A, B); aqui toda cor da mesma matiz vira fundo.
     */
    keyColor: HexColor.nullable(),
  }),
  /** Texto de teste com atlas (`layer` por página) + métricas: 1× e zoom inteiro, ausentes, largura e quebra. */
  font_render: z.strictObject({
    version: z.literal(1),
    glyphs: z.array(GlyphRecipe).min(1).max(4096),
    metrics: FontMetricsRecipe,
    kerning: z.array(z.strictObject({ left: Codepoint, right: Codepoint, amount: Int })).max(4096),
    texts: z.array(z.string().min(1).max(2000)).min(1).max(16),
    maxWidth: PosInt.max(4096).nullable(),
    zoom: PosInt.max(16),
    /** Cor de pré-visualização da tinta (`null` = cores do atlas). */
    color: HexColor.nullable(),
    background: HexColor.nullable(),
  }),
} as const;

// ---------------------------------------------------------------------------
// Áudio (música e efeitos)
// ---------------------------------------------------------------------------

/**
 * Pontos de loop em frames de amostra (precisão de amostra), validados contra
 * `frameCount` do arquivo: `0 ≤ startFrame < endFrame ≤ frameCount`.
 */
export const AudioLoop = z
  .strictObject({ startFrame: NonNegInt, endFrame: PosInt })
  .refine((l) => l.startFrame < l.endFrame, { message: "Loop exige startFrame < endFrame" });

export const AudioPayload = z.strictObject({
  fileId: Id,
  loop: AudioLoop.nullable(),
  /** Música: instrumental ou com voz. SFX: `null`. */
  vocal: z.boolean().nullable(),
  /** Letra opcional, conteúdo do jogo. */
  lyrics: z.string().max(10_000).nullable(),
});
export type AudioPayload = z.infer<typeof AudioPayload>;
