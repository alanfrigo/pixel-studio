import type { Capability, PlanOperation } from "@/contracts";
import { createImage, getPixel, type Rgba, type RgbaImage, setPixel } from "@/lib/media/png";
import { decodePng, encodePngDeflate } from "../equipment/png";
import type { ProviderSubmitRequest } from "../providers/types";
import { isDialogueOperation } from "./provider-caps";

/**
 * Respostas do provedor SIMULADO para o cartão D1 (identificadas como
 * simuladas na interface), para ensaiar fila, processamento local, revisão e
 * exportação sem custo:
 * - retrato: busto com as cores da vista do personagem recebida;
 * - expressão: o retrato recebido repetido na grade, só a boca muda por viseme;
 * - fonte: tinta onde o gabarito tem a letra-fantasma. Na folha-BASE o
 *   simulado deixa vazias as células fora do ASCII (simula um modelo que
 *   ignora acentos), o que exercita a política de glyph ausente e a extensão.
 * Tudo devolvido em 2× para exercitar a redução à grade lógica.
 */

export interface SimulatedDialogueJob {
  /** PNG da resposta em base64. */
  png: string;
}

export function simulatedDialogueCapabilities(operation: PlanOperation): Capability[] {
  if (operation === "generate_portrait" || operation === "generate_visemes") return ["text_to_image", "image_references", "alpha_output"];
  if (operation === "generate_pixel_font") return ["text_to_image", "image_references"];
  return [];
}

const hexRgba = (hex: string): Rgba => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];

function upscale(img: RgbaImage, k: number): RgbaImage {
  const out = createImage(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) setPixel(out, x, y, getPixel(img, Math.floor(x / k), Math.floor(y / k)));
  return out;
}

/** Amostra a referência (possivelmente ampliada por fator inteiro) na grade lógica pedida. */
function sampleTo(img: RgbaImage, [w, h]: [number, number]): RgbaImage {
  const kx = img.width / w;
  const ky = img.height / h;
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(out, x, y, getPixel(img, Math.floor(x * kx + kx / 2), Math.floor(y * ky + ky / 2)));
  return out;
}

function opaqueColors(img: RgbaImage): Rgba[] {
  const counts = new Map<string, { c: Rgba; n: number }>();
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] < 128) continue;
      const k = c.slice(0, 3).join(",");
      const e = counts.get(k) ?? { c: [c[0], c[1], c[2], 255], n: 0 };
      e.n += 1;
      counts.set(k, e);
    }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((e) => e.c);
}

const luma = (c: Rgba) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;

function fillBackground(img: RgbaImage, key: string | null | undefined) {
  if (!key) return;
  const k = hexRgba(key);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (getPixel(img, x, y)[3] < 128) setPixel(img, x, y, k);
}

function simulatedPortrait(request: ProviderSubmitRequest): RgbaImage {
  const p = request.params as { logicalSize: [number, number]; transparent?: boolean; backgroundKey?: string | null };
  const [w, h] = p.logicalSize;
  const ref = request.references[0] ? decodePng(request.references[0].bytes) : createImage(1, 1);
  const colors = opaqueColors(ref);
  const fallback: Rgba[] = [[60, 90, 170, 255], [230, 180, 140, 255], [90, 50, 30, 255]];
  const [body, skin, hair] = [colors[0] ?? fallback[0]!, colors[1] ?? fallback[1]!, colors[2] ?? fallback[2]!];
  const dark = [...colors, ...fallback].sort((a, b) => luma(a) - luma(b))[0]!;
  const img = createImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (y >= h * 0.72 && x >= w * 0.15 && x < w * 0.85) setPixel(img, x, y, body);
      const dx = (x - w * 0.5) / (w * 0.24);
      const dy = (y - h * 0.42) / (h * 0.28);
      if (dx * dx + dy * dy <= 1) setPixel(img, x, y, y < h * 0.25 ? hair : skin);
    }
  for (const ex of [0.42, 0.58]) setPixel(img, Math.round(w * ex), Math.round(h * 0.4), dark);
  for (let x = Math.round(w * 0.46); x <= Math.round(w * 0.54); x++) setPixel(img, x, Math.round(h * 0.54), dark);
  if (!(p.transparent && !p.backgroundKey)) fillBackground(img, p.backgroundKey ?? "#ff00ff");
  return img;
}

/** Boca de cada viseme dentro da região declarada (pixels escuros e dentes claros). */
function drawMouth(img: RgbaImage, ox: number, oy: number, mouth: [number, number, number, number], viseme: string, skin: Rgba, dark: Rgba, happy: boolean) {
  const [mx, my, mw, mh] = mouth;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) setPixel(img, ox + mx + x, oy + my + y, skin);
  const cx = mx + Math.floor(mw / 2);
  const mid = my + Math.floor(mh / 2);
  const line = (x0: number, x1: number, y: number, c: Rgba = dark) => {
    for (let x = x0; x <= x1; x++) if (x >= mx && x < mx + mw && y >= my && y < my + mh) setPixel(img, ox + x, oy + y, c);
  };
  const half = Math.max(1, Math.floor(mw * 0.3));
  const teeth: Rgba = [240, 240, 240, 255];
  switch (viseme) {
    case "ai":
      for (let y = my; y < my + mh; y++) line(cx - half, cx + half - 1, y);
      break;
    case "e":
      line(mx, mx + mw - 1, mid);
      line(cx - half, cx + half - 1, mid + 1);
      break;
    case "o":
      for (let y = my; y < my + mh; y++) line(cx - 1, cx, y);
      break;
    case "u":
      line(cx - 1, cx, mid);
      break;
    case "mbp":
      line(cx - half, cx + half - 1, mid);
      line(cx - half, cx + half - 1, mid - 1);
      break;
    case "fv":
      line(cx - half, cx + half - 1, mid);
      line(cx - half + 1, cx + half - 2, mid + 1, teeth);
      break;
    case "cons":
      line(cx - half, cx + half - 1, mid);
      line(cx - half, cx + half - 1, mid - 1, teeth);
      break;
    default:
      line(cx - half, cx + half - 1, mid);
  }
  if (happy) {
    line(cx - half - 1, cx - half - 1, mid - 1);
    line(cx + half, cx + half, mid - 1);
  }
}

function simulatedVisemes(request: ProviderSubmitRequest): RgbaImage | null {
  const p = request.params as { expressionKey: string; mouthRect?: [number, number, number, number]; sheet?: { columns: number; rows: number; cell: [number, number]; backgroundKey: string | null; frameIds: string[] } };
  const portraitRef = request.references.find((r) => r.role === "identity");
  if (!p.sheet || !p.mouthRect || !portraitRef) return null;
  const [cw, ch] = p.sheet.cell;
  const portrait = sampleTo(decodePng(portraitRef.bytes), [cw, ch]);
  const colors = opaqueColors(portrait);
  const dark = [...colors].sort((a, b) => luma(a) - luma(b))[0] ?? [20, 20, 28, 255];
  const [mx, my, , mh] = p.mouthRect;
  const skin = getPixel(portrait, Math.max(0, mx - 1), my + Math.floor(mh / 2));
  const happy = /happy|feliz|alegre|joy/.test(p.expressionKey);
  const sheet = createImage(p.sheet.columns * cw, p.sheet.rows * ch);
  p.sheet.frameIds.forEach((id, i) => {
    const ox = (i % p.sheet!.columns) * cw;
    const oy = Math.floor(i / p.sheet!.columns) * ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) setPixel(sheet, ox + x, oy + y, getPixel(portrait, x, y));
    drawMouth(sheet, ox, oy, p.mouthRect!, id, skin[3] >= 128 ? skin : [230, 180, 140, 255], dark, happy);
  });
  fillBackground(sheet, p.sheet.backgroundKey);
  return sheet;
}

const GHOST: Rgba = [140, 140, 140, 255];

function simulatedGlyphs(request: ProviderSubmitRequest): RgbaImage | null {
  const p = request.params as {
    guide?: { mode: "base" | "extend"; columns: number; rows: number; cell: [number, number]; backgroundKey: string; inkColor: string; pages: { partKey: string; codepoints: number[] }[] };
  };
  const guideRef = request.references.at(-1);
  if (!p.guide || !guideRef) return null;
  const g = p.guide;
  const partKey = request.idempotencyKey.slice(request.idempotencyKey.indexOf(":") + 1);
  const page = g.pages.find((pg) => pg.partKey === partKey) ?? g.pages[0]!;
  const guide = decodePng(guideRef.bytes);
  const [w, h] = [g.columns * g.cell[0], g.rows * g.cell[1]];
  const k = guide.width / w;
  const out = createImage(w, h);
  const ink = hexRgba(g.inkColor);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const cell = Math.floor(y / g.cell[1]) * g.columns + Math.floor(x / g.cell[0]);
      const cp = page.codepoints[cell];
      if (cp === undefined || (g.mode === "base" && cp > 0x7f)) continue;
      const c = getPixel(guide, Math.floor(x * k + k / 2), Math.floor(y * k + k / 2));
      if (c[0] === GHOST[0] && c[1] === GHOST[1] && c[2] === GHOST[2]) setPixel(out, x, y, ink);
    }
  fillBackground(out, g.backgroundKey);
  return out;
}

export function simulatedDialogueJob(request: ProviderSubmitRequest): SimulatedDialogueJob | null {
  if (!isDialogueOperation(request.operation)) return null;
  const img =
    request.operation === "generate_portrait" ? simulatedPortrait(request) : request.operation === "generate_visemes" ? simulatedVisemes(request) : simulatedGlyphs(request);
  if (!img) return null;
  return { png: Buffer.from(encodePngDeflate(upscale(img, 2))).toString("base64") };
}
