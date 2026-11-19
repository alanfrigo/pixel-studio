"use client";

import type { GenerationPlan } from "@/contracts";
import type { AssetView, RevisionView, UploadView } from "@/server/catalog/catalog";
import type { JobView } from "@/server/jobs/queue";
import type { ProviderProfileView } from "@/server/providers/registry";
import type { CSSProperties } from "react";
import { apiFetch } from "@/app/client/api";
import type { Locale, TextValue } from "@/i18n/locales";
import { commonMessages } from "@/i18n/messages/common";

/** Tipos e chamadas compartilhados pela página do mundo (T1). */

export interface WorldCatalog {
  textures: { asset: AssetView; revisions: RevisionView[] }[];
  tilesets: { asset: AssetView; revisions: RevisionView[] }[];
  objects: { asset: AssetView; revisions: RevisionView[] }[];
  maps: { asset: AssetView; revisions: { id: string; number: number; status: string; createdAt: string; technicalReport: unknown }[] }[];
}

export type Profile = ProviderProfileView & { capabilities: Record<string, string[]>; unavailable: TextValue | null };

export interface PlanPreview {
  plan: GenerationPlan;
  digest: string;
  destination: { name: string; simulated: boolean };
  /** Rótulo da rota: bilíngue (servidor atual) ou texto gravado num idioma só. */
  routeLabel?: TextValue;
  targetAssetId?: string;
}

export const mediaUrl = (projectId: string, fileId: string) => `/api/v1/projects/${projectId}/media/${fileId}`;

export function fileOf(revision: Pick<RevisionView, "files">, key: string) {
  return revision.files.find((f) => f.fileKey === key) ?? null;
}

/** Envia uma imagem como upload e espera a normalização (mesmo fluxo do inpainting). */
export async function uploadImage(projectId: string, file: Blob, name: string, locale: Locale): Promise<string> {
  const m = commonMessages[locale].upload;
  const form = new FormData();
  form.append("file", file, name);
  const res = await fetch(`/api/v1/projects/${projectId}/uploads`, { method: "POST", body: form });
  const body = (await res.json()) as { upload?: UploadView; message?: string };
  if (!res.ok || !body.upload) throw new Error(body.message ?? m.failed);
  for (let i = 0; i < 80; i++) {
    const { upload } = await apiFetch<{ upload: UploadView }>(`/projects/${projectId}/uploads/${body.upload.id}`);
    if (upload.status === "ready") return upload.id;
    if (upload.status === "rejected") throw new Error(m.rejected);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(m.timeoutWorker);
}

export async function review(projectId: string, asset: AssetView, revisionId: string, decision: "approve" | "reject", reason: string | null = null) {
  return apiFetch(`/projects/${projectId}/assets/${asset.id}/reviews`, {
    method: "POST",
    json: { revisionId, decision, reason, expectedActiveRevisionId: asset.approvedRevisionId },
  });
}

export async function runPlan(projectId: string, preview: PlanPreview, targetAssetId: string): Promise<{ job: JobView; created: boolean }> {
  return apiFetch(`/projects/${projectId}/jobs`, {
    method: "POST",
    // Mesmo plano = mesmo job: duplo clique não cobra duas vezes.
    headers: { "idempotency-key": `world:${preview.digest}` },
    json: { kind: "generation", request: { plan: preview.plan, planDigest: preview.digest, targetAssetId } },
  });
}

export { estimateText as estimateLabel } from "@/app/client/cost";

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const PIXEL: CSSProperties = { imageRendering: "pixelated" };
