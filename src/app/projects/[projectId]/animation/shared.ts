"use client";

import type { BasePayload, ClipPayload, Direction, GenerationPlan, MotionPayload } from "@/contracts";
import type { animationOverview } from "@/server/animation/service";
import type { RevisionView } from "@/server/catalog/catalog";
import { ApiError, apiFetch } from "@/app/client/api";

/** Tipos e chamadas compartilhados pela página de animação (cartão S1). */

export type Overview = ReturnType<typeof animationOverview>;
export type ProfileInfo = Overview["profiles"][number];
export type AssetEntry = Overview["bases"][number];

export interface PlanPreview {
  plan: GenerationPlan;
  digest: string;
  destination: { name: string; simulated: boolean };
  route: { strategy: "native" | "reference_sheet"; label: string };
  summary: Record<string, unknown>;
  costCheck: { kind: string; withinCeiling: boolean | null };
}

export interface RunResult extends PlanPreview {
  job: { id: string; state: string };
  created: boolean;
  targetAssetId: string;
}

export const DIRS: Direction[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const DIR_LABEL: Record<Direction, string> = { N: "norte", NE: "nordeste", E: "leste", SE: "sudeste", S: "sul", SW: "sudoeste", W: "oeste", NW: "noroeste" };

export function mediaUrl(projectId: string, fileId: string): string {
  return `/api/v1/projects/${projectId}/media/${fileId}`;
}

export function viewUrl(projectId: string, revision: RevisionView, direction: Direction): string | null {
  const view = (revision.payload as BasePayload).views.find((v) => v.direction === direction);
  const file = view ? revision.files.find((f) => f.fileKey === view.fileId) : undefined;
  return file ? mediaUrl(projectId, file.id) : null;
}

export function clipFrameUrls(projectId: string, revision: RevisionView): string[] {
  const clip = revision.payload as ClipPayload;
  return clip.frames.map((f) => {
    const file = revision.files.find((x) => x.fileKey === f.layers[0]!.fileId);
    return file ? mediaUrl(projectId, file.id) : "";
  });
}

export function motionOf(revision: RevisionView): MotionPayload {
  return revision.payload as MotionPayload;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}${err.code ? ` (${err.code})` : ""}`;
  return err instanceof Error ? err.message : String(err);
}

export async function review(projectId: string, assetId: string, revisionId: string, decision: "approve" | "reject", expectedActiveRevisionId: string | null, reason: string | null = null) {
  return apiFetch(`/projects/${projectId}/assets/${assetId}/reviews`, { method: "POST", json: { revisionId, decision, reason, expectedActiveRevisionId } });
}

export function estimateText(plan: GenerationPlan): string {
  const e = plan.limits.estimate;
  if (e.kind === "known") return `${e.amount.amount} ${e.amount.unit}`;
  if (e.kind === "range") return `${e.min.amount}–${e.max.amount} ${e.max.unit}`;
  return `desconhecida (${e.reason})`;
}

/** Caixa do conteúdo (alfa > 0) de uma imagem, para ajustar o esqueleto padrão à base. */
export function contentBox(img: HTMLImageElement): [number, number, number, number] | null {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 0) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}
