import path from "node:path";
import type { GenerationPlan } from "@/contracts";
import { pick, tx } from "@/i18n/locales";
import { type AssetView, publishRevision } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { ROOM_GUIDE_COLORS, ROOM_ROUTE_LABELS } from "../../../scenes/core";
import { genericRoomPayload } from "../../../scenes/room-payload";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { normalizeCanvas, outputBytes } from "./scene-shared";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, pythonWith } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";
import { scaledReferences } from "./world-texture";

/**
 * Sala (cartão T2 · 06 §sala mobiliada): a planta vira guia raster (primeira
 * referência) e o modelo pinta por cima; a grade declarada é a da guia, e a
 * guia em 1× fica no histórico para conferir o alinhamento da pintura.
 */

type RoomPlan = Extract<GenerationPlan, { operation: "generate_room" }>;

function roomPlan(plan: GenerationPlan): RoomPlan {
  if (plan.operation !== "generate_room") throw new Error("inalcançável");
  return plan;
}

/** Guia raster ampliada por fator inteiro (lado menor ≥ 512 px, maior ≤ 2048). */
export function guideRecipe(plan: RoomPlan, scale: number) {
  const g = plan.params.guide;
  return {
    version: 1,
    projection: plan.params.projection,
    pictureSize: [g.pictureSize[0] * scale, g.pictureSize[1] * scale],
    cellPx: [g.cellPx[0] * scale, g.cellPx[1] * scale],
    gridOrigin: [g.gridOrigin[0] * scale, g.gridOrigin[1] * scale],
    size: plan.params.floorPlan.size,
    cells: plan.params.floorPlan.cells,
    doors: plan.params.doors.map((d) => ({ cell: d.cell, side: d.side })),
    colors: { ...ROOM_GUIDE_COLORS, rock: g.backgroundKey },
  };
}

export function guideScale([w, h]: readonly [number, number]): number {
  return Math.max(1, Math.min(Math.floor(2048 / Math.max(w, h)), Math.ceil(512 / Math.min(w, h))));
}

async function renderGuide(env: PipelineEnv, plan: RoomPlan, dir: string, scale: number) {
  const run = await pythonWith(env, dir, "room_guide", [], guideRecipe(plan, scale));
  if (run.status === "error") throw new DomainFailure("validation_failed", tx(`Guia da planta: ${pick(run.message, "pt-BR")}`, `Floor plan guide: ${pick(run.message, "en")}`), { code: run.code });
  return outputBytes(run, "guide");
}

async function loadRoomInputs(ctx: HandlerContext, plan: GenerationPlan) {
  const p = roomPlan(plan);
  const guide = await renderGuide(envOf(ctx), p, path.join(ctx.workDir, "room-guide"), guideScale(p.params.guide.pictureSize));
  return [{ role: "base", mime: "image/png", bytes: guide.bytes }, ...(await scaledReferences(ctx, plan, { roles: ["style"] }))];
}

async function processRoom(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult> {
  const p = roomPlan(plan);
  const g = p.params.guide;
  const result = await normalizeCanvas(env, sha256, dir, { size: g.pictureSize, key: g.backgroundKey, alphaThreshold: 128 });
  // A guia em 1× fica junto (comparação da grade declarada com a pintura).
  const guide = await renderGuide(env, p, path.join(dir, "guide"), 1);
  const blob = await env.blobs.putBytes(guide.bytes);
  return {
    processed: { ...result.processed, details: { guideSha256: blob.sha256 } },
    stored: result.stored,
    extraBlobs: [{ blob, width: guide.width, height: guide.height }],
  };
}

function publishRoom(ctx: HandlerContext, plan: RoomPlan, asset: AssetView, part: PartRow): string[] {
  const p = plan.params;
  const [row] = partResults(ctx, part.part_key);
  if (!row) throw new DomainFailure("provider_rejected", tx("O provedor não devolveu a imagem da sala", "The provider did not return the room image"));
  const image = { row, processed: parseJson<ProcessedPart>(row.processed_json)! };
  const params = { theme: p.theme, projection: p.projection, tileSize: p.tileSize, doors: p.doors, floorPlan: p.floorPlan, styleRoomRevisionId: p.styleRoomRevisionId };
  const payload = genericRoomPayload({ params, grid: { pictureSize: [image.processed.width, image.processed.height], cellPx: p.guide.cellPx, gridOrigin: p.guide.gridOrigin } });
  const guideSha = (image.processed.details as { guideSha256?: string } | undefined)?.guideSha256;
  const revision = publishRevision(ctx.db, ctx.clock, {
    projectId: ctx.job.project_id,
    assetId: asset.id,
    origin: "generation",
    styleRevisionId: plan.styleRevisionId,
    jobAttemptId: ctx.attempt.id,
    payload,
    files: [
      { fileKey: "picture", role: "normalized", idx: 0, blob: mustBlob(ctx.db, image.processed.normalizedSha256) },
      { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, image.row.blob_sha256) },
      ...(guideSha ? [{ fileKey: "guide", role: "preview", idx: 0, blob: mustBlob(ctx.db, guideSha) }] : []),
    ],
    ...(p.styleRoomRevisionId ? { edges: [{ toRevisionId: p.styleRoomRevisionId, role: "style_room", ordinal: 0, runtime: false }] } : {}),
    technicalReport: {
      operation: "generate_room",
      routeLabel: ROOM_ROUTE_LABELS.generic,
      grid: "declarada pela guia raster (confira o alinhamento da pintura)",
      partKey: part.part_key,
      remoteId: part.remote_id,
      styleRoomRevisionId: p.styleRoomRevisionId,
      receivedSize: image.processed.receivedSize,
      steps: image.processed.steps ?? [],
      warnings: image.processed.warnings,
    },
  });
  return [revision.id];
}

export const roomPipeline: OperationPipeline = {
  validateTarget({ plan, asset }) {
    roomPlan(plan);
    if (asset.family !== "map" || asset.kind !== "room") throw new DomainFailure("validation_failed", tx(`Sala publica em map/room; o asset é ${asset.family}/${asset.kind}`, `A room publishes to map/room; the asset is ${asset.family}/${asset.kind}`));
  },
  loadInputs: (ctx, plan) => loadRoomInputs(ctx, plan),
  process: processRoom,
  publish: (ctx, plan, asset, part) => publishRoom(ctx, roomPlan(plan), asset, part),
};
