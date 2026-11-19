import type { PlanOperation } from "@/contracts";
import { animationPipeline } from "./animation";
import { rotateViewsPipeline } from "./animation-views";
import { inpaintPipeline } from "./inpaint";
import type { OperationPipeline } from "./types";
import { worldTexturePipeline } from "./world-texture";
import { worldTilesetPipeline } from "./world-tileset";

/**
 * Pipelines por operação do plano. `generate_asset` (ícone de item) fica no
 * próprio handler de geração; cada cartão novo registra aqui a sua operação.
 */
export const PIPELINES: Partial<Record<PlanOperation, OperationPipeline>> = {
  inpaint: inpaintPipeline,
  // Cartão S1: animação (preset, texto, esqueleto) e vistas.
  animate_preset: animationPipeline,
  animate_text: animationPipeline,
  animate_skeleton: animationPipeline,
  rotate_views: rotateViewsPipeline,
  // Cartão T1: material repetível e tileset guiado pelo gabarito.
  generate_texture: worldTexturePipeline,
  generate_tileset: worldTilesetPipeline,
};
