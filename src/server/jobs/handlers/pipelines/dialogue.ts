import path from "node:path";
import type { ExpressionPayload, GenerationPlan, PortraitPayload, Rect } from "@/contracts";
import { tx } from "@/i18n/locales";
import { type AssetView, publishRevision } from "../../../catalog/catalog";
import { DIALOGUE_ROUTE_LABELS, MOUTH_MARK } from "../../../dialogue/core";
import { DomainFailure } from "../../../errors";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { normalizeCanvas, outputBytes } from "./scene-shared";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, pythonWith } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";
import { scaledReferences } from "./world-texture";

/**
 * Retrato e folha de bocas (cartão D1) pela rota genérica:
 * - retrato: imagem + referência da vista aprovada do personagem → grade
 *   lógica → conferência local (paleta, escala, regiões sugeridas);
 * - expressão: retrato aprovado + guia (retrato repetido na grade 4 × 2 com a
 *   boca marcada) → folha fatiada na grade declarada, com estabilidade do rosto
 *   medida fora da boca (× repouso) e fora do rosto (× retrato).
 * Cada expressão é uma revisão candidata própria, aprovada pelo fluxo normal.
 */

type PortraitPlan = Extract<GenerationPlan, { operation: "generate_portrait" }>;
type VisemesPlan = Extract<GenerationPlan, { operation: "generate_visemes" }>;

/** Limites dos avisos de estabilidade: fração de pixels alterados fora da boca (na folha) e fora do rosto (× retrato). */
export const STABILITY_THRESHOLDS = { outsideMouth: 0.02, outsideFace: 0.05 } as const;

async function extra(env: PipelineEnv, result: { outputs: { role: string; key?: string; absolutePath: string; width?: number; height?: number }[] }, role: string) {
  const out = await outputBytes(result, role);
  const blob = await env.blobs.putBytes(out.bytes);
  return { blob, width: out.width, height: out.height };
}

// ---------------------------------------------------------------------------
// Retrato
// ---------------------------------------------------------------------------

async function processPortrait(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult> {
  if (plan.operation !== "generate_portrait") throw new Error("inalcançável");
  const p = plan.params;
  const result = await normalizeCanvas(env, sha256, dir, { size: p.logicalSize, key: p.backgroundKey ?? null, alphaThreshold: p.transparent ? 128 : null });
  const character = plan.sources.find((s) => s.role === "identity")!;
  const check = await pythonWith(env, path.join(dir, "check"), "portrait_check", [
    { role: "source", sha256: result.stored.sha256 },
    { role: "layer", sha256: character.sha256 },
  ], { version: 1, zoom: Math.max(1, Math.floor(192 / p.logicalSize[1])) });
  if (check.status === "error") throw new DomainFailure("validation_failed", tx(`Conferência do retrato falhou: ${check.message}`, `Portrait check failed: ${check.message}`), { code: check.code });
  const compare = await extra(env, check, "compare");
  const processed: ProcessedPart = {
    ...result.processed,
    warnings: [...result.processed.warnings, ...check.warnings],
    details: { check: check.report, compareSha256: compare.blob.sha256 },
  };
  return { processed, stored: result.stored, extraBlobs: [compare] };
}

function publishPortrait(ctx: HandlerContext, plan: PortraitPlan, asset: AssetView, part: PartRow, perPart: number): string[] {
  const p = plan.params;
  return partResults(ctx, part.part_key)
    .slice(0, perPart)
    .map((row) => {
      const processed = parseJson<ProcessedPart>(row.processed_json)!;
      const [w, h] = [processed.width, processed.height];
      const details = processed.details as { check: { suggested: { faceRect: Rect; mouthRect: Rect; faceAnchor: [number, number] }; palette: unknown; scale: unknown; contentBox: Rect }; compareSha256: string };
      const s = details.check.suggested;
      const payload: PortraitPayload = { characterRevisionId: p.characterRevisionId, fileId: "image", rect: [0, 0, w, h], logicalSize: [w, h], faceAnchor: s.faceAnchor, faceRect: s.faceRect, mouthRect: s.mouthRect };
      return publishRevision(ctx.db, ctx.clock, {
        projectId: ctx.job.project_id,
        assetId: asset.id,
        origin: "generation",
        styleRevisionId: plan.styleRevisionId,
        jobAttemptId: ctx.attempt.id,
        payload,
        files: [
          { fileKey: "image", role: "normalized", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) },
          { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
          { fileKey: "compare", role: "preview", idx: 0, blob: mustBlob(ctx.db, details.compareSha256) },
        ],
        technicalReport: {
          operation: "generate_portrait",
          routeLabel: DIALOGUE_ROUTE_LABELS.portrait,
          partKey: part.part_key,
          remoteId: part.remote_id,
          requestedSize: p.logicalSize,
          receivedSize: processed.receivedSize,
          framing: p.framing ?? "bust",
          palette: details.check.palette,
          scale: details.check.scale,
          contentBox: details.check.contentBox,
          regions: { ...s, reviewed: false },
          steps: processed.steps ?? [],
          warnings: [
            ...processed.warnings,
            tx("Âncora facial e regiões do rosto/boca sugeridas automaticamente: revise antes de gerar expressões", "Face anchor and face/mouth regions were suggested automatically: review them before generating expressions"),
          ],
        },
      }).id;
    });
}

export const portraitPipeline: OperationPipeline = {
  validateTarget({ plan, asset }) {
    if (plan.operation !== "generate_portrait") throw new Error("inalcançável");
    if (asset.family !== "portrait" || asset.kind !== "portrait") {
      throw new DomainFailure("validation_failed", tx(`O retrato publica em portrait/portrait; o asset é ${asset.family}/${asset.kind}`, `The portrait publishes to portrait/portrait; the asset is ${asset.family}/${asset.kind}`));
    }
  },
  loadInputs: (ctx, plan) => {
    const key = plan.operation === "generate_portrait" ? plan.params.backgroundKey : null;
    return scaledReferences(ctx, plan, key ? { flattenOnto: key } : {});
  },
  process: processPortrait,
  publish: (ctx, plan, asset, part, perPart) => publishPortrait(ctx, plan as PortraitPlan, asset, part, perPart),
};

// ---------------------------------------------------------------------------
// Expressão: folha de bocas
// ---------------------------------------------------------------------------

function sheetOf(plan: VisemesPlan) {
  const p = plan.params;
  if (!p.sheet || !p.mouthRect || !p.faceRect || !p.visemeIds) throw new DomainFailure("validation_failed", tx("A folha de bocas exige grade, regiões e visemes declarados", "The mouth sheet needs a declared grid, regions and visemes"));
  return { sheet: p.sheet, mouthRect: p.mouthRect, faceRect: p.faceRect, visemeIds: p.visemeIds };
}

async function loadVisemeInputs(ctx: HandlerContext, plan: VisemesPlan) {
  const { sheet, mouthRect } = sheetOf(plan);
  const portrait = plan.sources.find((s) => s.role === "identity")!;
  const refs = await scaledReferences(ctx, plan, sheet.backgroundKey ? { flattenOnto: sheet.backgroundKey } : {});
  const scale = Math.max(1, Math.floor(1024 / (sheet.columns * sheet.cell[0])));
  const guide = await pythonWith(envOf(ctx), path.join(ctx.workDir, "viseme-guide"), "viseme_guide", [{ role: "source", sha256: portrait.sha256 }], {
    version: 1,
    columns: sheet.columns,
    rows: sheet.rows,
    cell: sheet.cell,
    mouthRect,
    markColor: MOUTH_MARK,
    flattenOnto: sheet.backgroundKey,
    scale,
  });
  if (guide.status === "error") throw new DomainFailure("internal", tx(`Falha ao montar a guia da folha de bocas: ${guide.message}`, `Failed to build the mouth sheet guide: ${guide.message}`));
  return [...refs, { role: "composition", mime: "image/png", bytes: (await outputBytes(guide, "guide")).bytes }];
}

async function processVisemes(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult> {
  if (plan.operation !== "generate_visemes") throw new Error("inalcançável");
  const { sheet, mouthRect, faceRect, visemeIds } = sheetOf(plan);
  const size: [number, number] = [sheet.columns * sheet.cell[0], sheet.rows * sheet.cell[1]];
  const result = await normalizeCanvas(env, sha256, dir, { size, key: sheet.backgroundKey, alphaThreshold: 128 });
  const portrait = plan.sources.find((s) => s.role === "identity")!;
  const cut = await pythonWith(env, path.join(dir, "sheet"), "expression_sheet", [
    { role: "source", sha256: result.stored.sha256 },
    { role: "layer", sha256: portrait.sha256 },
  ], {
    version: 1,
    columns: sheet.columns,
    rows: sheet.rows,
    cell: sheet.cell,
    frameIds: visemeIds,
    restId: visemeIds.includes("rest") ? "rest" : visemeIds[0]!,
    faceRect,
    mouthRect,
    thresholds: STABILITY_THRESHOLDS,
    zoom: Math.max(1, Math.floor(512 / size[0])),
  });
  if (cut.status === "error") throw new DomainFailure("validation_failed", tx(`Folha de bocas fora da grade: ${cut.message}`, `Mouth sheet off the grid: ${cut.message}`), { code: cut.code });
  const review = await extra(env, cut, "review");
  const processed: ProcessedPart = {
    ...result.processed,
    warnings: [...result.processed.warnings, ...cut.warnings],
    details: { sheet: cut.report, reviewSha256: review.blob.sha256 },
  };
  return { processed, stored: result.stored, extraBlobs: [review] };
}

function publishVisemes(ctx: HandlerContext, plan: VisemesPlan, asset: AssetView, part: PartRow, perPart: number): string[] {
  const p = plan.params;
  const { sheet } = sheetOf(plan);
  return partResults(ctx, part.part_key)
    .slice(0, perPart)
    .map((row) => {
      const processed = parseJson<ProcessedPart>(row.processed_json)!;
      const details = processed.details as { sheet: { frames: { frameId: string; rect: Rect; empty: boolean }[]; complete: boolean; maxOutsideMouth: number; outsideFace: number | null }; reviewSha256: string };
      const payload: ExpressionPayload = {
        portraitRevisionId: p.portraitRevisionId,
        expressionKey: p.expressionKey,
        visemes: details.sheet.frames.map((f) => ({ visemeId: f.frameId, fileId: "sheet", rect: f.rect })),
        ...(p.visemeSet ? { visemeSet: p.visemeSet } : {}),
        grid: { columns: sheet.columns, rows: sheet.rows, cell: sheet.cell },
      };
      return publishRevision(ctx.db, ctx.clock, {
        projectId: ctx.job.project_id,
        assetId: asset.id,
        origin: "generation",
        styleRevisionId: plan.styleRevisionId,
        jobAttemptId: ctx.attempt.id,
        payload,
        files: [
          { fileKey: "sheet", role: "normalized", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) },
          { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
          { fileKey: "review", role: "preview", idx: 0, blob: mustBlob(ctx.db, details.reviewSha256) },
        ],
        technicalReport: {
          operation: "generate_visemes",
          routeLabel: DIALOGUE_ROUTE_LABELS.visemes,
          partKey: part.part_key,
          remoteId: part.remote_id,
          expressionKey: p.expressionKey,
          receivedSize: processed.receivedSize,
          grid: payload.grid,
          visemeSet: p.visemeSet ?? null,
          stability: { ...details.sheet, thresholds: STABILITY_THRESHOLDS },
          complete: details.sheet.complete,
          steps: processed.steps ?? [],
          warnings: processed.warnings,
        },
      }).id;
    });
}

export const visemesPipeline: OperationPipeline = {
  validateTarget({ plan, asset }) {
    if (plan.operation !== "generate_visemes") throw new Error("inalcançável");
    if (asset.family !== "portrait" || asset.kind !== "expression") {
      throw new DomainFailure("validation_failed", tx(`A folha de bocas publica em portrait/expression; o asset é ${asset.family}/${asset.kind}`, `The mouth sheet publishes to portrait/expression; the asset is ${asset.family}/${asset.kind}`));
    }
  },
  loadInputs: (ctx, plan) => loadVisemeInputs(ctx, plan as VisemesPlan),
  process: processVisemes,
  publish: (ctx, plan, asset, part, perPart) => publishVisemes(ctx, plan as VisemesPlan, asset, part, perPart),
};
