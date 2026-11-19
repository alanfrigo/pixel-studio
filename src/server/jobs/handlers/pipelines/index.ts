import type { PlanOperation } from "@/contracts";
import { animationPipeline } from "./animation";
import { rotateViewsPipeline } from "./animation-views";
import { inpaintPipeline } from "./inpaint";
import { equipmentPipeline } from "./equipment";
import { correctFramePipeline, editAnimationPipeline, interpolationPipeline, objectAnimationPipeline, outfitPipeline, statePipeline } from "./temporal";
import type { OperationPipeline } from "./types";
import { worldTexturePipeline } from "./world-texture";
import { worldTilesetPipeline } from "./world-tileset";
import { scenePipeline } from "./scene";
import { sceneMapObjectPipeline } from "./scene-map-object";
import { roomPipeline } from "./room";

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
  // Cartão S3: estados, objetos, interpolação, edição de trecho, roupa e correção de quadro.
  create_state: statePipeline,
  animate_object: objectAnimationPipeline,
  interpolate_frames: interpolationPipeline,
  edit_animation: editAnimationPipeline,
  transfer_outfit: outfitPipeline,
  correct_frame: correctFramePipeline,
  // Cartão T1: material repetível e tileset guiado pelo gabarito.
  generate_texture: worldTexturePipeline,
  generate_tileset: worldTilesetPipeline,
  // Cartão T2: cena plana ou plano de paralaxe, sala pela guia da planta e prop.
  generate_scene: scenePipeline,
  generate_room: roomPipeline,
  generate_map_object: sceneMapObjectPipeline,
  // Cartão S2: cobertura de roupa por frame (candidato vestido + extração local) e vista rígida.
  generate_overlay_coverage: equipmentPipeline,
};
