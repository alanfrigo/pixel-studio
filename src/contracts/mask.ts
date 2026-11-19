import { z } from "zod";
import { Id, Size } from "./common";

/**
 * Máscaras locais (05 §convenção de máscaras).
 *
 * - Binárias (`editMask`, `keepMask`, `removeMask`): 255 = região marcada para a
 *   ação, 0 = desmarcada; sem cinza nem alfa intermediário.
 * - `foregroundMatte`: fração visível de 0 a 255.
 *
 * Fonte e máscara usam a mesma grade nativa, dimensões e orientação, com origem
 * no canto superior esquerdo. A máscara local original, não a devolvida pelo
 * modelo, decide a proteção.
 */

export const MaskRole = z.enum(["editMask", "keepMask", "removeMask", "foregroundMatte"]);
export type MaskRole = z.infer<typeof MaskRole>;

export const BINARY_MASK_ROLES: readonly MaskRole[] = ["editMask", "keepMask", "removeMask"];

export const LocalMaskConvention = z.enum(["white_marks_black_unmarks", "coverage_0_255"]);

/** Convenção interna do inpainting: 255 edita, 0 protege. */
export const InpaintMaskConvention = z.literal("white_edits_black_preserves");

/**
 * Codificação efetivamente enviada a um provedor (registrada na tentativa).
 * Máscara em preto e branco usa branco = gerar; OpenAI Images usa alfa 0 = editar.
 */
export const RemoteMaskEncoding = z.enum(["white_edits_black_preserves", "alpha_zero_edits"]);
export type RemoteMaskEncoding = z.infer<typeof RemoteMaskEncoding>;

export const MaskDescriptor = z
  .strictObject({
    role: MaskRole,
    convention: LocalMaskConvention,
    size: Size,
    origin: z.literal("top_left"),
    fileId: Id,
  })
  .superRefine((mask, ctx) => {
    const binary = BINARY_MASK_ROLES.includes(mask.role);
    const expected = binary ? "white_marks_black_unmarks" : "coverage_0_255";
    if (mask.convention !== expected) {
      ctx.addIssue({
        code: "custom",
        message: `Máscara ${mask.role} deve usar a convenção ${expected}`,
        path: ["convention"],
      });
    }
  });
export type MaskDescriptor = z.infer<typeof MaskDescriptor>;
