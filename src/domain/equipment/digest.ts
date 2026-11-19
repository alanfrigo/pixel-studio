import type { ClipPayload, OverlayPayload } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";

/**
 * Digest de geometria por frame (04 §caso de ponta a ponta): poses (pixels de
 * cada camada da base, pelo hash RGBA canônico da região), pivô, sockets,
 * máscaras (o alfa das camadas entra no hash) e ordem de desenho. Duração,
 * título e eventos NÃO entram: retimar não invalida a cobertura.
 *
 * Revincular = copiar a célula da peça para a nova revisão do clipe quando o
 * frame tem o mesmo ID e o mesmo digest, reaproveitando os blobs. Frames que
 * mudaram de geometria (ex.: só a pose de contato) ficam para revisar.
 */

export function frameGeometry(clip: Pick<ClipPayload, "logicalSize" | "pivot" | "frames">, frameIndex: number, layerHashes: readonly string[]) {
  const frame = clip.frames[frameIndex]!;
  if (layerHashes.length !== frame.layers.length) throw new Error(`Esperados ${frame.layers.length} hashes de camada no frame ${frame.frameId}`);
  return {
    cell: clip.logicalSize,
    pivot: clip.pivot,
    rootOffset: frame.rootOffset,
    sockets: [...frame.sockets].sort((a, b) => (a.socketId < b.socketId ? -1 : 1)).map((s) => ({ socketId: s.socketId, at: s.at, hidden: s.hidden })),
    // Ordem do array = ordem de desenho da base.
    layers: frame.layers.map((l, i) => ({ partId: l.partId, offset: l.offset, size: [l.rect[2], l.rect[3]], rgba: layerHashes[i] })),
  };
}

export function frameDigest(clip: Pick<ClipPayload, "logicalSize" | "pivot" | "frames">, frameIndex: number, layerHashes: readonly string[]): string {
  return canonicalDigest(frameGeometry(clip, frameIndex, layerHashes));
}

export interface RebindResult {
  payload: OverlayPayload;
  rebound: { partId: string; frameId: string }[];
  /** Precisam de arte nova ou revisão: geometria mudou, frame novo ou sem cobertura anterior. */
  review: { partId: string; frameId: string; reason: "geometry_changed" | "new_frame" | "not_covered" }[];
}

/**
 * Plano de revinculação da peça de `from` para `to` (mesmo asset de clipe):
 * mantém todos os vínculos anteriores e acrescenta os da nova revisão só onde
 * o digest coincide.
 */
export function rebindOverlay(
  overlay: OverlayPayload,
  from: { revisionId: string; digests: Record<string, string> },
  to: { revisionId: string; frameIds: readonly string[]; digests: Record<string, string> },
): RebindResult {
  const rebound: RebindResult["rebound"] = [];
  const review: RebindResult["review"] = [];
  const same = (frameId: string) => from.digests[frameId] !== undefined && from.digests[frameId] === to.digests[frameId];
  const parts = overlay.parts.map((part) => {
    const extra = [];
    for (const frameId of to.frameIds) {
      if (part.coverage.some((c) => c.clipRevisionId === to.revisionId && c.frameId === frameId)) continue;
      const old = part.coverage.find((c) => c.clipRevisionId === from.revisionId && c.frameId === frameId);
      if (!old) {
        review.push({ partId: part.partId, frameId, reason: from.digests[frameId] === undefined ? "new_frame" : "not_covered" });
        continue;
      }
      if (!same(frameId)) {
        review.push({ partId: part.partId, frameId, reason: "geometry_changed" });
        continue;
      }
      extra.push({ ...old, clipRevisionId: to.revisionId });
      rebound.push({ partId: part.partId, frameId });
    }
    return { ...part, coverage: [...part.coverage, ...extra] };
  });
  let rigidPlacements = overlay.rigidPlacements;
  if (overlay.rigidViews.length > 0) {
    const placements = overlay.rigidPlacements ?? [];
    const extra = [];
    for (const frameId of to.frameIds) {
      if (placements.some((p) => p.clipRevisionId === to.revisionId && p.frameId === frameId)) continue;
      const old = placements.find((p) => p.clipRevisionId === from.revisionId && p.frameId === frameId);
      if (!old) {
        review.push({ partId: "rigid", frameId, reason: from.digests[frameId] === undefined ? "new_frame" : "not_covered" });
        continue;
      }
      if (!same(frameId)) {
        review.push({ partId: "rigid", frameId, reason: "geometry_changed" });
        continue;
      }
      extra.push({ ...old, clipRevisionId: to.revisionId });
      rebound.push({ partId: "rigid", frameId });
    }
    rigidPlacements = [...placements, ...extra];
  }
  return { payload: { ...overlay, parts, ...(rigidPlacements ? { rigidPlacements } : {}) }, rebound, review };
}

/**
 * Poses equivalentes (04: "reutilizar desenhos em poses equivalentes e gerar
 * apenas as lacunas"): para cada célula pedida sem cobertura, procura um frame
 * com o MESMO digest que já tenha a parte coberta.
 */
export function equivalentCells(
  wanted: readonly { clipRevisionId: string; frameId: string; partId: string; digest: string }[],
  existing: readonly { clipRevisionId: string; frameId: string; partId: string; digest: string }[],
): Map<string, { clipRevisionId: string; frameId: string }> {
  const byDigest = new Map<string, { clipRevisionId: string; frameId: string }>();
  for (const e of existing) {
    const k = `${e.partId}|${e.digest}`;
    if (!byDigest.has(k)) byDigest.set(k, { clipRevisionId: e.clipRevisionId, frameId: e.frameId });
  }
  const out = new Map<string, { clipRevisionId: string; frameId: string }>();
  for (const w of wanted) {
    const hit = byDigest.get(`${w.partId}|${w.digest}`);
    if (hit && !(hit.clipRevisionId === w.clipRevisionId && hit.frameId === w.frameId)) out.set(`${w.clipRevisionId}#${w.frameId}#${w.partId}`, hit);
  }
  return out;
}
