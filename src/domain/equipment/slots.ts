import type { OverlayPayload, RigPayload } from "@/contracts";
import { ACTION_LABEL, type OverlayRef, type Pendency } from "./types";

/**
 * Ocupação de slots e postura (04 §caso de ponta a ponta): o resolvedor
 * primeiro confere quem ocupa cada slot e qual revisão de base cada peça
 * espera; depois escolhe a postura pela combinação das peças.
 */

type PieceLike = Pick<OverlayRef, "revisionId" | "name"> & { assetId?: string; payload: Pick<OverlayPayload, "slots" | "stances" | "rigRevisionId"> };

export interface SlotConflict {
  slotId: string;
  /** Peças que disputam o slot, na ordem do conjunto. */
  overlayRevisionIds: string[];
}

export interface Occupancy {
  bySlot: Record<string, string[]>;
  conflicts: SlotConflict[];
  unknownSlots: { overlayRevisionId: string; slotId: string }[];
}

export function slotOccupancy(rig: Pick<RigPayload, "slots">, pieces: readonly PieceLike[]): Occupancy {
  const known = new Set(rig.slots.map((s) => s.slotId));
  const bySlot: Record<string, string[]> = Object.fromEntries(rig.slots.map((s) => [s.slotId, [] as string[]]));
  const unknownSlots: Occupancy["unknownSlots"] = [];
  for (const piece of pieces) {
    for (const slot of piece.payload.slots) {
      if (!known.has(slot)) {
        unknownSlots.push({ overlayRevisionId: piece.revisionId, slotId: slot });
        continue;
      }
      bySlot[slot]!.push(piece.revisionId);
    }
  }
  const conflicts = Object.entries(bySlot)
    .filter(([, ids]) => ids.length > 1)
    .map(([slotId, overlayRevisionIds]) => ({ slotId, overlayRevisionIds }));
  return { bySlot, conflicts, unknownSlots };
}

export interface Replacement {
  incoming: string;
  /** Peças retiradas para liberar os slots (ou a revisão anterior do mesmo item). */
  removed: string[];
  overlayRevisionIds: string[];
  freedSlots: string[];
}

/**
 * Equipar uma peça como UMA operação: retira quem ocupa qualquer slot dela
 * (ex.: o escudo ao equipar a espada longa, que ocupa as duas mãos) e uma
 * revisão anterior do mesmo item; a nova entra no lugar da primeira retirada.
 */
export function replaceConflicting(current: readonly PieceLike[], incoming: PieceLike): Replacement {
  const slots = new Set(incoming.payload.slots);
  const removed = current.filter(
    (p) => p.revisionId !== incoming.revisionId && (p.payload.slots.some((s) => slots.has(s)) || (incoming.assetId !== undefined && p.assetId === incoming.assetId)),
  );
  const removedIds = new Set(removed.map((p) => p.revisionId));
  const order: string[] = [];
  let placed = false;
  for (const p of current) {
    if (p.revisionId === incoming.revisionId) continue;
    if (removedIds.has(p.revisionId)) {
      if (!placed) order.push(incoming.revisionId);
      placed = true;
      continue;
    }
    order.push(p.revisionId);
  }
  if (!placed) order.push(incoming.revisionId);
  const freed = [...new Set(removed.flatMap((p) => p.payload.slots))].filter((s) => !slots.has(s));
  return { incoming: incoming.revisionId, removed: removed.map((p) => p.revisionId), overlayRevisionIds: order, freedSlots: freed };
}

/** Pendências de ocupação com a ação "Substituir" (mantém a peça mais recente do conjunto). */
export function slotPendencies(occupancy: Occupancy, names: ReadonlyMap<string, string>): Pendency[] {
  const out: Pendency[] = occupancy.conflicts.map((c) => {
    const labels = c.overlayRevisionIds.map((id) => names.get(id) ?? id);
    return {
      kind: "slot_conflict",
      blocking: true,
      message: `Slot ${c.slotId} ocupado por ${labels.join(" e ")}: retire um deles`,
      where: { slotId: c.slotId, overlayRevisionId: c.overlayRevisionIds.at(-1)!, overlayName: labels.at(-1)! },
      action: { kind: "replace_item", label: `${ACTION_LABEL.replace_item} ${labels.slice(0, -1).join(", ")} por ${labels.at(-1)}` },
    };
  });
  for (const u of occupancy.unknownSlots) {
    out.push({
      kind: "unknown_slot",
      blocking: true,
      message: `A peça ${names.get(u.overlayRevisionId) ?? u.overlayRevisionId} ocupa o slot ${u.slotId}, que este rig não tem`,
      where: { overlayRevisionId: u.overlayRevisionId, overlayName: names.get(u.overlayRevisionId) ?? u.overlayRevisionId, slotId: u.slotId },
      action: { kind: "create_coverage", label: ACTION_LABEL.create_coverage },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Postura
// ---------------------------------------------------------------------------

export type StanceResolution =
  | { status: "resolved"; stance: string; policy: "auto" | "pinned"; candidates: string[] }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none"; candidates: []; pinnedRejected: string | null; reasons: { overlayRevisionId: string; stances: string[] }[] };

/**
 * Postura pela combinação: as posturas do rig aceitas por TODAS as peças. Uma
 * só = resolvida (`auto`); várias = o artista escolhe (`pinned`); nenhuma =
 * combinação impossível, com a postura de cada peça para explicar.
 */
export function resolveStance(rig: Pick<RigPayload, "stances">, pieces: readonly PieceLike[], pinned: string | null = null): StanceResolution {
  const candidates = rig.stances.filter((s) => pieces.every((p) => p.payload.stances.includes(s)));
  const reasons = pieces.map((p) => ({ overlayRevisionId: p.revisionId, stances: [...p.payload.stances] }));
  if (pinned !== null) {
    if (candidates.includes(pinned)) return { status: "resolved", stance: pinned, policy: "pinned", candidates };
    return { status: "none", candidates: [], pinnedRejected: pinned, reasons };
  }
  if (candidates.length === 1) return { status: "resolved", stance: candidates[0]!, policy: "auto", candidates };
  if (candidates.length === 0) return { status: "none", candidates: [], pinnedRejected: null, reasons };
  return { status: "ambiguous", candidates };
}
