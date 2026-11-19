import type { CostAmount, GenerationPlan } from "@/contracts";

/**
 * Rótulo de custo para a interface: unidade do provedor em pt-BR e moeda ISO
 * com símbolo. Sem conversão entre unidades (créditos não viram dólares).
 */
export function costText(cost: CostAmount): string {
  const n = cost.amount;
  if (cost.unit === "generations") return `${n} ${n === 1 ? "geração" : "gerações"}`;
  if (cost.unit === "credits") return `${n} ${n === 1 ? "crédito" : "créditos"}`;
  if (cost.unit === "USD") return `US$ ${n}`;
  return `${n} ${cost.unit}`;
}

/** Estimativa do plano congelado: conhecida, faixa ou desconhecida (com o motivo). */
export function estimateText(plan: GenerationPlan): string {
  const e = plan.limits.estimate;
  if (e.kind === "known") return costText(e.amount);
  if (e.kind === "range") return e.min.unit === e.max.unit ? `${costText(e.min).replace(/ .*$/, "")}–${costText(e.max)}` : `${costText(e.min)} a ${costText(e.max)}`;
  return `desconhecida (${e.reason})`;
}
