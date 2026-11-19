import type { Capability, PlanOperation } from "@/contracts";
import { readPngInfo } from "@/lib/media/png";
import type { ProviderSubmitRequest } from "../providers/types";

/**
 * Capacidades do cartão S2 em rotas genéricas de imagem (OpenRouter e
 * simulado): a cobertura de roupa vai como CANDIDATO VESTIDO desenhado por
 * imagem + referências (frames da base e guia da zona autorizada) e a peça é
 * recuperada localmente por máscara explícita; a vista rígida vai por texto.
 * Nenhuma rota declara máscara nativa nem overlay modular nativo aqui.
 */

export const EQUIPMENT_OPERATIONS: readonly PlanOperation[] = ["generate_overlay_coverage"];

export function isEquipmentOperation(operation: PlanOperation): boolean {
  return EQUIPMENT_OPERATIONS.includes(operation);
}

/** Cobertura exige duas referências (frames da base + guia da zona); vista rígida, só texto. */
export function genericEquipmentCapabilities(maxReferences: number): Capability[] {
  return ["text_to_image", ...(maxReferences >= 2 ? (["image_references"] as const) : [])];
}

/** Canvas pedido: a grade da tira (pela referência de contexto) ou quadrado para a vista rígida. */
export function equipmentCanvas(req: Pick<ProviderSubmitRequest, "operation" | "params" | "references">): [number, number] | null {
  if (!isEquipmentOperation(req.operation)) return null;
  if ((req.params as { mode?: string }).mode === "rigid_view") return [1, 1];
  const context = req.references[0] ? readPngInfo(req.references[0].bytes) : null;
  return context ? [context.width, context.height] : null;
}

export const EQUIPMENT_ROUTE_LABELS = {
  dressed_candidate: "Candidato vestido por imagem + referências, peça extraída localmente com máscara explícita (rota genérica; não é máscara nativa nem overlay modular nativo)",
  rigid_view: "Vista rígida por texto, recortada e ajustada localmente (empunhaduras marcadas pelo gabarito e revisadas no editor)",
} as const;
