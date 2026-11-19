import { tx } from "@/i18n/locales";
import path from "node:path";
import { type BasePayload, DIRECTIONS_8, type GenerationPlan } from "@/contracts";
import { identityWorldToView } from "@/domain/animation/directions";
import { loadBase, ROUTE_LABELS } from "../../../animation/base";
import { type AssetView, getRevision, publishRevision } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { processNativeFrame, processSheet, scaledReference, sheetOf } from "./animation";
import { envOf, mustBlob, partResults, type ProcessedPart } from "./shared";
import type { OperationPipeline } from "./types";

/**
 * Vistas (cartão S1, 04 §quatro/oito vistas): cada plano gera UMA direção
 * nova a partir de uma vista aprovada — arte nova da direção, nunca bitmap
 * girado nem espelho. Publica uma revisão candidata da própria base com as
 * vistas aprovadas intactas (mesmos blobs e IDs) mais a nova; a escolha por
 * vista e a aprovação seguem o fluxo de revisão.
 */

type RotatePlan = Extract<GenerationPlan, { operation: "rotate_views" }>;

async function loadViewInputs(ctx: HandlerContext, plan: RotatePlan) {
  const source = plan.sources.find((s) => s.role === "identity")!;
  const sheet = sheetOf(plan);
  if (!sheet) return [{ role: "source", mime: "image/png", bytes: await ctx.blobs.read(source.sha256) }];
  const bytes = await scaledReference(envOf(ctx), path.join(ctx.workDir, "view-inputs"), source.sha256, sheet.cell, sheet.backgroundKey);
  return [{ role: "identity", mime: "image/png", bytes }];
}

function viewFileKey(direction: string): string {
  return `view-${direction.toLowerCase()}`;
}

function publishView(ctx: HandlerContext, plan: RotatePlan, asset: AssetView, part: PartRow): string[] {
  const direction = plan.params.requestedViews[0]!;
  const rows = partResults(ctx, part.part_key);
  const first = rows[0];
  if (!first) throw new DomainFailure("validation_failed", tx("Resposta sem imagem da vista", "Response has no image for the view"));
  const processed = parseJson<ProcessedPart>(first.processed_json)!;
  const sheet = sheetOf(plan);
  const viewSha = sheet ? (processed.details as { frames: { sha256: string }[] }).frames[0]!.sha256 : processed.normalizedSha256;

  const base = loadBase(ctx.db, ctx.job.project_id, plan.params.identityRevisionId, { approved: false });
  if (base.payload.views.some((v) => v.direction === direction)) throw new DomainFailure("validation_failed", tx(`A base já tem a vista ${direction}`, `The base already has the ${direction} view`));
  const [w, h] = base.payload.logicalSize;
  const fileKey = viewFileKey(direction);
  const views = [...base.payload.views, { direction, fileId: fileKey, rect: [0, 0, w, h] as [number, number, number, number], sourceOffset: [0, 0] as [number, number] }].sort(
    (a, b) => DIRECTIONS_8.indexOf(a.direction) - DIRECTIONS_8.indexOf(b.direction),
  );
  const payload: BasePayload = {
    ...base.payload,
    views,
    orientation: { projection: plan.params.projection, worldToView: plan.params.worldToView ?? base.payload.orientation?.worldToView ?? identityWorldToView() },
  };
  // Vistas aprovadas seguem com os mesmos blobs e chaves; só a nova entra.
  const kept = base.payload.views.map((v) => base.revision.files.find((f) => f.fileKey === v.fileId)!);
  // Índice livre no papel `view` (objetos e estados já guardam as vistas nesse papel).
  const viewIdx = Math.max(-1, ...kept.filter((f) => f.role === "view").map((f) => f.idx)) + 1;
  const files = [
    ...kept.map((f) => ({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: mustBlob(ctx.db, f.sha256) })),
    { fileKey, role: "view", idx: viewIdx, blob: mustBlob(ctx.db, viewSha) },
    ...rows.map((row) => ({ fileKey: `raw-${direction.toLowerCase()}-${row.idx}`, role: "raw", idx: row.idx, blob: mustBlob(ctx.db, row.blob_sha256) })),
  ];
  const revision = publishRevision(ctx.db, ctx.clock, {
    projectId: ctx.job.project_id,
    assetId: asset.id,
    origin: "generation",
    styleRevisionId: plan.styleRevisionId,
    jobAttemptId: ctx.attempt.id,
    predecessorId: base.revision.id,
    payload,
    files,
    edges: [{ toRevisionId: base.revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "rotate_views",
      strategy: sheet ? "reference_sheet" : "native",
      routeLabel: sheet ? ROUTE_LABELS.sheet_rotation : ROUTE_LABELS.native_rotation,
      newView: direction,
      sourceView: plan.params.sourceView ?? null,
      projection: plan.params.projection,
      // Arte nova da direção: nenhum espelho nem rotação de bitmap foi aplicado localmente.
      mirrored: false,
      keptViews: kept.map((f, i) => ({ direction: base.payload.views[i]!.direction, fileKey: f.fileKey, sha256: f.sha256 })),
      asymmetries: plan.params.asymmetries,
      remoteId: part.remote_id,
      receivedSize: processed.receivedSize,
      steps: processed.steps ?? [],
      warnings: processed.warnings,
    },
  });
  return [revision.id];
}

export const rotateViewsPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "rotate_views") throw new Error("inalcançável");
    if (getRevision(db, projectId, plan.params.identityRevisionId).assetId !== asset.id) {
      throw new DomainFailure("validation_failed", tx("A nova vista publica no asset da própria base", "The new view publishes to the base's own asset"));
    }
    if (plan.params.requestedViews.length !== 1) throw new DomainFailure("validation_failed", tx("Uma vista por plano: reprovar uma direção não refaz as outras", "One view per plan: rejecting one direction does not redo the others"));
  },
  loadInputs: (ctx, plan) => loadViewInputs(ctx, plan as RotatePlan),
  process: (env, plan, sha256, dir) => {
    const sheet = sheetOf(plan);
    return sheet ? processSheet(env, plan, sha256, dir, sheet.frameIds) : processNativeFrame(env, plan, sha256, dir);
  },
  publish: (ctx, plan, asset, part) => publishView(ctx, plan as RotatePlan, asset, part),
};
