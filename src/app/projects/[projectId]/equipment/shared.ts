"use client";

import type { LayerRef } from "@/contracts";
import type { Pendency } from "@/domain/equipment/types";
import type { LoadoutConfig, ResolutionView } from "@/server/equipment/resolve";
import type { equipmentOverview } from "@/server/equipment/service";
import { ApiError, apiFetch } from "@/app/client/api";
import { type Locale, pick, type TextValue } from "@/i18n/locales";
import { equipmentMessages } from "@/i18n/messages/equipment";

/** Tipos e chamadas da página de equipamentos (cartão S2). */

export type Overview = ReturnType<typeof equipmentOverview>;
export type RigInfo = Overview["rigs"][number];
export type OverlayGroup = Overview["overlays"][number];
export type OverlayRev = OverlayGroup["revisions"][number];
export type LoadoutGroup = Overview["loadouts"][number];
export type ClipInfo = Overview["clips"][number];
export type View = ResolutionView;
export type ComboView = View["combos"][number];
export type FrameView = ComboView["frames"][number];
export type LayerView = FrameView["layers"][number];
export type Config = LoadoutConfig;
export type { Pendency };

export function mediaUrl(projectId: string, fileId: string | null): string {
  return fileId ? `/api/v1/projects/${projectId}/media/${fileId}` : "";
}

/** Mensagem de erro da API com até três problemas/pendências (podem vir bilíngues). */
export function errorText(err: unknown, locale: Locale): string {
  if (err instanceof ApiError) {
    const problems = (err.details?.problems ?? err.details?.pendencies) as { message: TextValue; pointer?: string }[] | undefined;
    const extra = problems?.length ? ` · ${problems.slice(0, 3).map((p) => (p.pointer ? `${pick(p.message, locale)} — ${p.pointer}` : pick(p.message, locale))).join(" · ")}` : "";
    return `${err.message}${err.code ? ` (${err.code})` : ""}${extra}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function whereText(p: Pendency, locale: Locale): string {
  const w = p.where;
  const m = equipmentMessages[locale].shared.where;
  return [w.overlayName && m.piece(w.overlayName), w.partId && m.part(w.partId), w.direction && m.direction(w.direction), w.action && m.action(w.action), w.stance && m.stance(w.stance), w.frameId && m.frame(w.frameId), w.slotId && m.slot(w.slotId)]
    .filter(Boolean)
    .join(" · ");
}

export async function review(projectId: string, assetId: string, revisionId: string, decision: "approve" | "reject", expectedActiveRevisionId: string | null, reason: string | null = null) {
  return apiFetch(`/projects/${projectId}/assets/${assetId}/reviews`, { method: "POST", json: { revisionId, decision, reason, expectedActiveRevisionId } });
}

export function resolve(projectId: string, request: { loadoutRevisionId: string } | { config: Config }, equip?: string) {
  return apiFetch<{ view: View; config?: Config; replacement?: { removed: string[]; incoming: string; overlayRevisionIds: string[] } }>(`/projects/${projectId}/equipment/resolve`, {
    method: "POST",
    json: { request, ...(equip ? { equip } : {}) },
  });
}

export function layerRefKey(ref: LayerRef): string {
  return ref.kind === "base" ? `base:${ref.partId}` : ref.kind === "part" ? `part:${ref.overlayRevisionId}:${ref.partId}` : `rigid:${ref.overlayRevisionId}`;
}

/** Config de rascunho a partir de um conjunto publicado (para editar e publicar nova revisão). */
export function configOf(group: LoadoutGroup["revisions"][number]): Config {
  return {
    rigRevisionId: group.rigRevisionId,
    overlayRevisionIds: group.overlayRevisionIds,
    stance: group.stancePolicy === "pinned" ? group.stance : null,
    pins: group.clips.map((c) => ({ action: c.action, direction: c.direction, clipRevisionId: c.clipRevisionId })),
    combos: [...group.clips, ...group.omitted].map((c) => ({ action: c.action, direction: c.direction })),
    ...(group.drawOrder.length ? { drawOrder: group.drawOrder } : {}),
  };
}
