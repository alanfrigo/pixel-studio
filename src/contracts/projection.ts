import { z } from "zod";
import { NonNegInt, Size } from "./common";

/**
 * Direções e projeção (01, 04 §vistas, 06 §perspectivas).
 * Rotação gera arte nova por direção; nunca é obtida girando o bitmap.
 */

export const DIRECTIONS_8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export const Direction = z.enum(DIRECTIONS_8);
export type Direction = z.infer<typeof Direction>;

export const CARDINAL_4: readonly Direction[] = ["N", "E", "S", "W"];
export const DIAGONAL_4: readonly Direction[] = ["NE", "SE", "SW", "NW"];
export const SIDE_PAIR: readonly Direction[] = ["E", "W"];

function sameSet(a: readonly Direction[], b: readonly Direction[]): boolean {
  return a.length === b.length && b.every((d) => a.includes(d));
}

/**
 * Conjunto de direções aceito: uma vista, par lateral (E/W), 4 cardinais,
 * 4 diagonais (vistas projetadas do isométrico) ou as 8.
 */
export const DirectionSet = z
  .array(Direction)
  .min(1)
  .max(8)
  .superRefine((dirs, ctx) => {
    if (new Set(dirs).size !== dirs.length) {
      ctx.addIssue({ code: "custom", message: "Direções repetidas" });
      return;
    }
    const ok =
      dirs.length === 1 ||
      sameSet(dirs, SIDE_PAIR) ||
      sameSet(dirs, CARDINAL_4) ||
      sameSet(dirs, DIAGONAL_4) ||
      dirs.length === 8;
    if (!ok) {
      ctx.addIssue({
        code: "custom",
        message: "Conjunto de direções deve ser 1 vista, E/W, 4 cardinais, 4 diagonais ou 8",
      });
    }
  });
export type DirectionSet = z.infer<typeof DirectionSet>;

export const ProjectionKind = z.enum(["top_down", "three_quarter", "side", "isometric"]);
export type ProjectionKind = z.infer<typeof ProjectionKind>;

/**
 * Mapa direção no mundo → vista projetada na tela. Deve ser uma bijeção das 8
 * direções. Exemplo de referência em `domain/projection.ts`.
 */
export const WorldToViewMap = z.record(Direction, Direction).superRefine((map, ctx) => {
  const values = Object.values(map);
  if (new Set(values).size !== DIRECTIONS_8.length) {
    ctx.addIssue({ code: "custom", message: "Mapa mundo → vista deve ser uma bijeção das 8 direções" });
  }
});
export type WorldToViewMap = z.infer<typeof WorldToViewMap>;

const orthogonal = {
  /** Célula do terreno em pixels lógicos. */
  cellSize: Size,
};

export const Projection = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("top_down"),
    ...orthogonal,
    /** Inclinação visual aparente da câmera, em graus (0 = vista de cima pura). */
    tiltDeg: z.number().min(0).max(90),
  }),
  z.strictObject({
    kind: z.literal("three_quarter"),
    ...orthogonal,
    tiltDeg: z.number().min(0).max(90),
  }),
  z.strictObject({
    kind: z.literal("side"),
    ...orthogonal,
  }),
  z
    .strictObject({
      kind: z.literal("isometric"),
      /** Losango do chão `[largura, altura]`, ex.: `[64, 32]` para 2:1. */
      diamond: Size,
      elevationStepPx: NonNegInt,
      worldToView: WorldToViewMap,
    })
    .superRefine((p, ctx) => {
      if (p.diamond[0] % 2 !== 0 || p.diamond[1] % 2 !== 0) {
        ctx.addIssue({ code: "custom", message: "Losango isométrico deve ter largura e altura pares", path: ["diamond"] });
      }
    }),
]);
export type Projection = z.infer<typeof Projection>;

/** Rolagem/câmera é independente da projeção. */
export const CameraScroll = z.enum(["fixed", "free", "horizontal", "vertical"]);

export const Camera = z.strictObject({
  projection: Projection,
  directions: DirectionSet,
  scroll: CameraScroll,
});
export type Camera = z.infer<typeof Camera>;
