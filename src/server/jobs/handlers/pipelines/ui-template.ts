import path from "node:path";
import { type GenerationPlan, type TemplateCell, TemplatePayload } from "@/contracts";
import { tx } from "@/i18n/locales";
import { type AssetView, publishRevision } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { UI_ROUTE_LABELS } from "../../../ui/core";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { guideScale } from "./room";
import { normalizeCanvas, outputBytes } from "./scene-shared";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, pythonWith } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";
import { scaledReferences } from "./world-texture";

/**
 * Template de UI (cartão U3 · 07 §template → split): o layout declarado vira
 * guia raster (primeira referência) e o modelo pinta as peças nas células. O
 * resultado é UMA imagem achatada, publicada como `ui/template` com a proposta
 * de separação; nenhuma peça vira componente sem o recorte local revisado.
 */

type TemplatePlan = Extract<GenerationPlan, { operation: "generate_ui_template" }>;

function templatePlan(plan: GenerationPlan): TemplatePlan {
  if (plan.operation !== "generate_ui_template" || !plan.params.guide) throw new Error("inalcançável");
  return plan;
}

/** Células do plano no formato do payload (a parte da barra é declarada; o resto é peça inteira). */
export function templateCells(plan: TemplatePlan): TemplateCell[] {
  return plan.params.requestedComponents.map((c) => ({
    localId: c.localId,
    componentId: c.componentId ?? c.localId,
    componentType: c.componentType,
    meterPart: c.meterPart ?? null,
    cell: c.cell!,
    requiredStates: c.requiredStates,
  }));
}

async function renderGuide(env: PipelineEnv, plan: TemplatePlan, dir: string, scale: number) {
  const run = await pythonWith(env, dir, "ui_template_guide", [], {
    version: 1,
    size: plan.params.logicalSize,
    scale,
    backgroundKey: plan.params.guide!.backgroundKey,
    cells: templateCells(plan).map((c) => ({ localId: c.localId, rect: c.cell, kind: c.meterPart === "fill" ? "fill" : c.meterPart === "frame" ? "frame" : "piece" })),
  });
  if (run.status === "error") throw new DomainFailure("validation_failed", run.message, { code: run.code });
  return outputBytes(run, "guide");
}

async function loadTemplateInputs(ctx: HandlerContext, plan: GenerationPlan) {
  const p = templatePlan(plan);
  const guide = await renderGuide(envOf(ctx), p, path.join(ctx.workDir, "ui-guide"), guideScale(p.params.logicalSize));
  return [{ role: "base", mime: "image/png", bytes: guide.bytes }, ...(await scaledReferences(ctx, plan, { roles: ["style"] }))];
}

async function processTemplate(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult> {
  const p = templatePlan(plan);
  const key = p.params.guide!.backgroundKey;
  const result = await normalizeCanvas(env, sha256, dir, { size: p.params.logicalSize, key, alphaThreshold: 128 });
  const cells = templateCells(p);
  const split = await pythonWith(env, path.join(dir, "split"), "ui_template_split", [{ role: "source", sha256: result.stored.sha256 }], {
    version: 1,
    cells: cells.map((c) => ({ localId: c.localId, rect: c.cell })),
    zoom: 4,
    backgroundKey: key,
  });
  if (split.status === "error") throw new DomainFailure("validation_failed", split.message, { code: split.code });
  const cleaned = await outputBytes(split, "cleaned");
  const preview = await outputBytes(split, "preview");
  const guide = await renderGuide(env, p, path.join(dir, "guide"), 1);
  const stored = await env.blobs.putBytes(cleaned.bytes);
  const extras = [];
  const keys: Record<string, string> = {};
  for (const [name, out] of [["preview", preview], ["guide", guide]] as const) {
    const blob = await env.blobs.putBytes(out.bytes);
    extras.push({ blob, width: out.width, height: out.height });
    keys[name] = blob.sha256;
  }
  const processed: ProcessedPart = {
    ...result.processed,
    normalizedSha256: stored.sha256,
    warnings: [...result.processed.warnings, ...split.warnings],
    steps: [...(result.processed.steps ?? []), { operation: "ui_template_split", ...split.report }],
    details: { proposals: split.report.proposals, spillPixels: split.report.spillPixels, previewSha256: keys.preview, guideSha256: keys.guide },
  };
  return { processed, stored, extraBlobs: extras };
}

function publishTemplate(ctx: HandlerContext, plan: TemplatePlan, asset: AssetView, part: PartRow): string[] {
  const [row] = partResults(ctx, part.part_key);
  if (!row) throw new DomainFailure("provider_rejected", tx("O provedor não devolveu a imagem do template", "The provider returned no template image"));
  const processed = parseJson<ProcessedPart>(row.processed_json)!;
  const details = processed.details as { proposals: { localId: string; rect: [number, number, number, number] | null; touchesCellEdge: boolean }[]; spillPixels: number; previewSha256: string; guideSha256: string };
  const [w, h] = [processed.width, processed.height];
  const payload = TemplatePayload.parse({
    logicalSize: [w, h],
    image: { fileId: "template", rect: [0, 0, w, h] },
    flattened: true,
    cells: templateCells(plan),
    proposals: details.proposals.map((p) => ({ localId: p.localId, rect: p.rect, touchesCellEdge: p.touchesCellEdge })),
  });
  const revision = publishRevision(ctx.db, ctx.clock, {
    projectId: ctx.job.project_id,
    assetId: asset.id,
    origin: "generation",
    styleRevisionId: plan.styleRevisionId,
    jobAttemptId: ctx.attempt.id,
    payload,
    files: [
      { fileKey: "template", role: "normalized", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) },
      { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
      { fileKey: "split-preview", role: "preview", idx: 0, blob: mustBlob(ctx.db, details.previewSha256) },
      { fileKey: "guide", role: "preview", idx: 1, blob: mustBlob(ctx.db, details.guideSha256) },
    ],
    edges: plan.sources.map((s, ordinal) => ({ toRevisionId: s.revisionId, role: "style", ordinal, runtime: false })),
    technicalReport: {
      operation: "generate_ui_template",
      routeLabel: UI_ROUTE_LABELS.template,
      flattened: tx("Imagem achatada: ainda não é um conjunto de componentes editáveis", "Flat image: not yet a set of editable components"),
      partKey: part.part_key,
      remoteId: part.remote_id,
      requestedSize: plan.params.logicalSize,
      receivedSize: processed.receivedSize,
      proposals: details.proposals,
      spillPixels: details.spillPixels,
      steps: processed.steps ?? [],
      warnings: processed.warnings,
    },
  });
  return [revision.id];
}

export const uiTemplatePipeline: OperationPipeline = {
  validateTarget({ plan, asset }) {
    templatePlan(plan);
    if (asset.family !== "ui" || asset.kind !== "template") {
      throw new DomainFailure("validation_failed", tx(`O template publica em ui/template; o asset é ${asset.family}/${asset.kind}`, `The template publishes to ui/template; the asset is ${asset.family}/${asset.kind}`));
    }
  },
  loadInputs: (ctx, plan) => loadTemplateInputs(ctx, plan),
  process: processTemplate,
  publish: (ctx, plan, asset, part) => publishTemplate(ctx, templatePlan(plan), asset, part),
};
