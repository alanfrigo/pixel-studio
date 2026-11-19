import type { ClipPayload, Insets, LoadoutPayload, OverlayPayload } from "@/contracts";

/**
 * Ampliar a célula de um golpe (04 §contratos: "ao ampliar a célula, deslocar
 * cada camada, encaixe e pivô pela mesma margem para preservar a posição em
 * cena"). A nova revisão de clipe acrescenta as margens; as coberturas da peça
 * são copiadas para a nova revisão com o mesmo deslocamento (mesmos blobs), e
 * as vistas rígidas continuam ancoradas nos sockets, que já se moveram.
 */

export function isZeroInsets(m: Insets): boolean {
  return m.left === 0 && m.right === 0 && m.top === 0 && m.bottom === 0;
}

export function expandClipCell(clip: ClipPayload, add: Insets): ClipPayload {
  const dx = add.left;
  const dy = add.top;
  return {
    ...clip,
    logicalSize: [clip.logicalSize[0] + add.left + add.right, clip.logicalSize[1] + add.top + add.bottom],
    pivot: [clip.pivot[0] + dx, clip.pivot[1] + dy],
    margins: {
      left: clip.margins.left + add.left,
      right: clip.margins.right + add.right,
      top: clip.margins.top + add.top,
      bottom: clip.margins.bottom + add.bottom,
    },
    frames: clip.frames.map((f) => ({
      ...f,
      layers: f.layers.map((l) => ({ ...l, offset: [l.offset[0] + dx, l.offset[1] + dy] as [number, number] })),
      sockets: f.sockets.map((s) => ({ ...s, at: [s.at[0] + dx, s.at[1] + dy] as [number, number] })),
    })),
  };
}

/**
 * Coberturas e usos rígidos do clipe antigo copiados para o novo, deslocados
 * pela margem. Os vínculos anteriores ficam (pacote antigo continua resolvendo).
 */
export function shiftOverlayForExpansion(overlay: OverlayPayload, fromClipRevisionId: string, toClipRevisionId: string, add: Insets): { payload: OverlayPayload; copied: number } {
  let copied = 0;
  const parts = overlay.parts.map((part) => {
    const extra = part.coverage
      .filter((c) => c.clipRevisionId === fromClipRevisionId && !part.coverage.some((x) => x.clipRevisionId === toClipRevisionId && x.frameId === c.frameId))
      .map((c) => {
        copied += 1;
        return {
          ...c,
          clipRevisionId: toClipRevisionId,
          layer: c.layer ? { ...c.layer, offset: [c.layer.offset[0] + add.left, c.layer.offset[1] + add.top] as [number, number] } : null,
        };
      });
    return { ...part, coverage: [...part.coverage, ...extra] };
  });
  const placements = overlay.rigidPlacements ?? [];
  const extraPlacements = placements
    .filter((p) => p.clipRevisionId === fromClipRevisionId && !placements.some((x) => x.clipRevisionId === toClipRevisionId && x.frameId === p.frameId))
    .map((p) => {
      copied += 1;
      return { ...p, clipRevisionId: toClipRevisionId };
    });
  return {
    payload: { ...overlay, parts, ...(placements.length || extraPlacements.length ? { rigidPlacements: [...placements, ...extraPlacements] } : {}) },
    copied,
  };
}

/** Overrides de ordem do clipe antigo passam a valer para o novo (mesmos frames, mesma pilha). */
export function retargetDrawOrder(loadout: Pick<LoadoutPayload, "drawOrder">, fromClipRevisionId: string, toClipRevisionId: string): LoadoutPayload["drawOrder"] {
  return loadout.drawOrder?.map((o) => (o.clipRevisionId === fromClipRevisionId ? { ...o, clipRevisionId: toClipRevisionId } : o));
}
