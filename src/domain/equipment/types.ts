import type { ClipPayload, Direction, OverlayPayload, RigPayload } from "@/contracts";

/**
 * Entradas do resolvedor de equipamentos (cartão S2, 04 §caso de ponta a
 * ponta). Funções puras: recebem revisões já lidas do catálogo e devolvem
 * decisões explicáveis, sem tocar em banco, rede ou pixels.
 */

export type RevisionStatus = "candidate" | "approved" | "rejected";

export type ClipFrame = ClipPayload["frames"][number];

export interface RigRef {
  revisionId: string;
  payload: RigPayload;
}

export interface ClipRef {
  revisionId: string;
  assetId: string;
  name: string;
  number: number;
  status: RevisionStatus;
  /** É a revisão ativa (aprovada vigente) do seu asset? */
  active: boolean;
  payload: ClipPayload;
}

export interface OverlayRef {
  revisionId: string;
  assetId: string;
  name: string;
  number: number;
  status: RevisionStatus;
  styleRevisionId: string | null;
  payload: OverlayPayload;
}

export interface Combo {
  action: string;
  direction: Direction;
}

/** Ponteiro exato de uma pendência (04 §critérios: peça, direção, ação, postura e frame). */
export interface Where {
  overlayRevisionId?: string;
  overlayName?: string;
  partId?: string;
  action?: string;
  direction?: Direction;
  stance?: string;
  clipRevisionId?: string;
  frameId?: string;
  slotId?: string;
}

export type PendencyKind =
  | "slot_conflict"
  | "unknown_slot"
  | "incompatible_rig"
  | "stance_none"
  | "stance_ambiguous"
  | "stance_incompatible"
  | "missing_clip"
  | "ambiguous_clip"
  | "missing_coverage"
  | "stale_coverage"
  | "missing_placement"
  | "missing_socket"
  | "socket_deviation"
  | "clipped_outline"
  | "invalid_override"
  | "style_mismatch";

export type ActionKind =
  | "replace_item"
  | "create_coverage"
  | "pick_stance"
  | "create_variant"
  | "pick_variant"
  | "link_shared_clip"
  | "mark_empty"
  | "rebind"
  | "expand_cell"
  | "fix_grips"
  | "reset_order"
  | "review";

export interface Pendency {
  kind: PendencyKind;
  /** `true` = impede compor/exportar a combinação afetada; `false` = aviso revisável. */
  blocking: boolean;
  message: string;
  where: Where;
  action: { kind: ActionKind; label: string };
}

export const ACTION_LABEL: Record<ActionKind, string> = {
  replace_item: "Substituir",
  create_coverage: "Criar cobertura para esta base",
  pick_stance: "Escolher postura",
  create_variant: "Criar variante",
  pick_variant: "Escolher variante",
  link_shared_clip: "Vincular clipe compartilhado",
  mark_empty: "Marcar célula vazia",
  rebind: "Revincular cobertura",
  expand_cell: "Ampliar célula",
  fix_grips: "Ajustar empunhadura",
  reset_order: "Refazer ordem de desenho",
  review: "Revisar",
};

export function comboKey(c: Combo): string {
  return `${c.action}/${c.direction}`;
}

/** Texto curto do ponteiro, para mensagens e relatórios. */
export function describeWhere(w: Where): string {
  const parts = [
    w.overlayName ? `peça "${w.overlayName}"` : null,
    w.partId ? `parte ${w.partId}` : null,
    w.direction ? `direção ${w.direction}` : null,
    w.action ? `ação ${w.action}` : null,
    w.stance ? `postura ${w.stance}` : null,
    w.frameId ? `frame ${w.frameId}` : null,
    w.slotId ? `slot ${w.slotId}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}
