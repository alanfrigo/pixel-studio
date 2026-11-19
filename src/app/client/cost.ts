import type { CostAmount, GenerationPlan } from "@/contracts";
import { type Locale, pick, type TextValue } from "@/i18n/locales";
import { commonMessages } from "@/i18n/messages/common";

/**
 * Rótulo de custo para a interface: unidade do provedor no idioma da tela e
 * moeda ISO formatada pelo `Intl`. Sem conversão entre unidades (créditos não
 * viram dólares).
 */
export function costText(cost: CostAmount, locale: Locale): string {
  const m = commonMessages[locale].cost;
  const n = cost.amount;
  if (cost.unit === "generations") return m.generations(formatNumber(n, locale), n);
  if (cost.unit === "credits") return m.credits(formatNumber(n, locale), n);
  return formatMoney(n, cost.unit, locale);
}

/** Estimativa do plano congelado: conhecida, faixa ou desconhecida (com o motivo). */
export function estimateText(plan: GenerationPlan, locale: Locale): string {
  const m = commonMessages[locale].cost;
  const e = plan.limits.estimate;
  if (e.kind === "known") return costText(e.amount, locale);
  if (e.kind === "range") {
    if (e.min.unit !== e.max.unit) return m.mixedRange(costText(e.min, locale), costText(e.max, locale));
    const min = e.min.unit === "generations" || e.min.unit === "credits" ? formatNumber(e.min.amount, locale) : formatMoney(e.min.amount, e.min.unit, locale);
    return `${min}–${costText(e.max, locale)}`;
  }
  // O motivo pode vir bilíngue do servidor ou como texto gravado num idioma só.
  return m.unknown(pick(e.reason as TextValue, locale));
}

function formatNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(n);
}

function formatMoney(n: number, currency: string, locale: Locale): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 6 }).format(n);
  } catch {
    return `${formatNumber(n, locale)} ${currency}`;
  }
}
