import { describe, expect, it } from "vitest";
import { GenerationPlan, SpeechPayload, VISEME_IDS } from "@/contracts";
import { basicCodepoints, cellsFromChars, codepointsOf, coverageReport, glyphGeometry, lineMetrics, PT_KIT, pageCodepoints, requiredCoverage, sortCodepoints } from "./font";
import { DEFAULT_TIMING, isCanonicalVisemeSet, planSpeech, speechFrames, timingAtRate, visemeCompatibility } from "./visemes";

describe("regra letra → viseme letters-v1 (D1)", () => {
  it("é determinística e reproduz a mesma sequência ao reabrir", () => {
    const a = planSpeech("Olá! Vamos à floresta, Mestre?", "pt-BR");
    const b = planSpeech("Olá! Vamos à floresta, Mestre?", "pt-BR");
    expect(a).toEqual(b);
    expect(a.timeline.at(-1)).toMatchObject({ visemeId: "rest" });
    expect(a.totalMs).toBe(a.timeline.reduce((n, s) => n + s.durationMs, 0));
  });

  it("normaliza em NFC: texto decomposto gera as mesmas posições e passos", () => {
    const composed = planSpeech("Ação", "pt-BR");
    const decomposed = planSpeech("Ação", "pt-BR");
    expect(decomposed.text).toBe("Ação");
    expect(decomposed.timeline).toEqual(composed.timeline);
    // A, ç, ã, o → ai, cons, ai, o (+ repouso no fim do texto).
    expect(composed.timeline.map((s) => [s.visemeId, s.textPosition])).toEqual([
      ["ai", 0],
      ["cons", 1],
      ["ai", 2],
      ["o", 3],
      ["rest", 4],
    ]);
  });

  it("aplica dígrafos e letras mudas por idioma; pontuação vira pausa; símbolos sem regra são reportados", () => {
    const pt = planSpeech("Ninho", "pt-BR");
    expect(pt.timeline.map((s) => s.visemeId)).toEqual(["cons", "e", "cons", "o", "rest"]);
    const en = planSpeech("The phone", "en");
    expect(en.timeline.map((s) => s.visemeId)).toEqual(["cons", "e", "fv", "o", "cons", "e", "rest"]);
    const pause = planSpeech("Mm, pa.", "pt-BR");
    expect(pause.timeline.map((s) => [s.visemeId, s.durationMs])).toEqual([
      ["mbp", 2 * DEFAULT_TIMING.consonantMs],
      ["rest", DEFAULT_TIMING.pauseMs],
      ["mbp", DEFAULT_TIMING.consonantMs],
      ["ai", DEFAULT_TIMING.vowelMs],
      ["rest", DEFAULT_TIMING.stopMs],
    ]);
    const odd = planSpeech("oi 🙂", "pt-BR");
    expect(odd.unresolved).toEqual([{ char: "🙂", textPosition: 3 }]);
  });

  it("ritmo escala os parâmetros; o payload aceita o plano e a regra gravada", () => {
    const slow = timingAtRate(0.5);
    expect(slow.vowelMs).toBe(DEFAULT_TIMING.vowelMs * 2);
    const plan = planSpeech("Inventário", "pt-BR", slow);
    const payload = SpeechPayload.parse({ textKey: "npc.hello", language: "pt-BR", sampleText: plan.text, expressionRevisionId: "rev_x", timing: slow, timeline: plan.timeline });
    expect(payload.timing?.rule).toBe("letters-v1");
    const frames = speechFrames(plan.timeline);
    expect(frames[1]!.startMs).toBe(frames[0]!.durationMs);
  });

  it("troca de expressão exige os mesmos visemes na mesma ordem", () => {
    const ids = [...VISEME_IDS];
    expect(isCanonicalVisemeSet(ids)).toBe(true);
    expect(visemeCompatibility(ids, ids)).toMatchObject({ compatible: true, missing: [] });
    expect(visemeCompatibility(ids, ids.filter((v) => v !== "fv"), ["fv", "rest"])).toMatchObject({ compatible: false, missing: ["fv"] });
    expect(visemeCompatibility(ids, [...ids].reverse())).toMatchObject({ compatible: false, sameOrder: false });
  });
});

describe("fonte bitmap: cobertura, gabarito e métricas (D1)", () => {
  it("kit português exige os acentos e maiúsculas; cobertura vem dos textos do projeto", () => {
    const req = requiredCoverage("basic_pt", [{ source: "ui:inventory.use", text: "Usar poção" }, { source: "speech:npc", text: "Olá — €" }]);
    for (const cp of codepointsOf(PT_KIT)) expect(req.codepoints).toContain(cp);
    expect(req.codepoints).toContain("€".codePointAt(0));
    expect(req.sources["€".codePointAt(0)!]).toEqual(["speech:npc"]);
    expect(req.codepoints).not.toContain(0x20);
    const basic = requiredCoverage("basic", []);
    expect(basic.codepoints).not.toContain("ã".codePointAt(0));
    expect(basic.codepoints.length).toBe(basicCodepoints().length);
  });

  it("ausentes são listados, nunca substituídos", () => {
    const report = coverageReport({ glyphs: codepointsOf("Acao").map((cp) => ({ codepoint: cp, fileId: "p", rect: [0, 0, 1, 1], bearingX: 0, bearingY: -1, advanceX: 2, origin: "generated" })) }, codepointsOf("Ação"));
    expect(report).toMatchObject({ complete: false, missing: codepointsOf("çã"), missingLabels: ["U+00E7 (ç)", "U+00E3 (ã)"] });
  });

  it("célula do gabarito acomoda acento acima e descendente abaixo; páginas de 8 × 4", () => {
    expect(glyphGeometry(8)).toEqual({ capHeight: 8, cell: [12, 15], baselineY: 12, padLeft: 1, accentSpace: 4, descender: 3 });
    const pages = pageCodepoints([...basicCodepoints(), ...codepointsOf(PT_KIT)]);
    expect(pages.every((p) => p.codepoints.length <= 32)).toBe(true);
    expect(pages[0]!.codepoints.slice(0, 3)).toEqual(codepointsOf("ABC"));
    expect(pages.flatMap((p) => p.codepoints)).toEqual(sortCodepoints([...basicCodepoints(), ...codepointsOf(PT_KIT)]));
    expect(cellsFromChars("AB C")).toEqual([65, 66, null, 67]);
  });

  it("métricas de linha: ascent pelo glyph mais alto (Á), descent pelo mais fundo (g), baseline = ascent", () => {
    const m = lineMetrics([{ bearingY: -8, rect: [0, 0, 5, 8] }, { bearingY: -11, rect: [0, 0, 5, 11] }, { bearingY: -6, rect: [0, 0, 5, 8] }], 8);
    expect(m).toEqual({ ascent: 11, descent: 2, lineHeight: 14, spaceAdvance: 4, baseline: 11 });
  });

  it("plano de fonte na rota genérica exige páginas = partes e cobertura exata; sem gabarito exige pixel_font", () => {
    const pages = pageCodepoints(codepointsOf("AÁ"));
    const base = {
      planVersion: 1,
      projectId: "p",
      operation: "generate_pixel_font",
      styleRevisionId: "s",
      recipeRevisionId: "r",
      providerProfileId: "simulated",
      prompt: { brief: "", compiled: "x", language: "pt-BR" },
      sources: [],
      requiredCapabilities: ["image_references"],
      parts: pages.map((p) => ({ partKey: p.partKey, unit: "glyph_set", label: "x" })),
      limits: { maxSubmissions: 1, costCeiling: null, estimate: { kind: "unknown", reason: "x" } },
      params: { weight: "regular", glyphSize: 8, requiredCodepoints: codepointsOf("AÁ"), guide: { mode: "base", cell: [10, 14], columns: 8, rows: 4, baselineY: 11, padLeft: 1, capHeight: 8, tracking: 1, backgroundKey: "#ff00ff", inkColor: "#ffffff", pages, baseRevisionId: null } },
    };
    expect(GenerationPlan.safeParse(base).success).toBe(true);
    const wrong = { ...base, params: { ...base.params, requiredCodepoints: codepointsOf("AÁB") } };
    expect(GenerationPlan.safeParse(wrong).error?.issues.map((i) => i.message)).toContain("As páginas cobrem exatamente os codepoints pedidos, sem repetição");
    const native = { ...base, params: { weight: "regular", glyphSize: 8, requiredCodepoints: [65] } };
    expect(GenerationPlan.safeParse(native).error?.issues.map((i) => i.message)).toContain("Operação generate_pixel_font exige a capacidade pixel_font");
  });
});
