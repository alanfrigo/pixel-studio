import { z } from "zod";
import {
  AssetFamily,
  checkOrdinals,
  checkUnique,
  HexColor,
  Id,
  LanguageTag,
  NonNegInt,
  PosInt,
  ReferenceRole,
  Size,
} from "./common";
import { Camera, Direction } from "./projection";

/**
 * Revisão de estilo do projeto (01 §projeto, 03 §2). Aprovar uma revisão congela
 * suas regras; alterar estilo cria nova revisão e não atualiza derivados.
 */

export const PaletteColor = z.strictObject({
  index: NonNegInt,
  hex: HexColor,
  name: z.string().min(1).max(64).optional(),
});

export const Palette = z
  .strictObject({
    name: z.string().min(1).max(64),
    /** `strict` mapeia para a paleta; `guided` apenas mede desvios. */
    policy: z.enum(["strict", "guided"]),
    colors: z.array(PaletteColor).min(1).max(256),
  })
  .superRefine((palette, ctx) => {
    palette.colors.forEach((color, i) => {
      // O desempate por índice (05 §paleta) exige índices estáveis e contíguos.
      if (color.index !== i) {
        ctx.addIssue({ code: "custom", message: `Índice da cor deve ser ${i}`, path: ["colors", i, "index"] });
      }
    });
    checkUnique(ctx, palette.colors, (c) => c.hex.toLowerCase(), "Cor", ["colors"]);
  });
export type Palette = z.infer<typeof Palette>;

export const StyleReference = z.strictObject({
  ordinal: NonNegInt,
  revisionId: Id,
  role: ReferenceRole,
  /** Ex.: "copiar apenas a silhueta", "usar as cores do manto". */
  instruction: z.string().min(1).max(500),
});
export type StyleReference = z.infer<typeof StyleReference>;

export const StyleException = z.strictObject({
  family: AssetFamily,
  rule: z.enum(["partial_alpha", "reserved_focus_color", "outline_override", "palette_extension"]),
  notes: z.string().max(500),
});

export const StylePayload = z
  .strictObject({
    camera: Camera,
    scale: z.strictObject({
      /** Resolução lógica da cena. */
      logicalResolution: Size,
      /** Altura aparente de um personagem de referência, em px. */
      characterHeightPx: PosInt,
      /** Escala inteira preferida da UI sobre a resolução lógica. */
      uiScale: PosInt,
      /** Área lógica padrão por família, ex.: `character: [64, 64]`. */
      familySizes: z.partialRecord(AssetFamily, Size),
    }),
    palette: Palette,
    lighting: z.strictObject({
      lightFrom: Direction,
      shadow: z.enum(["none", "drop", "cast"]),
      notes: z.string().max(500),
    }),
    outline: z.strictObject({
      widthPx: z.number().int().min(0).max(4),
      policy: z.enum(["none", "dark", "selective", "colored"]),
    }),
    detailDensity: z.enum(["low", "medium", "high"]),
    transparency: z.enum(["binary", "partial"]),
    exceptions: z.array(StyleException),
    references: z.array(StyleReference),
    approvedExampleRevisionIds: z.array(Id),
    briefLanguage: LanguageTag,
  })
  .superRefine((style, ctx) => {
    checkOrdinals(ctx, style.references, ["references"]);
    checkUnique(ctx, style.references, (r) => r.revisionId, "Referência", ["references"]);
  });
export type StylePayload = z.infer<typeof StylePayload>;
