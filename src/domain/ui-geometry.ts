import type { Insets, Rect, Size } from "@/contracts";

/**
 * Geometria da UI do jogo (07 §dimensões, §medidor, §composição), usada pelo
 * editor, pela prévia e pela exportação — uma única implementação.
 * Pixels lógicos inteiros, origem superior esquerda, retângulos com fim exclusivo.
 */

export interface SlicePiece {
  /** Região na textura de origem. */
  src: Rect;
  /** Região no tamanho desenhado. */
  dst: Rect;
  /** Posição no nine-slice: cantos não esticam; bordas esticam num eixo; centro nos dois. */
  zone: "corner" | "edge-h" | "edge-v" | "center";
}

/** Menor tamanho que preserva os quatro cantos com centro positivo. */
export function minimumSize(insets: Insets): Size {
  return [insets.left + insets.right + 1, insets.top + insets.bottom + 1];
}

/**
 * Nove regiões de `source` (tamanho `sourceSize`) desenhadas em `target`.
 * Cantos mantêm o tamanho original; bordas e centro esticam (ou repetem,
 * conforme a política) para preencher.
 */
export function nineSlice(sourceSize: Size, insets: Insets, target: Size): SlicePiece[] {
  const [sw, sh] = sourceSize;
  const [tw, th] = target;
  const { left: l, right: r, top: t, bottom: b } = insets;
  if (l + r >= sw || t + b >= sh) throw new RangeError("nineSlice deixa a área central da textura sem pixels");
  if (tw < l + r + 1 || th < t + b + 1) throw new RangeError(`Tamanho ${tw}×${th} menor que o mínimo ${l + r + 1}×${t + b + 1} para preservar os cantos`);
  const sx = [0, l, sw - r, sw];
  const sy = [0, t, sh - b, sh];
  const dx = [0, l, tw - r, tw];
  const dy = [0, t, th - b, th];
  const pieces: SlicePiece[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const src: Rect = [sx[i]!, sy[j]!, sx[i + 1]! - sx[i]!, sy[j + 1]! - sy[j]!];
      const dst: Rect = [dx[i]!, dy[j]!, dx[i + 1]! - dx[i]!, dy[j + 1]! - dy[j]!];
      if (src[2] <= 0 || src[3] <= 0 || dst[2] <= 0 || dst[3] <= 0) continue;
      const zone = i !== 1 && j !== 1 ? "corner" : i === 1 && j === 1 ? "center" : j === 1 ? "edge-v" : "edge-h";
      pieces.push({ src, dst, zone });
    }
  }
  return pieces;
}

/** Área disponível para a legenda/conteúdo dentro do componente desenhado. */
export function contentArea(target: Size, padding: Insets): Rect {
  const w = target[0] - padding.left - padding.right;
  const h = target[1] - padding.top - padding.bottom;
  if (w <= 0 || h <= 0) throw new RangeError(`contentPadding não deixa área útil em ${target[0]}×${target[1]}`);
  return [padding.left, padding.top, w, h];
}

/**
 * Parte visível do preenchimento do medidor: `clamp((v-min)/(max-min), 0, 1)`
 * aplicada à área útil, arredondando para baixo em pixels.
 */
export function meterFill(
  value: number,
  range: { min: number; max: number },
  useful: Rect,
  axis: "horizontal" | "vertical",
  direction: "forward" | "reverse",
): Rect {
  if (!(range.max > range.min)) throw new RangeError("Faixa do medidor exige max > min");
  const t = Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
  const [x, y, w, h] = useful;
  if (axis === "horizontal") {
    const fw = Math.floor(w * t);
    return direction === "forward" ? [x, y, fw, h] : [x + w - fw, y, fw, h];
  }
  const fh = Math.floor(h * t);
  // Vertical "forward" cresce de baixo para cima (barra de energia).
  return direction === "forward" ? [x, y + h - fh, w, fh] : [x, y, w, fh];
}

export interface Anchors {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Lado = origem do pai + fração da dimensão do pai + deslocamento; bordas arredondadas à grade. */
export function anchoredRect(parent: Rect, anchors: Anchors, offsets: Anchors): Rect {
  const [px, py, pw, ph] = parent;
  const left = Math.round(px + anchors.left * pw + offsets.left);
  const right = Math.round(px + anchors.right * pw + offsets.right);
  const top = Math.round(py + anchors.top * ph + offsets.top);
  const bottom = Math.round(py + anchors.bottom * ph + offsets.bottom);
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

// ---------------------------------------------------------------------------
// Cartão U3: folha de estados e guias iniciais de recorte
// ---------------------------------------------------------------------------

export interface StateSheetLayout {
  columns: number;
  rows: number;
  gapPx: number;
  sheetSize: [number, number];
  /** Células em ordem de leitura: 0 = estado-base, depois os estados pedidos. */
  cells: [number, number, number, number][];
}

/**
 * Grade de `count` células `cell` com espaçamento inteiro (também na borda),
 * escolhendo as colunas que deixam a folha mais perto de quadrada: modelos de
 * imagem trabalham com proporções limitadas (uma tira 8:1 não seria pintada).
 */
export function stateSheetLayout(cell: [number, number], count: number, gapPx?: number): StateSheetLayout {
  const gap = gapPx ?? Math.max(2, Math.ceil(Math.min(cell[0], cell[1]) / 2));
  let best: StateSheetLayout | null = null;
  let bestScore = Infinity;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    if (rows > 8 || columns > 8) continue;
    const sheetSize: [number, number] = [gap + columns * (cell[0] + gap), gap + rows * (cell[1] + gap)];
    // Proporção perto de 1:1, depois menos células sobrando.
    const score = Math.abs(Math.log(sheetSize[0] / sheetSize[1])) + 0.01 * (columns * rows - count);
    if (score < bestScore) {
      bestScore = score;
      const cells: [number, number, number, number][] = Array.from({ length: count }, (_, k) => [gap + (k % columns) * (cell[0] + gap), gap + Math.floor(k / columns) * (cell[1] + gap), cell[0], cell[1]]);
      best = { columns, rows, gapPx: gap, sheetSize, cells };
    }
  }
  if (!best) throw new RangeError(`Folha não comporta ${count} células`);
  return best;
}

/** Células de uma folha já declarada no plano (mesma regra de `stateSheetLayout`). */
export function stateSheetCells(sheet: { cell: [number, number]; columns: number; gapPx: number }, count: number): [number, number, number, number][] {
  const { cell, columns, gapPx: gap } = sheet;
  return Array.from({ length: count }, (_, k) => [gap + (k % columns) * (cell[0] + gap), gap + Math.floor(k / columns) * (cell[1] + gap), cell[0], cell[1]]);
}

/** Guias iniciais de nine-slice e área da legenda para uma peça recortada (o artista ajusta no editor). */
export function suggestedGuides(size: [number, number]): { nineSlice: Insets; contentPadding: Insets } {
  const [w, h] = size;
  const side = (n: number) => Math.max(1, Math.min(4, Math.floor((n - 1) / 3)));
  const sx = side(w);
  const sy = side(h);
  // Padding = corte + respiro, sem fechar a área útil: na vertical sobra ao menos uma linha de legenda (7 px).
  const px = Math.max(0, Math.min(sx + 2, Math.floor((w - 1) / 2)));
  const py = Math.max(0, Math.min(sy + 1, Math.floor((h - 7) / 2)));
  return { nineSlice: { left: sx, right: sx, top: sy, bottom: sy }, contentPadding: { left: px, right: px, top: py, bottom: py } };
}
