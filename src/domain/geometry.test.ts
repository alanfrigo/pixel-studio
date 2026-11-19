import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { attachOrigin, isoCellTop, isoWorldToView, mirrorGridPointX, mirrorPixelIndexX } from "./projection";

describe("projeção isométrica de referência (04 §isométrico)", () => {
  it("reproduz a tabela mundo → vista do plano", () => {
    expect(isoWorldToView()).toEqual({
      N: "NE",
      NE: "E",
      E: "SE",
      SE: "S",
      S: "SW",
      SW: "W",
      W: "NW",
      NW: "N",
    });
  });

  it("projeta o vértice superior do losango 64×32", () => {
    expect(isoCellTop(0, 0, [64, 32])).toEqual([0, 0]);
    expect(isoCellTop(1, 0, [64, 32])).toEqual([32, 16]);
    expect(isoCellTop(2, 1, [64, 32], [100, 10])).toEqual([132, 58]);
  });
});

describe("encaixe e espelho (04 §exemplo de encaixe)", () => {
  it("mão em (39, 34) e empunhadura em (3, 22) desenham a espada em (36, 12)", () => {
    expect(attachOrigin([39, 34], [3, 22])).toEqual([36, 12]);
  });

  it("índice de pixel espelha por W-1-x; ponto de grade por W-x", () => {
    expect(mirrorPixelIndexX(39, 64)).toBe(24);
    expect(mirrorGridPointX(32, 64)).toBe(32);
    expect(mirrorGridPointX(0, 64)).toBe(64);
  });
});

describe("JSON canônico", () => {
  it("ordena chaves, preserva arrays e ignora undefined", () => {
    expect(canonicalJson({ b: 1, a: [3, 1, { d: undefined, c: -0 }] })).toBe('{"a":[3,1,{"c":0}],"b":1}');
  });

  it("rejeita números não finitos", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});
