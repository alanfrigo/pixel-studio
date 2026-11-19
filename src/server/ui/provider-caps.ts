import type { Capability, PlanOperation } from "@/contracts";
import { readPngInfo } from "@/lib/media/png";
import type { ProviderSubmitRequest } from "../providers/types";

/**
 * Capacidades do cartão U3 em rotas genéricas de imagem (OpenRouter, OpenAI
 * Images custom, Codex CLI): nenhuma declara template nem estados de UI
 * nativos. O template exige uma referência (a guia raster do layout) e os
 * estados exigem uma referência (a folha com o componente aprovado). Sem
 * referências, a operação fica indisponível nesse perfil — nunca simulada por
 * prompt de texto.
 */

export const UI_OPERATIONS: readonly PlanOperation[] = ["generate_ui_template", "generate_ui_states"];

export function isUiOperation(operation: PlanOperation): boolean {
  return UI_OPERATIONS.includes(operation);
}

export function genericUiCapabilities(operation: PlanOperation, maxReferences: number): Capability[] {
  if (!isUiOperation(operation)) return [];
  return maxReferences >= 1 ? ["text_to_image", "image_references"] : [];
}

/** Canvas pedido ao modelo: o template no tamanho lógico; a folha de estados na proporção da guia enviada. */
export function uiCanvas(req: Pick<ProviderSubmitRequest, "operation" | "params" | "references">): [number, number] | null {
  if (req.operation === "generate_ui_template") return (req.params as { logicalSize?: [number, number] }).logicalSize ?? null;
  if (req.operation === "generate_ui_states") {
    const guide = req.references[0];
    const info = guide ? readPngInfo(guide.bytes) : null;
    return info ? [info.width, info.height] : null;
  }
  return null;
}
