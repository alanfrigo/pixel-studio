"use client";

import type { RevisionView } from "@/server/catalog/catalog";
import type { ImageChoice, UiEntry } from "@/server/ui/screens";
import { apiFetch } from "@/app/client/api";

export { errorText, mediaUrl, PIXEL, type PlanPreview, type Profile, review, runPlan } from "../world/world-client";
export type { ImageChoice, UiEntry };

/** Tipos e chamadas do kit de UI (cartão U3). */

export interface UiCatalog {
  components: UiEntry[];
  templates: UiEntry[];
  screens: UiEntry[];
  images: ImageChoice[];
  backgrounds: ImageChoice[];
  palette: string[];
  focusColor: string;
}

export const uiApi = (projectId: string, path = "") => `/projects/${projectId}/ui${path}`;

export function loadCatalog(projectId: string): Promise<UiCatalog> {
  return apiFetch<UiCatalog>(uiApi(projectId));
}

/** URL de mídia de um arquivo da revisão pela chave citada no payload. */
export function fileUrl(projectId: string, revision: Pick<RevisionView, "files">, fileKey: string): string | null {
  const file = revision.files.find((f) => f.fileKey === fileKey);
  return file ? `/api/v1/projects/${projectId}/media/${file.id}` : null;
}

export function approvedOf(entry: UiEntry): RevisionView | null {
  return entry.revisions.find((r) => r.id === entry.asset.approvedRevisionId) ?? null;
}

/** Revisões aprovadas de componentes de um tipo, mais recentes primeiro. */
export function approvedRevisions(entries: UiEntry[], kinds: string[]) {
  return entries
    .filter((e) => kinds.includes(e.asset.kind))
    .flatMap((e) => e.revisions.filter((r) => r.status === "approved").map((revision) => ({ asset: e.asset, revision })));
}

/** Revisão → asset e payload, para o compositor e as prévias. */
export function revisionIndex(catalog: UiCatalog) {
  const map = new Map<string, { asset: UiEntry["asset"]; revision: RevisionView }>();
  for (const e of [...catalog.components, ...catalog.templates, ...catalog.screens]) for (const r of e.revisions) map.set(r.id, { asset: e.asset, revision: r });
  return map;
}

export function issuesText(details: Record<string, unknown> | undefined): string | null {
  const issues = details?.issues as { path: string[]; message: string }[] | undefined;
  return issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ") : null;
}
