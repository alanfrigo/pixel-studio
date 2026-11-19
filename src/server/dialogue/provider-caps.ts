import type { Capability, PlanOperation } from "@/contracts";
import type { ProviderSubmitRequest } from "../providers/types";

/**
 * Capacidades do cartão D1 em rotas genéricas de imagem (OpenRouter, Codex
 * CLI e simulado). Nenhuma rota declara `portrait`, `visemes` ou `pixel_font`:
 * - retrato: imagem + referência da vista do personagem (≥ 1 referência);
 * - expressão: folha de bocas por imagem + referência do retrato e da guia (≥ 2);
 * - fonte: página de glyphs pelo gabarito (≥ 1; a extensão envia também os glyphs-base).
 */

export const DIALOGUE_OPERATIONS: readonly PlanOperation[] = ["generate_portrait", "generate_visemes", "generate_pixel_font"];

export function isDialogueOperation(operation: PlanOperation): boolean {
  return DIALOGUE_OPERATIONS.includes(operation);
}

/** Referências mínimas na rota genérica: retrato 1, expressão 2 (retrato + guia), fonte 1 (gabarito). */
export const DIALOGUE_MIN_REFERENCES: Partial<Record<PlanOperation, number>> = { generate_portrait: 1, generate_visemes: 2, generate_pixel_font: 1 };

export function genericDialogueCapabilities(operation: PlanOperation, maxReferences: number, transparent: boolean | "single_reference"): Capability[] {
  const min = DIALOGUE_MIN_REFERENCES[operation] ?? Infinity;
  if (maxReferences < min) return [];
  if (operation === "generate_portrait") return ["text_to_image", "image_references", ...(transparent ? (["alpha_output"] as const) : [])];
  // Duas referências: alfa só numa rota com alfa sempre disponível.
  if (operation === "generate_visemes") return ["text_to_image", "image_references", ...(transparent === true ? (["alpha_output"] as const) : [])];
  if (operation === "generate_pixel_font") return ["text_to_image", "image_references"];
  return [];
}

/** Canvas pedido: o retrato no tamanho lógico; a página de glyphs na grade do gabarito (a folha de visemes usa `sheet`). */
export function dialogueCanvas(req: Pick<ProviderSubmitRequest, "operation" | "params">): [number, number] | null {
  const p = req.params as { logicalSize?: [number, number]; guide?: { columns: number; rows: number; cell: [number, number] } };
  if (req.operation === "generate_portrait") return p.logicalSize ?? null;
  if (req.operation === "generate_pixel_font" && p.guide) return [p.guide.columns * p.guide.cell[0], p.guide.rows * p.guide.cell[1]];
  return null;
}

/** Retrato transparente sem cor-chave (a folha de visemes segue a regra de `sheet`; a fonte usa sempre cor-chave). */
export function dialogueWantsAlpha(req: Pick<ProviderSubmitRequest, "operation" | "params" | "references">, transparent: boolean | "single_reference"): boolean {
  if (req.operation !== "generate_portrait") return false;
  const p = req.params as { transparent?: boolean; backgroundKey?: string | null };
  return Boolean(p.transparent && !p.backgroundKey && (transparent === true || (transparent === "single_reference" && req.references.length === 1)));
}
