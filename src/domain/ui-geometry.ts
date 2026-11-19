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
