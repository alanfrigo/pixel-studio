import { describe, expect, it } from "vitest";
import { DomainFailure, toDomainError } from "@/server/errors";
import { DomainError } from "@/contracts";
import { cookieValue, defineMessages, localeOf, negotiateLocale, pick, tx } from "./locales";

describe("idioma da interface", () => {
  it("cookie vence; senão Accept-Language com q; pt* → pt-BR, en* → en, resto → en", () => {
    expect(negotiateLocale("pt-BR", "en-US,en;q=0.9")).toBe("pt-BR");
    expect(negotiateLocale("xx", "pt-PT,pt;q=0.9,en;q=0.8")).toBe("pt-BR");
    expect(negotiateLocale(null, "fr-FR,en;q=0.5,pt;q=0.4")).toBe("en");
    expect(negotiateLocale(null, "en;q=0.2,pt-BR;q=0.9")).toBe("pt-BR");
    expect(negotiateLocale(undefined, "de-DE")).toBe("en");
    expect(negotiateLocale(undefined, null)).toBe("en");
    expect(cookieValue("a=1; ps-locale=pt-BR; b=2", "ps-locale")).toBe("pt-BR");
    expect(localeOf(new Request("http://x/", { headers: { cookie: "ps-locale=en", "accept-language": "pt-BR" } }))).toBe("en");
  });

  it("textos bilíngues e catálogos tipados", () => {
    expect(pick(tx("Salvar", "Save"), "en")).toBe("Save");
    expect(pick("dado antigo", "en")).toBe("dado antigo");
    expect(pick(null, "pt-BR")).toBe("");
    const m = defineMessages({ "pt-BR": { n: (k: number) => `${k} quadro${k === 1 ? "" : "s"}` }, en: { n: (k: number) => `${k} frame${k === 1 ? "" : "s"}` } });
    expect(m.en.n(2)).toBe("2 frames");
  });

  it("erro de domínio bilíngue: português em Error.message, idioma da requisição no JSON, os dois gravados", () => {
    const err = new DomainFailure("not_found", tx("Perfil não encontrado", "Profile not found"), { profileId: "x" });
    expect(err.message).toBe("Perfil não encontrado");
    expect(err.toJSON("en")).toEqual({ code: "not_found", message: "Profile not found", messages: { "pt-BR": "Perfil não encontrado", en: "Profile not found" }, details: { profileId: "x" } });
    expect(err.toJSON().message).toBe("Perfil não encontrado");
    expect(DomainError.parse(err.toJSON("en")).message).toBe("Profile not found");
    expect(new DomainFailure("internal", "só português").toJSON("en")).toEqual({ code: "internal", message: "só português" });
    expect(toDomainError(new Error("x")).toJSON("en").message).toBe("Unexpected internal error");
  });
});
