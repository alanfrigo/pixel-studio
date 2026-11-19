import type { Capability, PlanOperation, ReferenceSheet } from "@/contracts";
import { genericTemporalCapabilities, isTemporalOperation } from "../animation/provider-temporal";
import { equipmentCanvas, genericEquipmentCapabilities, isEquipmentOperation } from "../equipment/provider-caps";
import { genericSceneCapabilities, isSceneOperation, sceneCanvas, sceneWantsAlpha } from "../scenes/provider-caps";
import { genericWorldCapabilities, isWorldOperation, worldCanvas } from "../world/provider-caps";
import { genericUiCapabilities, isUiOperation, uiCanvas } from "../ui/provider-caps";
import { dialogueCanvas, dialogueWantsAlpha, genericDialogueCapabilities, isDialogueOperation } from "../dialogue/provider-caps";
import type { ProviderSubmitRequest } from "./types";

/**
 * Rota genérica "imagem + referências" (OpenRouter Images e Codex CLI local).
 * O modelo recebe um prompt e referências ordenadas e devolve uma imagem; tudo
 * o que é estrutura (folha de quadros, gabarito de tileset, planta da sala,
 * máscara) vai como guia raster e é conferido localmente. Nunca declara
 * animação por esqueleto, rotação, sala ou recorte nativos.
 */

export interface GenericRoute {
  /** Máximo de imagens de entrada aceitas pela rota (0 = só texto). */
  maxReferences: number;
  /** Alfa nativo: sempre, nunca ou só com exatamente uma referência. */
  transparent: boolean | "single_reference";
}

/** Operações de animação/vistas que a rota atende só como folha desenhada por imagem + referências. */
export const SHEET_OPERATIONS: readonly PlanOperation[] = ["animate_preset", "animate_text", "animate_skeleton", "rotate_views"];

export function genericSupports(operation: PlanOperation): boolean {
  return (
    operation === "generate_asset" ||
    operation === "inpaint" ||
    SHEET_OPERATIONS.includes(operation) ||
    isWorldOperation(operation) ||
    isTemporalOperation(operation) ||
    isSceneOperation(operation) ||
    isEquipmentOperation(operation) ||
    isUiOperation(operation) ||
    isDialogueOperation(operation)
  );
}

export function genericCapabilities(operation: PlanOperation, route: GenericRoute): Capability[] {
  // Referência visual ≠ máscara nativa: com fonte + guia como referências, só "candidata + composição local".
  if (operation === "inpaint") return route.maxReferences >= 2 ? ["image_edit"] : [];
  // Animação e vistas (S1): o modelo desenha uma folha de quadros ou uma vista.
  if (SHEET_OPERATIONS.includes(operation)) return route.maxReferences >= 1 ? ["text_to_image", "image_references"] : [];
  // S3: estados, objeto, interpolação, trecho e roupa só como folha por imagem + referências; correção = candidato + recorte.
  if (isTemporalOperation(operation)) return genericTemporalCapabilities(operation, route.maxReferences);
  // Mundo (T1): material e tileset guiado pelo gabarito.
  if (isWorldOperation(operation)) return genericWorldCapabilities(operation, route.maxReferences);
  // Cenas e salas (T2): cena/plano por texto, sala pela planta como guia raster, prop.
  if (isSceneOperation(operation)) return genericSceneCapabilities(operation, route.maxReferences, route.transparent === true);
  // Equipamentos (S2): candidato vestido por imagem + referências e vista rígida por texto.
  if (isEquipmentOperation(operation)) return genericEquipmentCapabilities(route.maxReferences);
  // Kit de UI (U3): template pela guia raster e estados por imagem + referência do componente aprovado; nunca nativos.
  if (isUiOperation(operation)) return genericUiCapabilities(operation, route.maxReferences);
  // Retrato, folha de bocas e páginas de glyphs (D1): imagem + referências e guias raster; nunca retrato/visemes/fonte nativos.
  if (isDialogueOperation(operation)) return genericDialogueCapabilities(operation, route.maxReferences, route.transparent);
  if (operation !== "generate_asset") return [];
  return [
    "text_to_image",
    ...(route.maxReferences > 0 ? (["image_references"] as const) : []),
    ...(route.transparent ? (["alpha_output"] as const) : []),
  ];
}

export function genericLimits(operation: PlanOperation, route: GenericRoute): { maxReferences?: number; alphaReferences?: number } {
  const alphaRefs = route.transparent === "single_reference" ? { alphaReferences: 1 } : {};
  if (operation === "inpaint") return { maxReferences: route.maxReferences };
  if (SHEET_OPERATIONS.includes(operation) || isTemporalOperation(operation)) return { maxReferences: route.maxReferences, ...alphaRefs };
  if (isWorldOperation(operation) || isSceneOperation(operation) || isEquipmentOperation(operation) || isUiOperation(operation)) return { maxReferences: route.maxReferences };
  if (isDialogueOperation(operation)) return { maxReferences: route.maxReferences, ...(operation === "generate_portrait" ? alphaRefs : {}) };
  if (operation !== "generate_asset") return {};
  return { maxReferences: route.maxReferences, ...alphaRefs };
}

/** O pedido quer alfa nativo? Com cor-chave no plano o fundo vem pintado e é removido localmente. */
export function genericWantsAlpha(req: Pick<ProviderSubmitRequest, "operation" | "params" | "references">, route: GenericRoute): boolean {
  const params = req.params as { transparent?: boolean; backgroundKey?: string | null; sheet?: ReferenceSheet };
  const sheet = params.sheet;
  const sheetAlpha = Boolean(sheet && sheet.backgroundKey === null && (route.transparent === true || (route.transparent === "single_reference" && req.references.length === 1)));
  return (
    (req.operation === "generate_asset" && Boolean(params.transparent && !params.backgroundKey && route.transparent)) ||
    sheetAlpha ||
    (sceneWantsAlpha(req) && route.transparent === true) ||
    dialogueWantsAlpha(req, route.transparent)
  );
}

/** Material, atlas, sala e candidato vestido vão de borda a borda: rota com alfa às vezes devolve fundo transparente se não for pedido opaco. */
export function genericWantsOpaque(req: Pick<ProviderSubmitRequest, "operation">, alpha: boolean, route: GenericRoute): boolean {
  return !alpha && Boolean(route.transparent) && (isWorldOperation(req.operation) || isSceneOperation(req.operation) || isEquipmentOperation(req.operation) || isUiOperation(req.operation) || isDialogueOperation(req.operation));
}

/**
 * Canvas pedido ao modelo, quando o plano o fixa: folha de quadros (colunas ×
 * célula : linhas × célula), candidato de edição (canvas da fonte), atlas do
 * gabarito, cena/sala/prop ou tira do equipamento. `null` = livre.
 */
export function genericCanvas(req: Pick<ProviderSubmitRequest, "operation" | "params" | "references">): [number, number] | null {
  const params = req.params as { logicalSize?: [number, number]; sheet?: ReferenceSheet };
  if (params.sheet) return [params.sheet.columns * params.sheet.cell[0], params.sheet.rows * params.sheet.cell[1]];
  if (req.operation === "inpaint" && params.logicalSize) return params.logicalSize;
  return worldCanvas(req) ?? sceneCanvas(req) ?? equipmentCanvas(req) ?? uiCanvas(req) ?? dialogueCanvas(req);
}

/** Proporção reduzida, ex.: [128, 96] → "4:3". */
export function ratio([w, h]: [number, number]): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}
