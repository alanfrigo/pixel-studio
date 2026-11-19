import { describe, expect, it } from "vitest";
import { colorName } from "./color-names";

describe("nomes de cor para prompts", () => {
  it.each([
    ["#14141c", "quase preto", "near black"],
    ["#f4f1e8", "branco", "white"],
    ["#3c5aa0", "azul", "blue"],
    ["#469632", "verde", "green"],
    ["#c82828", "vermelho", "red"],
    ["#7a4a20", "marrom", "brown"],
    ["#ff00ff", "magenta", "magenta"],
  ])("%s → %s / %s", (hex, pt, en) => {
    expect(colorName(hex, "pt-BR")).toBe(pt);
    expect(colorName(hex, "en")).toBe(en);
  });
});
