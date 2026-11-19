import { createHash } from "node:crypto";
import type { UiState, UiStateSheet } from "@/contracts";
import { stateSheetCells } from "@/domain/ui-geometry";
import { createImage, getPixel, type Rgba, type RgbaImage, setPixel } from "@/lib/media/png";
import { decodePng, encodePngDeflate } from "../equipment/png";
import type { ProviderSubmitRequest } from "../providers/types";

/**
 * Respostas do provedor SIMULADO para o cartão U3, identificadas como
 * simuladas na interface. Mesmo comportamento de uma rota genérica: o
 * template é pintado sobre as células da guia (fundo de cor-chave) e os
 * estados repetem a peça da célula 1 da folha recebida, com variações de luz.
 * Nada aqui é declarado como template ou estado nativo.
 */

export interface SimulatedUiJob {
  /** PNG pronto (base64), calculado no envio. */
  png: string;
}

interface TemplateCellParams {
  localId: string;
  componentType: string;
  cell?: [number, number, number, number];
  meterPart?: "track" | "fill" | "frame";
}

const OUTLINE: Rgba = [24, 24, 30, 255];
const COPPER: Rgba = [184, 115, 51, 255];

function hexRgba(hex: string): Rgba {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
}

function scale(img: RgbaImage, k: number): RgbaImage {
  const out = createImage(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) setPixel(out, x, y, getPixel(img, Math.floor(x / k), Math.floor(y / k)));
  return out;
}

/** Peça de metal: contorno escuro, filete de cobre de 1 px, cantos chanfrados e centro uniforme. */
function drawPiece(img: RgbaImage, [x0, y0, w, h]: [number, number, number, number], metal: Rgba, kind: string, key: Rgba) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      const corner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
      let color: Rgba = edge === 0 ? OUTLINE : edge === 1 ? COPPER : metal;
      if (kind === "fill") color = edge === 0 ? [120, 20, 30, 255] : y === 1 ? [240, 90, 90, 255] : [200, 40, 50, 255];
      if (kind === "track") color = edge === 0 ? OUTLINE : [44, 34, 36, 255];
      if (kind === "frame") color = edge === 0 ? OUTLINE : edge === 1 ? COPPER : key;
      if (kind === "slot" && edge >= 2) color = [Math.max(0, metal[0] - 40), Math.max(0, metal[1] - 40), Math.max(0, metal[2] - 36), 255];
      setPixel(img, x0 + x, y0 + y, corner && kind !== "fill" ? key : color);
    }
  }
}

function templateImage(params: { logicalSize: [number, number]; requestedComponents: TemplateCellParams[]; guide?: { backgroundKey: string } }, prompt: string): Uint8Array {
  const [w, h] = params.logicalSize;
  const key = hexRgba(params.guide?.backgroundKey ?? "#ff00ff");
  const d = createHash("sha256").update(prompt).digest();
  const metal: Rgba = [70 + (d[0]! % 40), 70 + (d[1]! % 40), 84 + (d[2]! % 40), 255];
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, key);
  for (const c of params.requestedComponents) {
    if (!c.cell) continue;
    drawPiece(img, c.cell, metal, c.meterPart ?? c.componentType, key);
  }
  // Modelos devolvem mais resolução que a grade lógica: 2× por vizinho mais próximo.
  return encodePngDeflate(scale(img, 2));
}

/** Variação de luz por estado, preservando contorno (anel de 1 px) e a cor-chave. */
function stateColor(state: UiState, c: Rgba): Rgba {
  const mix = (t: Rgba, k: number): Rgba => [Math.round(c[0] + (t[0] - c[0]) * k), Math.round(c[1] + (t[1] - c[1]) * k), Math.round(c[2] + (t[2] - c[2]) * k), c[3]];
  switch (state) {
    case "hover":
      return mix([255, 255, 255, 255], 0.25);
    case "pressed":
    case "occupied":
      return mix([0, 0, 0, 255], 0.25);
    case "disabled": {
      const y = Math.round((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) * 0.7);
      return [y, y, y, c[3]];
    }
    case "selected":
      return mix([255, 214, 0, 255], 0.35);
    default:
      return c;
  }
}

function sameRgb(a: Rgba, b: Rgba): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function statesImage(sheets: UiStateSheet[], guideBytes: Uint8Array, key: Rgba): Uint8Array {
  const guide = decodePng(guideBytes);
  // A guia é a folha ampliada por fator inteiro; acha a folha deste envio pelo tamanho.
  const sheet = sheets.find((s) => guide.width % s.sheetSize[0] === 0 && guide.width / s.sheetSize[0] === guide.height / s.sheetSize[1]) ?? sheets[0]!;
  const k = Math.max(1, Math.round(guide.width / sheet.sheetSize[0]));
  const [sw, sh] = sheet.sheetSize;
  const out = createImage(sw, sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) setPixel(out, x, y, key);
  const cells = stateSheetCells(sheet, sheet.states.length + 1);
  const [bx, by, cw, ch] = cells[0]!;
  const base = (x: number, y: number) => getPixel(guide, (bx + x) * k, (by + y) * k);
  const isKey = (x: number, y: number) => x < 0 || y < 0 || x >= cw || y >= ch || sameRgb(base(x, y), key);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) setPixel(out, bx + x, by + y, base(x, y));
  sheet.states.forEach((state, i) => {
    const [ox, oy] = cells[i + 1]!;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (isKey(x, y)) continue;
        const edge = isKey(x - 1, y) || isKey(x + 1, y) || isKey(x, y - 1) || isKey(x, y + 1);
        // "Afundado": o miolo desce 1 px dentro do contorno.
        const src = state === "pressed" && !edge && !isKey(x, y - 1) && y > 1 ? base(x, y - 1) : base(x, y);
        setPixel(out, ox + x, oy + y, edge ? base(x, y) : stateColor(state, src));
      }
    }
  });
  return encodePngDeflate(scale(out, 2));
}

/** Prepara a resposta simulada no envio (o "servidor remoto" guarda só o PNG). */
export function simulatedUiJob(request: Pick<ProviderSubmitRequest, "operation" | "prompt" | "params" | "references">): SimulatedUiJob | null {
  if (request.operation === "generate_ui_template") {
    return { png: Buffer.from(templateImage(request.params as never, request.prompt)).toString("base64") };
  }
  if (request.operation === "generate_ui_states") {
    const p = request.params as { sheets?: UiStateSheet[]; backgroundKey?: string };
    const guide = request.references[0];
    if (!p.sheets?.length || !guide) return null;
    return { png: Buffer.from(statesImage(p.sheets, guide.bytes, hexRgba(p.backgroundKey ?? "#ff00ff"))).toString("base64") };
  }
  return null;
}
