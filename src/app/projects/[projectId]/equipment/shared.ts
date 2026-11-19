"use client";

import type { Direction, LayerRef } from "@/contracts";
import type { Pendency } from "@/domain/equipment/types";
import type { LoadoutConfig, ResolutionView } from "@/server/equipment/resolve";
import type { equipmentOverview } from "@/server/equipment/service";
import { ApiError, apiFetch } from "@/app/client/api";

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

export const DIR_LABEL: Record<Direction, string> = { N: "norte", NE: "nordeste", E: "leste", SE: "sudeste", S: "sul", SW: "sudoeste", W: "oeste", NW: "noroeste" };

export const STATUS_LABEL: Record<string, string> = {
  ready: "pronta",
  blocked: "bloqueada",
  no_clip: "sem clipe",
  covered: "coberta",
  empty: "vazia explícita",
  missing: "lacuna",
  stale: "a revisar (revisão anterior do clipe)",
  incompatible: "peça de outra base",
};

export function mediaUrl(projectId: string, fileId: string | null): string {
  return fileId ? `/api/v1/projects/${projectId}/media/${fileId}` : "";
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const problems = (err.details?.problems ?? err.details?.pendencies) as { message: string; pointer?: string }[] | undefined;
    const extra = problems?.length ? ` · ${problems.slice(0, 3).map((p) => (p.pointer ? `${p.message} — ${p.pointer}` : p.message)).join(" · ")}` : "";
    return `${err.message}${err.code ? ` (${err.code})` : ""}${extra}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function whereText(p: Pendency): string {
  const w = p.where;
  return [w.overlayName && `peça ${w.overlayName}`, w.partId && `parte ${w.partId}`, w.direction && `direção ${w.direction}`, w.action && `ação ${w.action}`, w.stance && `postura ${w.stance}`, w.frameId && `frame ${w.frameId}`, w.slotId && `slot ${w.slotId}`]
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
