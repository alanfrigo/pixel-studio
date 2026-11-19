"use client";

import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import type { TextValue } from "@/i18n/locales";

export { errorText, estimateLabel, fileOf, mediaUrl, PIXEL, type PlanPreview, type Profile, review, runPlan, uploadImage } from "../world/world-client";

/** Tipos e chamadas da página de cenas, salas e móveis (cartão T2). */

export interface Entry {
  asset: AssetView;
  revisions: RevisionView[];
}

export interface ScenesCatalog {
  scenes: Entry[];
  layers: Entry[];
  rooms: Entry[];
  objects: Entry[];
  characters: Entry[];
  cornerTilesets: { asset: AssetView; revisions: { id: string; number: number; status: string; technicalReport: unknown }[] }[];
  isoMaps: AssetView[];
}

export const scenesApi = (projectId: string, path = "") => `/projects/${projectId}/scenes${path}`;

/** Cria o asset de destino (família `map`, tipo do T2) para uma geração. */
export async function createAsset(projectId: string, kind: "scene" | "scene_layer" | "room" | "object", name: string): Promise<AssetView> {
  const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/assets`, { method: "POST", json: { family: "map", kind, name } });
  return asset;
}

/** Revisões de todos os assets de uma lista, mais recentes primeiro (com o asset junto). */
export function flatRevisions(entries: Entry[], filter: (r: RevisionView) => boolean = () => true) {
  return entries
    .flatMap(({ asset, revisions }) => revisions.filter(filter).map((revision) => ({ asset, revision })))
    .sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt));
}

/** Rótulo do relatório técnico: bilíngue (servidor atual) ou texto gravado num idioma só. */
export function reportLabel(revision: RevisionView): TextValue | null {
  const tr = revision.technicalReport as { routeLabel?: TextValue; label?: TextValue } | null;
  return tr?.label ?? tr?.routeLabel ?? null;
}

export const SIDES = ["N", "E", "S", "W"] as const;
export type Side = (typeof SIDES)[number];
