import type { Capability, PlanOperation } from "@/contracts";
import { readPngInfo } from "@/lib/media/png";
import type { ProviderSubmitRequest } from "../providers/types";

/**
 * Capacidades do mundo (T1) em rotas genéricas de imagem (OpenRouter/custom):
 * material = texto (+ referências); tileset = edição a partir do gabarito
 * enviado como referência. Nunca declaram tileset nativo, isométrico nativo
 * nem emenda garantida — essas ficam para rotas especializadas qualificadas.
 */

export const WORLD_OPERATIONS: readonly PlanOperation[] = ["generate_texture", "generate_tileset"];

export function isWorldOperation(operation: PlanOperation): boolean {
  return WORLD_OPERATIONS.includes(operation);
}

export function genericWorldCapabilities(operation: PlanOperation, maxReferences: number): Capability[] {
  if (operation === "generate_texture") return ["text_to_image", ...(maxReferences > 0 ? (["image_references"] as const) : [])];
  if (operation === "generate_tileset") return maxReferences >= 1 ? ["image_references", "image_edit"] : [];
  return [];
}

/** Canvas pedido ao modelo: o atlas do gabarito (mesma grade do resultado) ou o tamanho lógico do material. */
export function worldCanvas(req: Pick<ProviderSubmitRequest, "operation" | "params" | "references">): [number, number] | null {
  if (req.operation === "generate_tileset") {
    const guide = (req.params as { guide?: { atlasSize?: [number, number] } }).guide;
    if (guide?.atlasSize) return guide.atlasSize;
    const first = req.references[0] ? readPngInfo(req.references[0].bytes) : null;
    return first ? [first.width, first.height] : null;
  }
  if (req.operation === "generate_texture") return (req.params as { logicalSize?: [number, number] }).logicalSize ?? null;
  return null;
}
