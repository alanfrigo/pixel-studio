import type { ClipPayload, Direction, OverlayPayload, RigPayload } from "@/contracts";
import { type LocalizedText, tx } from "@/i18n/locales";

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
  /** Texto nos dois idiomas; a interface escolhe o do usuário. */
  message: LocalizedText;
  where: Where;
  action: { kind: ActionKind; label: LocalizedText };
}

export const ACTION_LABEL: Record<ActionKind, LocalizedText> = {
  replace_item: tx("Substituir", "Replace"),
  create_coverage: tx("Criar cobertura para esta base", "Create coverage for this base"),
  pick_stance: tx("Escolher postura", "Choose stance"),
  create_variant: tx("Criar variante", "Create variant"),
  pick_variant: tx("Escolher variante", "Choose variant"),
  link_shared_clip: tx("Vincular clipe compartilhado", "Link shared clip"),
  mark_empty: tx("Marcar célula vazia", "Mark cell empty"),
  rebind: tx("Revincular cobertura", "Rebind coverage"),
  expand_cell: tx("Ampliar célula", "Enlarge cell"),
  fix_grips: tx("Ajustar empunhadura", "Adjust grip"),
  reset_order: tx("Refazer ordem de desenho", "Redo draw order"),
  review: tx("Revisar", "Review"),
};

export function comboKey(c: Combo): string {
  return `${c.action}/${c.direction}`;
}

/** Texto curto do ponteiro, para mensagens e relatórios. */
export function describeWhere(w: Where): LocalizedText {
  const parts = [
    w.overlayName ? tx(`peça "${w.overlayName}"`, `piece "${w.overlayName}"`) : null,
    w.partId ? tx(`parte ${w.partId}`, `part ${w.partId}`) : null,
    w.direction ? tx(`direção ${w.direction}`, `direction ${w.direction}`) : null,
    w.action ? tx(`ação ${w.action}`, `action ${w.action}`) : null,
    w.stance ? tx(`postura ${w.stance}`, `stance ${w.stance}`) : null,
    w.frameId ? tx(`frame ${w.frameId}`, `frame ${w.frameId}`) : null,
    w.slotId ? tx(`slot ${w.slotId}`, `slot ${w.slotId}`) : null,
  ].filter((p) => p !== null);
  return tx(parts.map((p) => p["pt-BR"]).join(" · "), parts.map((p) => p.en).join(" · "));
}
