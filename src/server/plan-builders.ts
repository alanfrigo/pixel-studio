import { z } from "zod";
import type { GenerationPlan } from "@/contracts";
import { ANIMATION_PLAN_BUILDERS } from "./animation/plans";
import { buildInpaintPlan, InpaintPlanInput } from "./inpaint";
import { buildGenerationPlan, PlanInput } from "./services";
import type { Studio } from "./studio";
import { buildTexturePlan, TexturePlanInput } from "./world/textures";
import { buildTilesetPlan, TilesetPlanInput } from "./world/tilesets";

/**
 * Construtores de plano por operação para `POST /generation-plans`. Cada cartão
 * registra aqui a sua entrada (schema com `operation` literal) e o construtor,
 * que valida capacidades, fontes e custo antes de qualquer cobrança.
 */
export interface PlanBuilder {
  operation: string;
  input: z.ZodType<{ operation: string }>;
  build(studio: Studio, projectId: string, body: never): Promise<{ plan: GenerationPlan; digest: string } & Record<string, unknown>> | ({ plan: GenerationPlan; digest: string } & Record<string, unknown>);
}

export const PLAN_BUILDERS: PlanBuilder[] = [
  { operation: "generate_asset", input: PlanInput, build: (studio, projectId, body) => buildGenerationPlan(studio, projectId, body) },
  { operation: "inpaint", input: InpaintPlanInput, build: (studio, projectId, body) => buildInpaintPlan(studio, projectId, body) },
  // Cartão S1: um clique (preset), texto livre, esqueleto e vistas.
  ...ANIMATION_PLAN_BUILDERS.map((b): PlanBuilder => ({ operation: b.operation, input: b.input, build: (studio, projectId, body) => ({ ...b.build(studio, projectId, body) }) })),
  // Cartão T1: material repetível e tileset guiado pelo gabarito.
  { operation: "generate_texture", input: TexturePlanInput, build: (studio, projectId, body) => buildTexturePlan(studio, projectId, body) },
  { operation: "generate_tileset", input: TilesetPlanInput, build: (studio, projectId, body) => buildTilesetPlan(studio, projectId, body) },
];

/** União discriminada por `operation`: erro de validação aponta o campo do schema certo. */
export const PlanRequest = z.discriminatedUnion("operation", PLAN_BUILDERS.map((b) => b.input) as never) as unknown as z.ZodType<{ operation: string }>;

export async function buildPlan(studio: Studio, projectId: string, body: { operation: string }) {
  const builder = PLAN_BUILDERS.find((b) => b.operation === body.operation);
  if (!builder) throw new Error(`Sem construtor de plano para ${body.operation}`);
  return builder.build(studio, projectId, body as never);
}
