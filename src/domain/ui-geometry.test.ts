import { describe, expect, it } from "vitest";
import { anchoredRect, contentArea, meterFill, minimumSize, nineSlice } from "./ui-geometry";

const insets = { left: 4, right: 4, top: 4, bottom: 4 };
const padding = { left: 7, right: 7, top: 5, bottom: 5 };

describe("nine-slice (07 §dimensões, aceite U2)", () => {
  it("botão 32×16 desenhado em 96×24 mantém os quatro cantos 4×4 e estica só bordas e centro", () => {
    const pieces = nineSlice([32, 16], insets, [96, 24]);
    const corners = pieces.filter((p) => p.zone === "corner");
    expect(corners.map((p) => p.dst)).toEqual([
      [0, 0, 4, 4],
      [92, 0, 4, 4],
      [0, 20, 4, 4],
      [92, 20, 4, 4],
    ]);
    expect(corners.every((p) => p.src[2] === p.dst[2] && p.src[3] === p.dst[3])).toBe(true);
    expect(pieces.find((p) => p.zone === "center")).toEqual({ zone: "center", src: [4, 4, 24, 8], dst: [4, 4, 88, 16] });
    expect(pieces.reduce((n, p) => n + p.dst[2] * p.dst[3], 0)).toBe(96 * 24); // cobre tudo sem sobreposição
  });

  it("no tamanho original é a identidade", () => {
    for (const p of nineSlice([32, 16], insets, [32, 16])) expect(p.dst).toEqual(p.src);
  });

  it("recusa tamanho que não preserva os cantos", () => {
    expect(minimumSize(insets)).toEqual([9, 9]);
    expect(() => nineSlice([32, 16], insets, [8, 16])).toThrow(/mínimo 9×9/);
    expect(() => nineSlice([8, 8], insets, [32, 32])).toThrow(/área central/);
  });
});

describe("área de conteúdo", () => {
  it("a legenda usa a área interna em 32×16 e 96×24", () => {
    expect(contentArea([32, 16], padding)).toEqual([7, 5, 18, 6]);
    expect(contentArea([96, 24], padding)).toEqual([7, 5, 82, 14]);
    expect(() => contentArea([14, 16], padding)).toThrow(/área útil/);
  });
});

describe("medidor (07 §medidor)", () => {
  const useful: [number, number, number, number] = [2, 2, 64, 6];
  it("25/100 revela os primeiros 16 px; 0 e 100 nos extremos; fora da faixa satura", () => {
    expect(meterFill(25, { min: 0, max: 100 }, useful, "horizontal", "forward")).toEqual([2, 2, 16, 6]);
    expect(meterFill(0, { min: 0, max: 100 }, useful, "horizontal", "forward")).toEqual([2, 2, 0, 6]);
    expect(meterFill(100, { min: 0, max: 100 }, useful, "horizontal", "forward")).toEqual([2, 2, 64, 6]);
    expect(meterFill(150, { min: 0, max: 100 }, useful, "horizontal", "forward")).toEqual([2, 2, 64, 6]);
    expect(meterFill(33, { min: 0, max: 100 }, useful, "horizontal", "forward")[2]).toBe(21); // arredonda para baixo
    expect(meterFill(25, { min: 0, max: 100 }, useful, "horizontal", "reverse")).toEqual([50, 2, 16, 6]);
    expect(() => meterFill(1, { min: 5, max: 5 }, useful, "horizontal", "forward")).toThrow();
  });
});

describe("âncoras (07 §composição)", () => {
  it("caixa inferior com âncoras 0/1 e offsets +8/−8 mantém 8 px de margem em 320 e 400 de largura", () => {
    const anchors = { left: 0, top: 1, right: 1, bottom: 1 };
    const offsets = { left: 8, top: -48, right: -8, bottom: -8 };
    expect(anchoredRect([0, 0, 320, 180], anchors, offsets)).toEqual([8, 132, 304, 40]);
    expect(anchoredRect([0, 0, 400, 300], anchors, offsets)).toEqual([8, 252, 384, 40]);
  });
});
