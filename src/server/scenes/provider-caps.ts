import type { Capability, PlanOperation } from "@/contracts";
import type { ProviderSubmitRequest } from "../providers/types";

/**
 * Capacidades do cartão T2 em rotas genéricas de imagem: cena plana ou um
 * plano por vez (texto + referências), sala pela planta como guia raster
 * (exige ao menos uma referência) e prop com alfa ou cor-chave. Recorte de
 * móveis e kit são locais, sem capacidade de provedor.
 */

export const SCENE_OPERATIONS: readonly PlanOperation[] = ["generate_scene", "generate_room", "generate_map_object"];

export function isSceneOperation(operation: PlanOperation): boolean {
  return SCENE_OPERATIONS.includes(operation);
}

export function genericSceneCapabilities(operation: PlanOperation, maxReferences: number, alpha: boolean): Capability[] {
  const refs: Capability[] = maxReferences > 0 ? ["image_references"] : [];
  const transparency: Capability[] = alpha ? ["alpha_output"] : [];
  if (operation === "generate_scene") return ["text_to_image", ...refs, ...transparency];
  if (operation === "generate_room") return maxReferences >= 1 ? ["text_to_image", "image_references"] : [];
  if (operation === "generate_map_object") return ["text_to_image", ...transparency];
  return [];
}

/** Canvas pedido ao modelo: a cena/plano, a imagem da sala na grade declarada ou o prop. */
export function sceneCanvas(req: Pick<ProviderSubmitRequest, "operation" | "params">): [number, number] | null {
  const p = req.params as { logicalSize?: [number, number]; guide?: { pictureSize?: [number, number] } };
  if (req.operation === "generate_room") return p.guide?.pictureSize ?? null;
  if (req.operation === "generate_scene" || req.operation === "generate_map_object") return p.logicalSize ?? null;
  return null;
}

/** O plano pede alfa nativo (plano transparente ou prop) sem cor-chave? */
export function sceneWantsAlpha(req: Pick<ProviderSubmitRequest, "operation" | "params">): boolean {
  const p = req.params as { layer?: { transparent?: boolean }; transparent?: boolean; backgroundKey?: string | null };
  if (p.backgroundKey) return false;
  if (req.operation === "generate_scene") return Boolean(p.layer?.transparent);
  if (req.operation === "generate_map_object") return Boolean(p.transparent);
  return false;
}
