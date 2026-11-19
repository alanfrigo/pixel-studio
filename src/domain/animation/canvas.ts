import type { BasePayload, ClipPayload, Insets, Offset, Rect, Size } from "@/contracts";
import { type LocalizedText, tx } from "@/i18n/locales";

/**
 * Canvas de clipe e de objeto (04 §contratos: "Ao ampliar a célula de um golpe,
 * deslocar cada camada, encaixe e pivô pela mesma margem para preservar a
 * posição em cena"). Nenhum pixel é gerado: o clipe só muda metadados (offsets,
 * retângulos, sockets, pivô, margens); a base recebe os mesmos pixels numa tela
 * maior ou menor (ver `canvas_fit` no processador local).
 *
 * Eventos de VFX ficam ancorados a um socket ou ao pivô; os dois andam junto
 * com a margem, então o deslocamento local do evento não muda. Coberturas de
 * overlay (S2) usam o mesmo `shift` devolvido aqui.
 */

/** Margens a acrescentar (positivas) ou retirar (negativas) de cada lado. */
export interface CanvasMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CanvasResult<T> {
  payload: T;
  /** Deslocamento aplicado a tudo que está na célula: `[left, top]`. */
  shift: Offset;
  size: Size;
  problems: LocalizedText[];
}

export function marginsAreZero(m: CanvasMargins): boolean {
  return m.left === 0 && m.right === 0 && m.top === 0 && m.bottom === 0;
}

export function resizedCell([w, h]: Size, m: CanvasMargins): Size {
  return [w + m.left + m.right, h + m.top + m.bottom];
}

function intersect([x, y, w, h]: Rect, [W, H]: Size): Rect | null {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(W, x + w);
  const y1 = Math.min(H, y + h);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

function inside(box: Rect, [W, H]: Size): boolean {
  return box[0] >= 0 && box[1] >= 0 && box[0] + box[2] <= W && box[1] + box[3] <= H;
}

/**
 * Nova célula do clipe. Ampliar desloca camadas, sockets, pivô e margens.
 * Reduzir exige `contentBoxes` (caixa do conteúdo composto de cada quadro, na
 * célula antiga): só é aceito se nenhum pixel visível sair da célula; as
 * camadas são então recortadas geometricamente (os pixels cortados são
 * transparentes por construção).
 */
export function resizeClipCanvas(clip: ClipPayload, m: CanvasMargins, contentBoxes?: Record<string, Rect | null>): CanvasResult<ClipPayload> {
  const problems: LocalizedText[] = [];
  const shift: Offset = [m.left, m.top];
  const size = resizedCell(clip.logicalSize, m);
  if (size[0] < 1 || size[1] < 1) return { payload: clip, shift, size, problems: [tx(`A célula ficaria ${size.join("×")}`, `The cell would be ${size.join("×")}`)] };
  const margins: Insets = {
    left: clip.margins.left + m.left,
    right: clip.margins.right + m.right,
    top: clip.margins.top + m.top,
    bottom: clip.margins.bottom + m.bottom,
  };
  for (const side of ["left", "right", "top", "bottom"] as const) {
    if (margins[side] < 0) problems.push(tx(`Reduzir ${side} além das margens acrescentadas deixaria a célula menor que a do rig/objeto (margem ${margins[side]})`, `Shrinking ${side} past the added margins would make the cell smaller than the rig/object cell (margin ${margins[side]})`));
  }
  const pivot: [number, number] = [clip.pivot[0] + shift[0], clip.pivot[1] + shift[1]];
  if (pivot[0] < 0 || pivot[1] < 0 || pivot[0] > size[0] || pivot[1] > size[1]) problems.push(tx(`O pivô ficaria fora da célula (${pivot.join(",")})`, `The pivot would fall outside the cell (${pivot.join(",")})`));

  const frames = clip.frames.map((frame) => {
    const box = contentBoxes?.[frame.frameId];
    if (box) {
      const moved: Rect = [box[0] + shift[0], box[1] + shift[1], box[2], box[3]];
      if (!inside(moved, size)) problems.push(tx(`Quadro ${frame.frameId}: pixels visíveis sairiam da célula ${size.join("×")}`, `Frame ${frame.frameId}: visible pixels would fall outside the ${size.join("×")} cell`));
    }
    const layers: ClipPayload["frames"][number]["layers"] = [];
    frame.layers.forEach((layer, li) => {
      const placed: Rect = [layer.offset[0] + shift[0], layer.offset[1] + shift[1], layer.rect[2], layer.rect[3]];
      if (inside(placed, size)) {
        layers.push({ ...layer, offset: [placed[0], placed[1]] });
        return;
      }
      if (contentBoxes === undefined || !(frame.frameId in contentBoxes)) {
        problems.push(tx(`Quadro ${frame.frameId}, camada ${li} (${layer.partId}): reduzir exige medir o conteúdo do quadro`, `Frame ${frame.frameId}, layer ${li} (${layer.partId}): shrinking requires measuring the frame content`));
        layers.push(layer);
        return;
      }
      const cut = intersect(placed, size);
      if (!cut) {
        // Camada inteira fora da célula nova: só transparência (o conteúdo coube). Fica 1×1 transparente se for a única.
        if (frame.layers.length === 1) layers.push({ ...layer, rect: [layer.rect[0], layer.rect[1], 1, 1], offset: [0, 0] });
        return;
      }
      layers.push({ ...layer, rect: [layer.rect[0] + (cut[0] - placed[0]), layer.rect[1] + (cut[1] - placed[1]), cut[2], cut[3]], offset: [cut[0], cut[1]] });
    });
    const sockets = frame.sockets.map((s) => {
      const at: [number, number] = [s.at[0] + shift[0], s.at[1] + shift[1]];
      if (at[0] < 0 || at[1] < 0 || at[0] >= size[0] || at[1] >= size[1]) problems.push(tx(`Quadro ${frame.frameId}: socket ${s.socketId} sairia da célula`, `Frame ${frame.frameId}: socket ${s.socketId} would fall outside the cell`));
      return { ...s, at: [Math.max(0, at[0]), Math.max(0, at[1])] as [number, number] };
    });
    return { ...frame, layers, sockets };
  });
  return { payload: { ...clip, logicalSize: size, pivot: [Math.max(0, pivot[0]), Math.max(0, pivot[1])], margins: problems.length ? clip.margins : margins, frames }, shift, size, problems };
}

/**
 * Nova célula da base (objeto ou personagem): as vistas mantêm os mesmos
 * pixels, deslocados pela margem, e a origem no chão acompanha. Devolve, por
 * vista, onde o arquivo atual deve ser colocado na tela nova (`canvas_fit`).
 */
export function resizeBaseCanvas(base: BasePayload, m: CanvasMargins): CanvasResult<BasePayload> & { placements: { direction: string; fileId: string; offset: Offset; rect: Rect }[] } {
  const problems: LocalizedText[] = [];
  const shift: Offset = [m.left, m.top];
  const size = resizedCell(base.logicalSize, m);
  if (size[0] < 1 || size[1] < 1) return { payload: base, shift, size, problems: [tx(`A célula ficaria ${size.join("×")}`, `The cell would be ${size.join("×")}`)], placements: [] };
  const groundOrigin: [number, number] = [base.groundOrigin[0] + shift[0], base.groundOrigin[1] + shift[1]];
  if (groundOrigin[0] < 0 || groundOrigin[1] < 0 || groundOrigin[0] > size[0] || groundOrigin[1] > size[1]) {
    problems.push(tx(`A origem no chão ficaria fora da célula (${groundOrigin.join(",")})`, `The ground origin would fall outside the cell (${groundOrigin.join(",")})`));
  }
  const placements = base.views.map((v) => ({
    direction: v.direction,
    fileId: v.fileId,
    rect: v.rect,
    // O arquivo inteiro vai para a tela nova: a região da vista cai em sourceOffset + shift.
    offset: [v.sourceOffset[0] + shift[0] - v.rect[0], v.sourceOffset[1] + shift[1] - v.rect[1]] as Offset,
  }));
  const views = base.views.map((v) => ({ ...v, rect: [0, 0, size[0], size[1]] as Rect, sourceOffset: [0, 0] as Offset }));
  return {
    payload: { ...base, logicalSize: size, groundOrigin: [Math.max(0, groundOrigin[0]), Math.max(0, groundOrigin[1])], views },
    shift,
    size,
    problems,
    placements,
  };
}
