import { describe, expect, it } from "vitest";
import { tx } from "@/i18n/locales";
import { errorMessage, formatBytes } from "./api";

describe("textos de erro gravados e tamanhos", () => {
  it("prefere messages[idioma]; dado antigo só com message passa como está", () => {
    const bilingual = { code: "internal", message: "Erro interno inesperado", messages: tx("Erro interno inesperado", "Unexpected internal error") };
    expect(errorMessage(bilingual, "en")).toBe("Unexpected internal error");
    expect(errorMessage(bilingual, "pt-BR")).toBe("Erro interno inesperado");
    expect(errorMessage({ code: "x", message: "só português" }, "en")).toBe("só português");
    expect(errorMessage({ message: tx("a", "b") }, "en")).toBe("b");
    expect(errorMessage(null, "en")).toBeNull();
    expect(errorMessage({}, "en")).toBeNull();
  });

  it("bytes com o separador decimal do idioma", () => {
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(1536, "pt-BR")).toBe("1,5 KB");
  });
});
