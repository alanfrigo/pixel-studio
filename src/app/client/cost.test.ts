import { describe, expect, it } from "vitest";
import type { CostEstimate, GenerationPlan } from "@/contracts";
import { tx } from "@/i18n/locales";
import { costText, estimateText } from "./cost";

const plan = (estimate: CostEstimate) => ({ limits: { estimate } }) as unknown as GenerationPlan;

describe("rótulos de custo", () => {
  it("unidades do provedor com plural nos dois idiomas", () => {
    expect(costText({ amount: 1, unit: "generations" }, "en")).toBe("1 generation");
    expect(costText({ amount: 3, unit: "generations" }, "en")).toBe("3 generations");
    expect(costText({ amount: 1, unit: "generations" }, "pt-BR")).toBe("1 geração");
    expect(costText({ amount: 2, unit: "generations" }, "pt-BR")).toBe("2 gerações");
    expect(costText({ amount: 1, unit: "credits" }, "en")).toBe("1 credit");
    expect(costText({ amount: 2.5, unit: "credits" }, "pt-BR")).toBe("2,5 créditos");
  });

  it("moeda ISO formatada pelo idioma, sem arredondar centavos fracionados", () => {
    expect(costText({ amount: 0.04, unit: "USD" }, "en")).toBe("$0.04");
    expect(costText({ amount: 0.0035, unit: "USD" }, "en")).toBe("$0.0035");
    expect(costText({ amount: 0.04, unit: "USD" }, "pt-BR")).toMatch(/^US\$\s0,04$/);
  });

  it("estimativas conhecida, faixa e desconhecida", () => {
    const known = plan({ kind: "known", amount: { amount: 2, unit: "generations" }, basis: "2 imagens" });
    expect(estimateText(known, "en")).toBe("2 generations");
    expect(estimateText(known, "pt-BR")).toBe("2 gerações");

    const range = plan({ kind: "range", min: { amount: 2, unit: "generations" }, max: { amount: 4, unit: "generations" }, basis: "x" });
    expect(estimateText(range, "en")).toBe("2–4 generations");
    expect(estimateText(range, "pt-BR")).toBe("2–4 gerações");

    const money = plan({ kind: "range", min: { amount: 0.04, unit: "USD" }, max: { amount: 0.08, unit: "USD" }, basis: "x" });
    expect(estimateText(money, "en")).toBe("$0.04–$0.08");

    const mixed = plan({ kind: "range", min: { amount: 1, unit: "credits" }, max: { amount: 0.5, unit: "USD" }, basis: "x" });
    expect(estimateText(mixed, "en")).toBe("1 credit to $0.50");
    expect(estimateText(mixed, "pt-BR")).toMatch(/^1 crédito a US\$\s0,50$/);

    const unknown = plan({ kind: "unknown", reason: "sem preço no perfil" });
    expect(estimateText(unknown, "en")).toBe("unknown (sem preço no perfil)");
    expect(estimateText(unknown, "pt-BR")).toBe("desconhecida (sem preço no perfil)");

    // Motivo bilíngue vindo do servidor: escolhe o idioma da tela.
    const bilingual = plan({ kind: "unknown", reason: tx("sem preço no perfil", "no price in the profile") as unknown as string });
    expect(estimateText(bilingual, "en")).toBe("unknown (no price in the profile)");
    expect(estimateText(bilingual, "pt-BR")).toBe("desconhecida (sem preço no perfil)");
  });
});
