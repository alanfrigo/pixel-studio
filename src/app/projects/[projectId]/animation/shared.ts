"use client";

import type { BasePayload, ClipPayload, Direction, GenerationPlan, MotionPayload } from "@/contracts";
import type { animationOverview } from "@/server/animation/service";
import type { RevisionView } from "@/server/catalog/catalog";
import { ApiError, apiFetch } from "@/app/client/api";
import { type Locale, pick, type TextValue } from "@/i18n/locales";
import { commonMessages } from "@/i18n/messages/common";

/** Tipos e chamadas compartilhados pela página de animação (cartão S1). */

export type Overview = ReturnType<typeof animationOverview>;
export type ProfileInfo = Overview["profiles"][number];
export type AssetEntry = Overview["bases"][number];

export interface PlanPreview {
  plan: GenerationPlan;
  digest: string;
  destination: { name: string; simulated: boolean };
  /** Rótulo da rota: bilíngue (servidor atual) ou texto gravado num idioma só. */
  route: { strategy: "native" | "reference_sheet"; label: TextValue };
  summary: Record<string, unknown>;
  costCheck: { kind: string; withinCeiling: boolean | null };
}

export interface RunResult extends PlanPreview {
  job: { id: string; state: string };
  created: boolean;
  targetAssetId: string;
}

export const DIRS: Direction[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

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

export { estimateText } from "@/app/client/cost";

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

// ---------------------------------------------------------------------------
// Cartão S3: quadros por camada, uploads e busca de revisões na visão geral
// ---------------------------------------------------------------------------

export interface LayerDraw {
  src: string;
  rect: [number, number, number, number];
  offset: [number, number];
}

/** Camadas de cada quadro (trás → frente) com o arquivo, o retângulo e a posição na célula. */
export function clipFrameLayers(projectId: string, revision: RevisionView): LayerDraw[][] {
  const clip = revision.payload as ClipPayload;
  return clip.frames.map((f) =>
    f.layers.map((l) => {
      const file = revision.files.find((x) => x.fileKey === l.fileId);
      return { src: file ? mediaUrl(projectId, file.id) : "", rect: l.rect, offset: l.offset };
    }),
  );
}

/** Envia um PNG como upload do projeto e espera a normalização (máscara, imagem de objeto). */
export async function uploadPng(projectId: string, bytes: Uint8Array | Blob, name: string, locale: Locale): Promise<string> {
  const m = commonMessages[locale].upload;
  const form = new FormData();
  form.append("file", bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: "image/png" }), name);
  const res = await fetch(`/api/v1/projects/${projectId}/uploads`, { method: "POST", body: form });
  const body = (await res.json()) as { upload?: { id: string }; message?: string };
  if (!res.ok || !body.upload) throw new Error(body.message ?? m.failed);
  for (let i = 0; i < 60; i++) {
    const { upload } = await apiFetch<{ upload: { id: string; status: string } }>(`/projects/${projectId}/uploads/${body.upload.id}`);
    if (upload.status === "ready") return upload.id;
    if (upload.status === "rejected") throw new Error(m.rejected);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(m.timeout);
}

export function findRevision(data: Overview, revisionId: string | null | undefined): { asset: AssetEntry["asset"]; revision: RevisionView } | null {
  if (!revisionId) return null;
  for (const entry of [...data.bases, ...data.clips]) {
    const revision = entry.revisions.find((r) => r.id === revisionId);
    if (revision) return { asset: entry.asset, revision };
  }
  return null;
}

export function isObject(entry: AssetEntry): boolean {
  return entry.revisions.some((r) => (r.payload as BasePayload).subject === "object");
}

/** Rota de um perfil no idioma da tela (o servidor pode mandar o rótulo bilíngue ou texto simples). */
export function routeLabel(profile: ProfileInfo, key: string, locale: Locale): { ok: boolean; text: string; strategy?: string } {
  const r = profile.routes[key];
  if (!r) return { ok: false, text: commonMessages[locale].unavailable };
  return "label" in r ? { ok: true, text: pick(r.label as TextValue, locale), strategy: r.strategy } : { ok: false, text: pick(r.unavailable as TextValue, locale) };
}
