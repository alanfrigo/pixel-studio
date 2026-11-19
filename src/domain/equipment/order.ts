import type { ClipPayload, Insets, LayerRef, Offset, PixelIndex, Rect, RigPayload } from "@/contracts";
import { type LocalizedText, tx } from "@/i18n/locales";
import { deviationPx, gripInCell, overflow, overflows, rigidOrigin } from "./attach";
import type { ClipFrame, OverlayRef } from "./types";

/**
 * Pilha de camadas de um frame (04 §criar uma roupa, item 5): base + peças,
 * compostas de trás para frente. Ordem padrão = `drawIndex` (a camada `i` da
 * base vale `i`), com empate decidido de forma estável: base primeiro, depois
 * as peças na ordem do conjunto, as partes na ordem da peça e a vista rígida
 * por último dentro da peça. Um override do frame substitui a ordem inteira.
 * Célula com `layer: null` ou vista `null` = vazio explícito (não é lacuna).
 */

export interface StackGrip {
  socketId: string;
  /** Empunhadura na vista (antes do espelho). */
  at: PixelIndex;
  /** Onde ela caiu na célula. */
  drawnAt: [number, number];
  /** Socket do frame que ela deve tocar (`null` = frame sem esse socket). */
  expected: [number, number] | null;
  deviation: number | null;
  exceeds: boolean;
  anchor: boolean;
}

export interface StackLayer {
  key: string;
  ref: LayerRef;
  label: LocalizedText;
  drawIndex: number;
  /** Arquivo da revisão dona da camada (clipe para a base; peça para as demais). */
  ownerRevisionId: string;
  fileId: string;
  rect: Rect;
  offset: [number, number];
  size: [number, number];
  mirrored: boolean;
  overlayRevisionId: string | null;
  partId: string | null;
  viewId: string | null;
  grips: StackGrip[];
}

export interface StackGap {
  overlayRevisionId: string;
  overlayName: string;
  partId: string;
  kind: "part" | "rigid";
}

export interface StackIssue {
  kind: "missing_socket" | "socket_deviation" | "clipped_outline";
  overlayRevisionId: string;
  overlayName: string;
  layerKey: string;
  message: LocalizedText;
  overflow?: Insets;
  socketId?: string;
  deviation?: number;
}

export interface FrameStack {
  frameId: string;
  durationMs: number;
  layers: StackLayer[];
  gaps: StackGap[];
  /** Partes/vistas explicitamente vazias neste frame. */
  empty: { overlayRevisionId: string; partId: string }[];
  issues: StackIssue[];
  override: { present: boolean; applied: boolean; problems: LocalizedText[] };
  sockets: ClipFrame["sockets"];
}

export function layerKey(ref: LayerRef): string {
  switch (ref.kind) {
    case "base":
      return `base:${ref.partId}`;
    case "part":
      return `part:${ref.overlayRevisionId}:${ref.partId}`;
    case "rigid":
      return `rigid:${ref.overlayRevisionId}`;
  }
}

export interface FrameStackInput {
  rig: Pick<RigPayload, "socketTolerancePx">;
  clipRevisionId: string;
  clip: Pick<ClipPayload, "frames" | "logicalSize">;
  frameIndex: number;
  /** Peças na ordem do conjunto. */
  overlays: readonly Pick<OverlayRef, "revisionId" | "name" | "payload">[];
  override?: readonly LayerRef[] | null;
}

export function buildFrameStack(input: FrameStackInput): FrameStack {
  const frame = input.clip.frames[input.frameIndex]!;
  const cell = input.clip.logicalSize;
  const tolerance = input.rig.socketTolerancePx;
  const sockets = new Map(frame.sockets.map((s) => [s.socketId, s]));
  const layers: StackLayer[] = [];
  const gaps: StackGap[] = [];
  const empty: FrameStack["empty"] = [];
  const issues: StackIssue[] = [];

  const seenBase = new Set<string>();
  frame.layers.forEach((l, i) => {
    let key = `base:${l.partId}`;
    if (seenBase.has(key)) key = `${key}#${i}`;
    seenBase.add(key);
    layers.push({
      key,
      ref: { kind: "base", partId: l.partId },
      label: tx(`Base · ${l.partId}`, `Base · ${l.partId}`),
      drawIndex: i,
      ownerRevisionId: input.clipRevisionId,
      fileId: l.fileId,
      rect: l.rect,
      offset: [l.offset[0], l.offset[1]],
      size: [l.rect[2], l.rect[3]],
      mirrored: false,
      overlayRevisionId: null,
      partId: l.partId,
      viewId: null,
      grips: [],
    });
  });

  for (const ov of input.overlays) {
    for (const part of ov.payload.parts) {
      const cellRef = part.coverage.find((c) => c.clipRevisionId === input.clipRevisionId && c.frameId === frame.frameId);
      if (!cellRef) {
        gaps.push({ overlayRevisionId: ov.revisionId, overlayName: ov.name, partId: part.partId, kind: "part" });
        continue;
      }
      if (!cellRef.layer) {
        empty.push({ overlayRevisionId: ov.revisionId, partId: part.partId });
        continue;
      }
      const ref: LayerRef = { kind: "part", overlayRevisionId: ov.revisionId, partId: part.partId };
      const size: [number, number] = [cellRef.layer.rect[2], cellRef.layer.rect[3]];
      const layer: StackLayer = {
        key: layerKey(ref),
        ref,
        label: tx(`${ov.name} · ${part.partId}`, `${ov.name} · ${part.partId}`),
        drawIndex: cellRef.drawIndex,
        ownerRevisionId: ov.revisionId,
        fileId: cellRef.layer.fileId,
        rect: cellRef.layer.rect,
        offset: [cellRef.layer.offset[0], cellRef.layer.offset[1]],
        size,
        mirrored: false,
        overlayRevisionId: ov.revisionId,
        partId: part.partId,
        viewId: null,
        grips: [],
      };
      layers.push(layer);
      pushClipped(issues, ov, layer, cell);
    }
    if (ov.payload.rigidViews.length === 0) continue;
    const placement = (ov.payload.rigidPlacements ?? []).find((p) => p.clipRevisionId === input.clipRevisionId && p.frameId === frame.frameId);
    if (!placement) {
      gaps.push({ overlayRevisionId: ov.revisionId, overlayName: ov.name, partId: "rigid", kind: "rigid" });
      continue;
    }
    if (placement.viewId === null) {
      empty.push({ overlayRevisionId: ov.revisionId, partId: "rigid" });
      continue;
    }
    const view = ov.payload.rigidViews.find((v) => v.viewId === placement.viewId)!;
    const anchorGrip = view.grips.find((g) => g.socketId === placement.anchorSocketId)!;
    const anchorSocket = sockets.get(placement.anchorSocketId);
    const ref: LayerRef = { kind: "rigid", overlayRevisionId: ov.revisionId };
    if (!anchorSocket) {
      issues.push({
        kind: "missing_socket",
        overlayRevisionId: ov.revisionId,
        overlayName: ov.name,
        layerKey: layerKey(ref),
        socketId: placement.anchorSocketId,
        message: tx(`O frame ${frame.frameId} não marca o socket ${placement.anchorSocketId} que ancora ${ov.name}`, `Frame ${frame.frameId} does not mark socket ${placement.anchorSocketId}, which anchors ${ov.name}`),
      });
      continue;
    }
    const w = view.rect[2];
    const mirrored = Boolean(placement.mirrored);
    const origin = rigidOrigin(anchorSocket.at, anchorGrip.at, w, mirrored);
    const grips: StackGrip[] = view.grips.map((g) => {
      const drawnAt = gripInCell(origin, g.at, w, mirrored);
      const expected = sockets.get(g.socketId)?.at ?? null;
      const deviation = expected ? deviationPx(drawnAt, expected) : null;
      return {
        socketId: g.socketId,
        at: g.at,
        drawnAt,
        expected: expected ? [expected[0], expected[1]] : null,
        deviation,
        exceeds: deviation !== null && deviation > tolerance,
        anchor: g.socketId === placement.anchorSocketId,
      };
    });
    const layer: StackLayer = {
      key: layerKey(ref),
      ref,
      label: tx(`${ov.name} · ${view.viewId}${mirrored ? " (espelhada)" : ""}`, `${ov.name} · ${view.viewId}${mirrored ? " (mirrored)" : ""}`),
      drawIndex: placement.drawIndex,
      ownerRevisionId: ov.revisionId,
      fileId: view.fileId,
      rect: view.rect,
      offset: origin,
      size: [view.rect[2], view.rect[3]],
      mirrored,
      overlayRevisionId: ov.revisionId,
      partId: null,
      viewId: view.viewId,
      grips,
    };
    layers.push(layer);
    pushClipped(issues, ov, layer, cell);
    for (const g of grips) {
      if (g.anchor) continue;
      if (g.expected === null) {
        issues.push({
          kind: "missing_socket",
          overlayRevisionId: ov.revisionId,
          overlayName: ov.name,
          layerKey: layer.key,
          socketId: g.socketId,
          message: tx(`${ov.name} tem empunhadura para ${g.socketId}, mas o frame ${frame.frameId} não marca esse socket`, `${ov.name} has a grip for ${g.socketId}, but frame ${frame.frameId} does not mark that socket`),
        });
      } else if (g.exceeds) {
        issues.push({
          kind: "socket_deviation",
          overlayRevisionId: ov.revisionId,
          overlayName: ov.name,
          layerKey: layer.key,
          socketId: g.socketId,
          deviation: g.deviation!,
          message: tx(
            `Segunda mão (${g.socketId}) a ${g.deviation} px da empunhadura de ${ov.name} no frame ${frame.frameId}; tolerância do rig ${tolerance} px`,
            `Second hand (${g.socketId}) is ${g.deviation} px from the grip of ${ov.name} in frame ${frame.frameId}; rig tolerance ${tolerance} px`,
          ),
        });
      }
    }
  }

  // Ordem padrão: drawIndex com desempate estável pela ordem de inserção acima.
  const ordered = layers.map((l, i) => ({ l, i })).sort((a, b) => a.l.drawIndex - b.l.drawIndex || a.i - b.i).map((x) => x.l);
  const override = { present: Boolean(input.override?.length), applied: false, problems: [] as LocalizedText[] };
  let final = ordered;
  if (input.override?.length) {
    const byKey = new Map(ordered.map((l) => [l.key, l]));
    const keys = input.override.map(layerKey);
    const unknown = keys.filter((k) => !byKey.has(k));
    const missing = ordered.filter((l) => !keys.includes(l.key)).map((l) => l.key);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (unknown.length) override.problems.push(tx(`Override cita camadas que não estão no frame: ${unknown.join(", ")}`, `Override names layers that are not in the frame: ${unknown.join(", ")}`));
    if (missing.length) override.problems.push(tx(`Override não posiciona: ${missing.join(", ")}`, `Override does not place: ${missing.join(", ")}`));
    if (dup.length) override.problems.push(tx(`Override repete: ${dup.join(", ")}`, `Override repeats: ${dup.join(", ")}`));
    if (override.problems.length === 0) {
      final = keys.map((k) => byKey.get(k)!);
      override.applied = true;
    }
  }
  return { frameId: frame.frameId, durationMs: frame.durationMs, layers: final, gaps, empty, issues, override, sockets: frame.sockets };
}

function pushClipped(issues: StackIssue[], ov: Pick<OverlayRef, "revisionId" | "name">, layer: StackLayer, cell: readonly [number, number]) {
  const o = overflow(layer.offset as Offset, layer.size, [cell[0], cell[1]]);
  if (!overflows(o)) return;
  const sides = (["left", "right", "top", "bottom"] as const).filter((s) => o[s] > 0);
  const sidesPt = sides.map((s) => `${s === "left" ? "esquerda" : s === "right" ? "direita" : s === "top" ? "topo" : "base"} ${o[s]} px`);
  const sidesEn = sides.map((s) => `${s} ${o[s]} px`);
  issues.push({
    kind: "clipped_outline",
    overlayRevisionId: ov.revisionId,
    overlayName: ov.name,
    layerKey: layer.key,
    overflow: o,
    message: tx(
      `Contorno cortado: ${layer.label["pt-BR"]} passa da célula ${cell[0]}×${cell[1]} (${sidesPt.join(", ")})`,
      `Clipped outline: ${layer.label.en} goes past the ${cell[0]}×${cell[1]} cell (${sidesEn.join(", ")})`,
    ),
  });
}
