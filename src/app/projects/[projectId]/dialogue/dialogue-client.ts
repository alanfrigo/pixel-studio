"use client";

import type { SpeechTiming } from "@/contracts";
import type { LocalizedText } from "@/i18n/locales";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";

export { errorText, fileOf, mediaUrl, PIXEL, type PlanPreview, type Profile, review, runPlan, uploadImage } from "../world/world-client";

/** Tipos e chamadas da bancada de diálogo e tipografia (cartão D1). */

export interface Entry {
  asset: AssetView;
  revisions: RevisionView[];
}

export interface SpeechEntry {
  asset: AssetView;
  revisions: (RevisionView & { verify: { reproducible: boolean; totalMs: number } | null })[];
}

export interface DialogueCatalog {
  characters: Entry[];
  portraits: Entry[];
  expressions: Entry[];
  speeches: SpeechEntry[];
  fonts: Entry[];
  visemes: { ids: string[]; set: string };
  speechRule: { rule: string; defaults: SpeechTiming; label: LocalizedText };
  fontTestStrings: string[];
}

export const dialogueApi = (projectId: string, path = "") => `/projects/${projectId}/dialogue${path}`;

/** Revisões aprovadas de uma lista, mais recentes primeiro (com o asset junto). */
export function approvedRevisions(entries: Entry[]) {
  return entries
    .flatMap(({ asset, revisions }) => revisions.filter((r) => r.status === "approved").map((revision) => ({ asset, revision })))
    .sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt));
}

/** Todas as revisões, mais recentes primeiro. */
export function allRevisions<R extends RevisionView>(entries: { asset: AssetView; revisions: R[] }[]): { asset: AssetView; revision: R }[] {
  return entries.flatMap(({ asset, revisions }) => revisions.map((revision) => ({ asset, revision }))).sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt));
}

export const rectText = (r: readonly number[] | undefined) => (r ? r.join(",") : "");

export function parseRect(text: string): [number, number, number, number] | null {
  const parts = text.split(",").map((n) => Number(n.trim()));
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0) && parts[2]! > 0 && parts[3]! > 0 ? (parts as [number, number, number, number]) : null;
}

export const pct = (ratio: number | null | undefined) => (ratio === null || ratio === undefined ? "—" : `${(ratio * 100).toFixed(1)}%`);
