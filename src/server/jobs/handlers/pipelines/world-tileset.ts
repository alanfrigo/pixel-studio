import path from "node:path";
import type { GenerationPlan } from "@/contracts";
import { type AssetView, getAsset, getRevision, getStyleRevision, publishRevision } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { inpaintMarkColor } from "../../../inpaint";
import { checkTilesetGeometry, editRegions, guideUpscale, ROUTE_LABELS } from "../../../world/tileset-core";
import { runWorldPython } from "../../../world/python";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { mustBlob, partResults, type PipelineEnv, type ProcessedPart, python, pythonWith } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";
import { scaledReferences } from "./world-texture";

/**
 * Tileset guiado (cartão T1 · 06 §como gerar e validar um autotile): o
 * gabarito local aprovado vai ao modelo genérico como guia, junto com os
 * materiais aprovados. O candidato volta à grade do atlas, a faixa de borda
 * travada (e o ar/contorno dos losangos) é reaplicada do gabarito, e as
 * emendas são conferidas. Não é geração nativa de tileset e não diz que é.
 */

type TilesetPlan = Extract<GenerationPlan, { operation: "generate_tileset" }>;
const EXPECTED_KIND = { corner: "corner", sidescroller: "sidescroller", isometric: "isometric" } as const;

function guideOf(plan: GenerationPlan) {
  if (plan.operation !== "generate_tileset") throw new Error("inalcançável");
  const guide = plan.params.guide;
  if (!guide) throw new DomainFailure("capability_missing", "Geração nativa de tileset não está disponível nesta rota; gere a partir de um gabarito aprovado");
  const base = plan.sources.find((s) => s.role === "base" && s.revisionId === guide.revisionId);
  if (!base) throw new DomainFailure("validation_failed", "O gabarito precisa estar congelado como primeira fonte do plano");
  return { guide, base };
}

async function loadTilesetInputs(ctx: HandlerContext, plan: GenerationPlan) {
  const { guide } = guideOf(plan);
  const style = getStyleRevision(ctx.db, ctx.job.project_id, plan.styleRevisionId).payload;
  const [w, h] = guide.atlasSize;
  // Gabarito ampliado por fator inteiro, transparência achatada na cor-chave (o "ar" que o modelo deve manter).
  const base = await scaledReferences(ctx, plan, { roles: ["base"], flattenOnto: inpaintMarkColor(style), minSide: Math.min(w, h) * guideUpscale(guide.atlasSize) });
  const materials = await scaledReferences(ctx, plan, { roles: ["material"] });
  return [...base, ...materials];
}

export async function processTilesetCandidate(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult> {
  const { guide, base } = guideOf(plan);
  const steps: Record<string, unknown>[] = [];
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") throw new DomainFailure("validation_failed", `Resposta do provedor não é uma imagem utilizável: ${ingest.message}`, { code: ingest.code });
  const warnings = [...ingest.warnings];
  let candidate = ingest.outputs.find((o) => o.role === "normalized")!;
  const [aw, ah] = guide.atlasSize;
  if (candidate.width !== aw || candidate.height !== ah) {
    const current = await env.blobs.putFile(candidate.absolutePath);
    // Só fator de escala da grade do atlas: proporção diferente é resposta fora da grade, não esticar.
    const fit = await python(env, path.join(dir, "fit"), "fit_logical", current.sha256, { version: 1, targetSize: [aw, ah], exactAspect: true });
    if (fit.status === "error") throw new DomainFailure("validation_failed", fit.message, { code: fit.code });
    candidate = fit.outputs.find((o) => o.role === "fitted")!;
    steps.push({ operation: "fit_logical", ...fit.report });
    warnings.push(...fit.warnings);
  }
  const candidateBlob = await env.blobs.putFile(candidate.absolutePath);
  const mask = await runWorldPython(env, "tile_edit_mask", [{ role: "source", sha256: base.sha256 }], editRegions(guide.geometry, guide.lockedBandPx));
  const maskOut = mask.outputs[0]!;
  const maskBlob = await env.blobs.putBytes(maskOut.bytes);
  const composite = await pythonWith(
    env,
    path.join(dir, "composite"),
    "composite_protected",
    [
      { role: "source", sha256: base.sha256 },
      { role: "candidate", sha256: candidateBlob.sha256 },
      { role: "editMask", sha256: maskBlob.sha256 },
    ],
    { version: 1, maskConvention: "white_edits_black_preserves" },
  );
  if (composite.status === "error") throw new DomainFailure("validation_failed", composite.message, { code: composite.code });
  steps.push({ operation: "composite_protected", ...composite.report });
  warnings.push(...composite.warnings);
  const out = composite.outputs.find((o) => o.role === "protected")!;
  const stored = await env.blobs.putFile(out.absolutePath);
  const check = await checkTilesetGeometry(env, guide.geometry, stored.sha256, { guideSha: base.sha256, lockedBandPx: guide.lockedBandPx });
  warnings.push(...check.warnings);
  const extraBlobs = [
    { blob: candidateBlob, width: aw, height: ah },
    { blob: maskBlob, width: maskOut.width, height: maskOut.height },
  ];
  const previews: { role: string; sha256: string }[] = [];
  for (const o of check.outputs) {
    const blob = await env.blobs.putBytes(o.bytes);
    extraBlobs.push({ blob, width: o.width, height: o.height });
    previews.push({ role: o.role, sha256: blob.sha256 });
  }
  const processed: ProcessedPart = {
    normalizedSha256: stored.sha256,
    width: out.width!,
    height: out.height!,
    ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}),
    receivedSize: ingest.report.size as [number, number],
    fit: null,
    steps,
    warnings,
    candidateSha256: candidateBlob.sha256,
    composite: composite.report,
    details: { check: check.report, previews, maskSha256: maskBlob.sha256, mask: mask.report },
  };
  return { processed, stored, extraBlobs };
}

function publishTileset(ctx: HandlerContext, plan: TilesetPlan, asset: AssetView, part: PartRow): string[] {
  const { guide, base } = guideOf(plan);
  const guideRevision = getRevision(ctx.db, ctx.job.project_id, guide.revisionId);
  const payload = guideRevision.payload as { atlas: { fileId: string } };
  return partResults(ctx, part.part_key)
    .slice(0, 1)
    .map((row) => {
      const processed = parseJson<ProcessedPart>(row.processed_json)!;
      const details = processed.details as { check: Record<string, unknown>; previews: { role: string; sha256: string }[]; maskSha256: string; mask: Record<string, unknown> };
      const revision = publishRevision(ctx.db, ctx.clock, {
        projectId: ctx.job.project_id,
        assetId: asset.id,
        origin: "generation",
        styleRevisionId: plan.styleRevisionId,
        jobAttemptId: ctx.attempt.id,
        predecessorId: guideRevision.id,
        payload: guideRevision.payload,
        files: [
          { fileKey: payload.atlas.fileId, role: "atlas", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) },
          { fileKey: "guided-candidate", role: "candidate", idx: 0, blob: mustBlob(ctx.db, processed.candidateSha256!) },
          { fileKey: "guided-mask", role: "mask", idx: 0, blob: mustBlob(ctx.db, details.maskSha256) },
          { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
          ...details.previews.map((p, idx) => ({ fileKey: `check-${p.role.replace("_", "-")}`, role: "preview", idx, blob: mustBlob(ctx.db, p.sha256) })),
        ],
        edges: [{ toRevisionId: guideRevision.id, role: "guide", ordinal: 0, runtime: false }],
        technicalReport: {
          operation: "generate_tileset",
          kind: asset.kind,
          routeLabel: ROUTE_LABELS.guided,
          guide: { revisionId: guideRevision.id, sha256: base.sha256, lockedBandPx: guide.lockedBandPx },
          remoteId: part.remote_id,
          receivedSize: processed.receivedSize,
          composite: processed.composite,
          editMask: details.mask,
          check: details.check,
          steps: processed.steps ?? [],
          warnings: processed.warnings,
        },
      });
      return revision.id;
    });
}

export const worldTilesetPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "generate_tileset") throw new Error("inalcançável");
    const { guide } = guideOf(plan);
    const guideRevision = getRevision(db, projectId, guide.revisionId);
    if (guideRevision.assetId !== asset.id) throw new DomainFailure("validation_failed", "O resultado guiado é publicado no asset do próprio gabarito");
    const expected = EXPECTED_KIND[plan.params.layout];
    if (asset.family !== "tileset" || asset.kind !== expected) {
      throw new DomainFailure("validation_failed", `Layout ${plan.params.layout} publica tileset/${expected}; o asset é ${asset.family}/${asset.kind}`);
    }
    getAsset(db, projectId, asset.id);
  },
  loadInputs: (ctx, plan) => loadTilesetInputs(ctx, plan),
  process: processTilesetCandidate,
  publish: (ctx, plan, asset, part) => publishTileset(ctx, plan as TilesetPlan, asset, part),
};
