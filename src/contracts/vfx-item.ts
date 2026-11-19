import { z } from "zod";
import { checkUnique, DurationMs, GridPoint, gridPointInside, Id, Offset, Rect, rectFits, Size, Slug } from "./common";

/**
 * VFX e itens (02a §formato portátil, 04 §VFX, 01 §famílias).
 * `sourceOffset` posiciona a região recortada dentro da célula lógica original;
 * a composição usa a célula lógica mesmo com trimming.
 */

export const SequenceFrame = z
  .strictObject({
    frameId: Id,
    /** `null` com `rect: null` declara quadro vazio intencional. */
    fileId: Id.nullable(),
    rect: Rect.nullable(),
    sourceOffset: Offset,
    durationMs: DurationMs,
  })
  .superRefine((frame, ctx) => {
    if ((frame.fileId === null) !== (frame.rect === null)) {
      ctx.addIssue({ code: "custom", message: "fileId e rect devem ser ambos nulos (quadro vazio) ou ambos preenchidos" });
    }
  });
export type SequenceFrame = z.infer<typeof SequenceFrame>;

export const BlendMode = z.enum(["normal", "additive", "multiply", "screen"]);

export const VfxPayload = z
  .strictObject({
    logicalSize: Size,
    /** Pivô de emissão, ponto da grade lógica. */
    pivot: GridPoint,
    loop: z.boolean(),
    blendMode: BlendMode,
    /** Política de alfa; VFX pode preservar alfa parcial. */
    alpha: z.enum(["binary", "partial"]).optional(),
    frames: z.array(SequenceFrame).min(1).max(256),
  })
  .superRefine((vfx, ctx) => {
    checkUnique(ctx, vfx.frames, (f) => f.frameId, "Frame", ["frames"]);
    if (!gridPointInside(vfx.pivot, vfx.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Pivô fora da célula", path: ["pivot"] });
    }
    vfx.frames.forEach((frame, i) => {
      if (frame.rect && !rectFits(frame.rect, frame.sourceOffset, vfx.logicalSize)) {
        ctx.addIssue({ code: "custom", message: "Frame não cabe na célula lógica", path: ["frames", i] });
      }
    });
  });
export type VfxPayload = z.infer<typeof VfxPayload>;

export const ItemRepresentation = z
  .strictObject({
    /** `icon` no inventário, `world` no chão do mapa. */
    role: z.enum(["icon", "world"]),
    /** Ex.: `default`, `full`, `empty`. */
    state: Slug,
    fileId: Id,
    rect: Rect,
    sourceOffset: Offset,
    logicalSize: Size,
    pivot: GridPoint,
  })
  .superRefine((rep, ctx) => {
    if (!rectFits(rep.rect, rep.sourceOffset, rep.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Imagem não cabe no tamanho lógico", path: ["rect"] });
    }
    if (!gridPointInside(rep.pivot, rep.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Pivô fora do tamanho lógico", path: ["pivot"] });
    }
  });

export const ItemPayload = z
  .strictObject({
    /** Mesmo ID de item liga ícone, representação no chão e peça equipada. */
    itemKey: Slug,
    representations: z.array(ItemRepresentation).min(1),
  })
  .superRefine((item, ctx) => {
    checkUnique(ctx, item.representations, (r) => `${r.role}/${r.state}`, "Representação", ["representations"]);
  });
export type ItemPayload = z.infer<typeof ItemPayload>;
