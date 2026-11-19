import type { Direction, RigPayload } from "@/contracts";
import type { ClipRef, Combo } from "./types";

/**
 * Busca do clipe pela chave `(rigRevision, action, stance, direction)` (04
 * §caso de ponta a ponta). Variantes = assets de clipe distintos aprovados para
 * a mesma chave: o artista escolhe e o ID da revisão fica fixado no snapshot
 * do conjunto. Clipe de outra postura só entra com vínculo explícito e revisado
 * (`sharedStances`), nunca por omissão.
 */

export interface ClipKey extends Combo {
  rigRevisionId: string;
  stance: string;
}

export type ClipLookup =
  | {
      status: "resolved";
      clipRevisionId: string;
      link: "exact" | "variant" | "shared";
      candidates: string[];
      /** Revisão fixada no snapshot (não necessariamente a ativa do asset). */
      pinned: boolean;
      /** Fixada numa revisão que já não é a ativa do asset: há versão nova a revisar. */
      outdated: boolean;
    }
  | { status: "ambiguous"; link: "variant" | "shared"; candidates: string[] }
  | {
      status: "missing";
      candidates: [];
      /** Clipes da mesma ação/direção em outra postura (ou sem postura) que poderiam ser vinculados. */
      linkable: string[];
    };

function sameSlot(c: ClipRef, key: ClipKey): boolean {
  return c.payload.rigRevisionId === key.rigRevisionId && c.payload.action === key.action && c.payload.direction === key.direction;
}

function fitsStance(c: ClipRef, stance: string): "exact" | "shared" | null {
  if (c.payload.stance === stance) return "exact";
  if ((c.payload.sharedStances ?? []).includes(stance)) return "shared";
  return null;
}

export function lookupClip(clips: readonly ClipRef[], key: ClipKey, pinnedRevisionId: string | null = null): ClipLookup {
  const usable = clips.filter((c) => c.active && c.status === "approved" && sameSlot(c, key));
  const exact = usable.filter((c) => fitsStance(c, key.stance) === "exact").map((c) => c.revisionId);
  const shared = usable.filter((c) => fitsStance(c, key.stance) === "shared").map((c) => c.revisionId);

  if (pinnedRevisionId) {
    const pinned = clips.find((c) => c.revisionId === pinnedRevisionId);
    const fit = pinned && pinned.status === "approved" && sameSlot(pinned, key) ? fitsStance(pinned, key.stance) : null;
    if (pinned && fit) {
      const pool = fit === "exact" ? exact : shared;
      return {
        status: "resolved",
        clipRevisionId: pinned.revisionId,
        link: fit === "shared" ? "shared" : pool.length > 1 ? "variant" : "exact",
        candidates: pool,
        pinned: true,
        outdated: !pinned.active,
      };
    }
  }
  if (exact.length === 1) return { status: "resolved", clipRevisionId: exact[0]!, link: "exact", candidates: exact, pinned: false, outdated: false };
  if (exact.length > 1) return { status: "ambiguous", link: "variant", candidates: exact };
  if (shared.length === 1) return { status: "resolved", clipRevisionId: shared[0]!, link: "shared", candidates: shared, pinned: false, outdated: false };
  if (shared.length > 1) return { status: "ambiguous", link: "shared", candidates: shared };
  return { status: "missing", candidates: [], linkable: usable.map((c) => c.revisionId) };
}

/** Combinações pedidas por padrão: toda ação com clipe aprovado deste rig × direções do rig. */
export function requestedCombos(rig: Pick<RigPayload, "directions">, rigRevisionId: string, clips: readonly ClipRef[]): Combo[] {
  const actions = [...new Set(clips.filter((c) => c.status === "approved" && c.active && c.payload.rigRevisionId === rigRevisionId).map((c) => c.payload.action))].sort();
  const directions = rig.directions as readonly Direction[];
  return actions.flatMap((action) => directions.map((direction) => ({ action, direction })));
}
