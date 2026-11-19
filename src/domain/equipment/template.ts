import type { OverlayPayload, Rect, Size } from "@/contracts";
import type { ClipFrame } from "./types";

/**
 * Gabarito por clipe (04 §criar uma roupa, item 2): zona autorizada de cada
 * parte, proteções e tiras de geração. O gabarito é um PONTO DE PARTIDA
 * editável — o artista amplia a zona para ombreiras ou capas e marca o que
 * proteger. Retângulos `[x, y, w, h]` com fim exclusivo, na célula do clipe.
 */

export function clampRect(r: Rect, cell: Size): Rect | null {
  const x0 = Math.max(0, r[0]);
  const y0 = Math.max(0, r[1]);
  const x1 = Math.min(cell[0], r[0] + r[2]);
  const y1 = Math.min(cell[1], r[1] + r[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

export function growRect(r: Rect, px: number, cell: Size): Rect {
  return clampRect([r[0] - px, r[1] - px, r[2] + 2 * px, r[3] + 2 * px], cell) ?? r;
}

/** Zona a partir de cobertura já desenhada da mesma parte no mesmo frame (outra revisão ou outra peça do slot). */
export function zoneFromExisting(overlays: readonly OverlayPayload[], clipRevisionId: string, frameId: string, partId: string, grow: number, cell: Size): Rect[] | null {
  for (const ov of overlays) {
    const cellRef = ov.parts.find((p) => p.partId === partId)?.coverage.find((c) => c.clipRevisionId === clipRevisionId && c.frameId === frameId);
    if (cellRef?.layer) {
      const [, , w, h] = cellRef.layer.rect;
      return [growRect([cellRef.layer.offset[0], cellRef.layer.offset[1], w, h], grow, cell)];
    }
  }
  return null;
}

/**
 * Zona estimada pela caixa do conteúdo do frame (quando não há desenho
 * anterior). Torso: faixa central do corpo; manga: em volta da mão próxima;
 * outras partes: o corpo inteiro. Sempre revisável no editor.
 */
export function estimatedZone(partId: string, frame: Pick<ClipFrame, "sockets">, content: Rect | null, cell: Size, nearSocketId: string | null): Rect[] {
  const box: Rect = content ?? [0, 0, cell[0], cell[1]];
  const [bx, by, bw, bh] = box;
  if (partId === "torso" || partId.startsWith("torso")) {
    return [clampRect([bx + Math.round(bw * 0.12), by + Math.round(bh * 0.22), Math.max(1, Math.round(bw * 0.76)), Math.max(1, Math.round(bh * 0.4))], cell) ?? box];
  }
  if (partId.startsWith("sleeve")) {
    const hand = frame.sockets.find((s) => s.socketId === nearSocketId) ?? frame.sockets.find((s) => !s.hidden);
    if (hand) {
      const shoulderY = by + Math.round(bh * 0.24);
      const y0 = Math.min(shoulderY, hand.at[1] - 2);
      const y1 = Math.max(shoulderY + 6, hand.at[1] - 2);
      return [clampRect([hand.at[0] - 5, y0, 10, y1 - y0], cell) ?? box];
    }
  }
  return [box];
}

/** Proteção das mãos: 3 × 3 em volta de cada socket de empunhadura visível (olhos e rosto o artista marca). */
export function handProtect(frame: Pick<ClipFrame, "sockets">, cell: Size, gripSockets: ReadonlySet<string>): Rect[] {
  return frame.sockets
    .filter((s) => !s.hidden && gripSockets.has(s.socketId))
    .map((s) => clampRect([s.at[0] - 1, s.at[1] - 1, 3, 3], cell))
    .filter((r): r is Rect => r !== null);
}

/** Grade da tira: 1 → 1×1, 2 → 2×1, 3–4 → 2×2, 5–6 → 3×2, 7–9 → 3×3, até 16 → 4×4. */
export function stripLayout(frames: number): { columns: number; rows: number } {
  if (frames <= 1) return { columns: 1, rows: 1 };
  if (frames === 2) return { columns: 2, rows: 1 };
  if (frames <= 4) return { columns: 2, rows: 2 };
  if (frames <= 6) return { columns: 3, rows: 2 };
  if (frames <= 9) return { columns: 3, rows: 3 };
  return { columns: 4, rows: 4 };
}

export interface StripGroup {
  stripKey: string;
  clipRevisionId: string;
  frameIds: string[];
  columns: number;
  rows: number;
}

/** Agrupa as células a gerar em tiras por clipe, até `framesPerStrip` frames cada, na ordem do clipe. */
export function planStrips(pending: readonly { clipRevisionId: string; clipKey: string; frameIds: string[] }[], framesPerStrip: number): StripGroup[] {
  const strips: StripGroup[] = [];
  for (const clip of pending) {
    for (let i = 0; i < clip.frameIds.length; i += framesPerStrip) {
      const frameIds = clip.frameIds.slice(i, i + framesPerStrip);
      const { columns, rows } = stripLayout(frameIds.length);
      strips.push({ stripKey: `${clip.clipKey}-${Math.floor(i / framesPerStrip) + 1}`, clipRevisionId: clip.clipRevisionId, frameIds, columns, rows });
    }
  }
  return strips;
}

/**
 * Posição padrão da parte na ordem do frame: logo depois da camada da base
 * que ela veste (torso sobre o corpo, manga sobre o braço próximo); sem
 * correspondência, à frente de toda a base.
 */
export function defaultDrawIndex(partId: string, frame: Pick<ClipFrame, "layers">): number {
  const idx = (p: string) => frame.layers.findIndex((l) => l.partId === p);
  if (partId.startsWith("sleeve_near") && idx("arm_near") >= 0) return idx("arm_near");
  if (partId.startsWith("sleeve_far") && idx("arm_far") >= 0) return idx("arm_far");
  if (partId.startsWith("torso") && idx("body") >= 0) return idx("body");
  return frame.layers.length;
}

/** Proporções que as rotas de imagem aceitam com segurança. */
export const STANDARD_RATIOS: readonly [number, number][] = [
  // As rotas OpenAI via OpenRouter aceitam só 1:1, 3:2 e 2:3 (recusa observada no ensaio real de 2026-11-19).
  [1, 1],
  [3, 2],
  [2, 3],
];

/**
 * Tela da tira: a grade (colunas × célula) centrada numa tela de proporção
 * padrão, a menor que a contém. Devolve a tela e o canto de cada célula.
 */
export function stripCanvas(cell: Size, columns: number, rows: number, frames: number): { canvas: [number, number]; at: [number, number][] } {
  const gw = columns * cell[0];
  const gh = rows * cell[1];
  let best: { canvas: [number, number]; waste: number } | null = null;
  for (const [rw, rh] of STANDARD_RATIOS) {
    const m = Math.max(Math.ceil(gw / rw), Math.ceil(gh / rh));
    const canvas: [number, number] = [rw * m, rh * m];
    const waste = canvas[0] * canvas[1] - gw * gh;
    if (!best || waste < best.waste) best = { canvas, waste };
  }
  const canvas = best!.canvas;
  const ox = Math.floor((canvas[0] - gw) / 2);
  const oy = Math.floor((canvas[1] - gh) / 2);
  const at = Array.from({ length: frames }, (_, i) => [ox + (i % columns) * cell[0], oy + Math.floor(i / columns) * cell[1]] as [number, number]);
  return { canvas, at };
}
