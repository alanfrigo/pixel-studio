import { z } from "zod";
import { checkUnique, DurationMs, Id, Int, LanguageTag, NonNegInt, PixelIndex, PosInt, Rect, Size, Slug } from "./common";
import { TextKey } from "./ui";

/**
 * Retratos/fala, fontes e áudio (07 §tipografia e retratos, 02a §áudio).
 * Fontes e áudio têm validação própria, sem exigir dimensões raster do áudio.
 */

// ---------------------------------------------------------------------------
// Retrato, expressão (visemes) e fala
// ---------------------------------------------------------------------------

export const PortraitPayload = z.strictObject({
  characterRevisionId: Id,
  fileId: Id,
  rect: Rect,
  logicalSize: Size,
  /** Ponto de alinhamento facial. */
  faceAnchor: PixelIndex,
});
export type PortraitPayload = z.infer<typeof PortraitPayload>;

export const ExpressionPayload = z
  .strictObject({
    portraitRevisionId: Id,
    expressionKey: Slug,
    /** Mesma quantidade/ordem de visemes entre expressões. */
    visemes: z.array(z.strictObject({ visemeId: Slug, fileId: Id, rect: Rect })).min(1).max(32),
  })
  .superRefine((e, ctx) => checkUnique(ctx, e.visemes, (v) => v.visemeId, "Viseme", ["visemes"]));
export type ExpressionPayload = z.infer<typeof ExpressionPayload>;

export const SpeechPayload = z
  .strictObject({
    textKey: TextKey,
    language: LanguageTag,
    /** Texto em NFC. */
    sampleText: z.string().min(1).max(2000),
    expressionRevisionId: Id,
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
});

export const FontPayload = z
  .strictObject({
    nativeGlyphPx: PosInt,
    metrics: z.strictObject({
      ascent: NonNegInt,
      descent: NonNegInt,
      lineHeight: PosInt,
      spaceAdvance: NonNegInt,
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
