import { describe, expect, it } from "vitest";
import { MeterPayload, ScreenPayload, SlotPayload } from "@/contracts";
import { stateSheetCells, stateSheetLayout, suggestedGuides } from "./ui-geometry";
import { previewGlyph, previewMissingGlyphs, previewTextWidth } from "./ui-preview-font";
import { boxInside, focusStepForKey, gridChildren, layoutScreen, layoutText, meterFillRegion, moveFocus, rectOf, resolveCaption, slotCounterRect, starterScreen } from "./ui-screen";

/** Cartão U3: composição da tela, foco, texto, medidor e grade (mesmas rotinas da prévia e da exportação). */

const meter = MeterPayload.parse({
  logicalSize: [68, 10],
  track: { fileId: "track", rect: [0, 0, 68, 10] },
  fill: { fileId: "fill", rect: [0, 0, 64, 6], offset: [2, 2] },
  frame: { fileId: "frame", rect: [0, 0, 68, 10] },
  usefulRect: [2, 2, 64, 6],
  axis: "horizontal",
  direction: "forward",
  range: { min: 0, max: 100 },
  rounding: "floor",
  nineSlice: null,
});

const slot = SlotPayload.parse({
  logicalSize: [20, 20],
  states: [{ state: "empty", fileId: "empty", rect: [0, 0, 20, 20] }],
  requiredStates: ["empty", "occupied", "selected"],
  nineSlice: null,
  iconRect: [2, 2, 16, 16],
  counterAnchor: [18, 18],
  counterAlign: "end",
  complete: false,
});

function kitScreen() {
  return ScreenPayload.parse(
    starterScreen({
      meter: { revisionId: "meter-r1", size: [68, 10] },
      panel: { revisionId: "panel-r1" },
      portrait: { revisionId: "portrait-r1", size: [32, 32] },
      continueIndicator: { revisionId: "arrow-r1", size: [6, 4] },
      menuItems: [
        { revisionId: "continue-r1", size: [64, 14] },
        { revisionId: "inventory-r1", size: [64, 14] },
      ],
      slot: { revisionId: "slot-r1", size: [20, 20] },
      icon: { revisionId: "potion-r1" },
      background: { revisionId: "forest-r1" },
    }),
  );
}

describe("tela de UI: âncoras, grupos e ordem", () => {
  it("caixa inferior passa de 304 para 384 px mantendo as margens de 8 px", () => {
    const screen = kitScreen();
    const at320 = rectOf(layoutScreen(screen, [320, 180]), "dialogue")!;
    const at400 = rectOf(layoutScreen(screen, [400, 300]), "dialogue")!;
    expect(at320).toEqual([8, 124, 304, 48]);
    expect(at400).toEqual([8, 244, 384, 48]);
    for (const [r, w, h] of [[at320, 320, 180], [at400, 400, 300]] as const) {
      expect(r[0]).toBe(8);
      expect(w - (r[0] + r[2])).toBe(8);
      expect(h - (r[1] + r[3])).toBe(8);
    }
    // O painel nine-slice do diálogo acompanha o grupo; título e corpo continuam separados.
    expect(rectOf(layoutScreen(screen, [400, 300]), "dialogue-panel")).toEqual([8, 244, 384, 48]);
    expect(screen.instances.filter((i) => i.parentId === "dialogue").map((i) => i.role ?? "panel")).toEqual(["panel", "portrait", "title", "body", "continue_indicator"]);
    // Vida no alto à esquerda nas duas proporções.
    expect(rectOf(layoutScreen(screen, [320, 180]), "health")).toEqual([8, 8, 68, 10]);
    expect(rectOf(layoutScreen(screen, [400, 300]), "health")).toEqual([8, 8, 68, 10]);
  });

  it("ordem de desenho segue `order` entre irmãos; ocultar o grupo oculta os filhos", () => {
    const screen = kitScreen();
    const order = layoutScreen(screen, [320, 180]).filter((r) => r.instance.parentId === "root").map((r) => r.instance.instanceId);
    expect(order).toEqual(["hud", "menu", "dialogue", "inventory"]);
    const hidden = { ...screen, instances: screen.instances.map((i) => (i.instanceId === "inventory" ? { ...i, hidden: true } : i)) };
    expect(layoutScreen(hidden, [320, 180]).filter((r) => r.instance.parentId === "inventory").every((r) => !r.visible)).toBe(true);
  });

  it("inventário repete o slot em grade com espaçamento inteiro; slot fora da célula é recusado", () => {
    const screen = kitScreen();
    const slots = layoutScreen(screen, [320, 180]).filter((r) => r.instance.parentId === "inventory").map((r) => r.rect);
    expect(slots.map((r) => r[0] - slots[0]![0])).toEqual([0, 22, 44, 66]);
    expect(new Set(slots.map((r) => r[1])).size).toBe(1);
    const moved = structuredClone(screen);
    moved.instances.find((i) => i.instanceId === "slot-3")!.offsets.left += 1;
    const result = ScreenPayload.safeParse(moved);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain("slot-3 fora da célula 3 da grade");
    const group = screen.instances.find((i) => i.instanceId === "inventory")!;
    expect(gridChildren(group as never, "slot-r1", 9, "s")).toHaveLength(4);
  });
});

describe("foco por teclado", () => {
  it("percorre a ordem de foco registrada, independente da ordem de desenho, pulando desabilitado e oculto", () => {
    const screen = kitScreen();
    // Ordem de foco: menu antes do inventário, embora o inventário esteja depois no desenho.
    const res: [number, number] = [320, 180];
    let focus = moveFocus(screen, res, null, 1);
    const visited = [focus];
    for (let i = 0; i < 6; i++) visited.push((focus = moveFocus(screen, res, focus, 1)));
    expect(visited).toEqual(["menu-item-1", "menu-item-2", "slot-1", "slot-2", "slot-3", "slot-4", "menu-item-1"]);
    expect(moveFocus(screen, res, "menu-item-1", -1)).toBe("slot-4");
    const disabled = { ...screen, instances: screen.instances.map((i) => (i.instanceId === "menu-item-2" ? { ...i, overrides: { ...i.overrides, state: "disabled" as const } } : i)) };
    expect(moveFocus(disabled, res, "menu-item-1", 1)).toBe("slot-1");
    expect([focusStepForKey("Tab", false), focusStepForKey("Tab", true), focusStepForKey("ArrowDown", false), focusStepForKey("ArrowUp", false), focusStepForKey("a", false)]).toEqual([1, -1, 1, -1, 0]);
  });
});

describe("medidor", () => {
  it("0/25/100 revela 0/16/64 px do preenchimento (arredondando para baixo); moldura fica inteira", () => {
    expect(meterFillRegion(meter, 0)).toBeNull();
    expect(meterFillRegion(meter, 25)).toEqual({ src: [0, 0, 16, 6], dst: [2, 2, 16, 6] });
    expect(meterFillRegion(meter, 100)).toEqual({ src: [0, 0, 64, 6], dst: [2, 2, 64, 6] });
    expect(meterFillRegion(meter, 33)!.dst[2]).toBe(21); // floor(64 × 0,33)
    expect(meterFillRegion(meter, 250)!.dst[2]).toBe(64); // clamp
    expect(meterFillRegion({ ...meter, direction: "reverse" }, 25)).toEqual({ src: [48, 0, 16, 6], dst: [50, 2, 16, 6] });
  });
});

describe("texto do jogo", () => {
  it("legenda longa respeita a quebra ou acusa excesso; trocar idioma não toca a arte", () => {
    // Botão 32 × 16 com padding 7/7/5/5: área da legenda 18 × 6.
    const small: [number, number] = [18, 6];
    expect(layoutText("Usar", small, { wrap: "none", overflow: "report" })).toMatchObject({ overflow: false, outcome: "fits" });
    const long = layoutText("Usar poção de cura", small, { wrap: "none", overflow: "report" });
    expect(long).toMatchObject({ overflow: true, outcome: "report" });
    expect(long.needed).toEqual([previewTextWidth("Usar poção de cura"), 5]);
    expect(layoutText("Usar poção de cura", small, { wrap: "none", overflow: "grow" }).outcome).toBe("grow");
    // Redimensionar o botão para 96 × 24 (área 82 × 14) acomoda a legenda sem regenerar a arte.
    expect(layoutText("Usar poção de cura", [82, 14], { wrap: "none", overflow: "report" })).toMatchObject({ overflow: false, outcome: "fits" });
    expect(layoutText("Usar poção de cura", [56, 13], { wrap: "word", overflow: "report" })).toMatchObject({ overflow: false, lines: ["Usar poção de", "cura"] });
    expect(layoutText("Usar poção de cura", [56, 12], { wrap: "word", overflow: "report" })).toMatchObject({ overflow: true, outcome: "report" });
    const body = "A trilha some entre as árvores. Use a poção antes de seguir.";
    const paged = layoutText(body, [60, 16], { wrap: "word", overflow: "paginate" });
    expect(paged.outcome).toBe("paginate");
    expect(paged.pages.length).toBeGreaterThan(1);
    expect(paged.pages.flat().join(" ")).toBe(body);
    const cut = layoutText("Usar poção de cura", [40, 8], { wrap: "none", overflow: "ellipsis" });
    expect(cut.lines[0]!.endsWith("…")).toBe(true);
    expect(previewTextWidth(cut.lines[0]!)).toBeLessThanOrEqual(40);

    const screen = kitScreen();
    const title = screen.instances.find((i) => i.instanceId === "dialogue-title")!;
    expect(resolveCaption(title, null, screen.textCatalog, "pt-BR")).toEqual({ key: "dialogue.title", text: "Guerreira" });
    expect(resolveCaption(title, null, screen.textCatalog, "en")).toEqual({ key: "dialogue.title", text: "Warrior" });
    const swapped = { ...title, overrides: { text: "Usar poção de cura" } };
    expect(resolveCaption(swapped, null, screen.textCatalog, "en").text).toBe("Usar poção de cura");
  });

  it("fonte de prévia cobre os acentos portugueses e acusa glifo ausente", () => {
    expect(previewMissingGlyphs("Ação, Poção, Coração — ÁRVORE Inventário 0123")).toEqual([]);
    expect(previewMissingGlyphs("ß€")).toEqual(["ß", "€"]);
    expect(previewGlyph("ç").rows[7]).toBe(".#.");
    expect(previewGlyph("ã").rows.slice(0, 2)).toEqual([".##", "##."]);
  });
});

describe("slot e folha de estados", () => {
  it("contador de quantidade fica dentro do slot", () => {
    for (const q of [1, 12, 99]) expect(boxInside(slotCounterRect(slot, q), [0, 0, 20, 20])).toBe(true);
  });

  it("folha de estados fica perto de quadrada e as células não se sobrepõem", () => {
    const layout = stateSheetLayout([32, 16], 4);
    expect(layout.columns).toBe(2);
    expect(layout.rows).toBe(2);
    expect(layout.sheetSize).toEqual([8 + 2 * 40, 8 + 2 * 24]);
    expect(stateSheetCells({ cell: [32, 16], columns: layout.columns, gapPx: layout.gapPx }, 4)).toEqual(layout.cells);
    const wide = stateSheetLayout([96, 16], 5);
    expect(wide.sheetSize[0] / wide.sheetSize[1]).toBeLessThan(3);
    expect(suggestedGuides([32, 16])).toEqual({ nineSlice: { left: 4, right: 4, top: 4, bottom: 4 }, contentPadding: { left: 6, right: 6, top: 4, bottom: 4 } });
  });
});
