import path from "node:path";
import { type FontPayload, formatCodepoint, type GenerationPlan, type Glyph, type Rect } from "@/contracts";
import { lineMetrics, sortCodepoints } from "@/domain/dialogue/font";
import { type TextValue, tx } from "@/i18n/locales";
import { type AssetView, getRevision, publishRevision, type PublishFile } from "../../../catalog/catalog";
import { DIALOGUE_ROUTE_LABELS } from "../../../dialogue/core";
import { fontPages, specimenText } from "../../../dialogue/font-pages";
import { DomainFailure } from "../../../errors";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { normalizeCanvas, outputBytes } from "./scene-shared";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, pythonWith } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";

/**
 * Fonte bitmap pela rota genérica (cartão D1): cada parte do plano é uma
 * página de glyphs desenhada sobre o gabarito (células, baseline e
 * letra-fantasma) e medida localmente; a última parte monta UMA revisão com
 * todas as páginas, métricas de linha e cobertura real (só células com
 * tinta). Na extensão, as páginas e glyphs da revisão-base seguem intactos e
 * os novos glyphs registram origem `extended` e a revisão-base.
 */

type FontPlan = Extract<GenerationPlan, { operation: "generate_pixel_font" }>;

function guideOf(plan: GenerationPlan) {
  if (plan.operation !== "generate_pixel_font" || !plan.params.guide) {
    throw new DomainFailure("capability_missing", tx("Fonte pixel nativa não é oferecida por nenhum perfil; use o gabarito da rota genérica", "No profile offers a native pixel font; use the generic-route template"));
  }
  return plan.params.guide;
}

function pageOf(plan: GenerationPlan, partKey: string | undefined) {
  const guide = guideOf(plan);
  const page = guide.pages.find((p) => p.partKey === partKey);
  if (!page) throw new DomainFailure("internal", tx(`Parte ${partKey} sem página no gabarito`, `Part ${partKey} has no template page`));
  return { guide, page, index: guide.pages.indexOf(page) };
}

const grid = (guide: ReturnType<typeof guideOf>) => ({ columns: guide.columns, rows: guide.rows, cell: guide.cell, baselineY: guide.baselineY, padLeft: guide.padLeft, capHeight: guide.capHeight });

async function loadFontInputs(ctx: HandlerContext, plan: GenerationPlan, part?: PartRow) {
  const { guide, page } = pageOf(plan, part?.part_key);
  const env = envOf(ctx);
  const dir = path.join(ctx.workDir, "font-inputs", page.partKey.replace(/[^a-z0-9]/gi, "_"));
  const scale = Math.max(1, Math.floor(1024 / (guide.columns * guide.cell[0])));
  const run = await pythonWith(env, path.join(dir, "guide"), "font_guide", [], { version: 1, ...grid(guide), codepoints: page.codepoints, scale });
  if (run.status === "error") throw new DomainFailure("internal", tx(`Falha ao montar o gabarito: ${run.message}`, `Failed to build the template: ${run.message}`));
  const refs: { role: string; mime: string; bytes: Uint8Array }[] = [];
  if (guide.mode === "extend" && guide.baseRevisionId) {
    // Referência 1: os glyphs aprovados da base, desenhados com as métricas aprovadas.
    const base = fontPages(getRevision(ctx.db, ctx.job.project_id, guide.baseRevisionId));
    const text = specimenText(sortCodepoints(base.glyphs.map((g) => g.codepoint)));
    const zoom = Math.max(2, Math.min(16, Math.floor(960 / (16 * (guide.capHeight + 1)))));
    const specimen = await pythonWith(env, path.join(dir, "specimen"), "font_render", base.pages.map((p) => ({ role: "layer", sha256: p.sha256 })), {
      version: 1,
      glyphs: base.glyphs,
      metrics: base.metrics,
      kerning: base.kerning,
      texts: [text],
      maxWidth: null,
      zoom,
      color: guide.inkColor,
      background: guide.backgroundKey,
    });
    if (specimen.status === "error") throw new DomainFailure("internal", tx(`Falha ao montar a referência dos glyphs-base: ${specimen.message}`, `Failed to build the base glyph reference: ${specimen.message}`));
    refs.push({ role: "style", mime: "image/png", bytes: (await outputBytes(specimen, "text_zoom", "0")).bytes });
  }
  refs.push({ role: "composition", mime: "image/png", bytes: (await outputBytes(run, "guide")).bytes });
  return refs;
}

async function processFontPage(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string, part?: PartRow): Promise<ProcessResult> {
  const { guide, page } = pageOf(plan, part?.part_key);
  const size: [number, number] = [guide.columns * guide.cell[0], guide.rows * guide.cell[1]];
  const result = await normalizeCanvas(env, sha256, dir, { size, key: guide.backgroundKey, alphaThreshold: 128 });
  const measure = await pythonWith(env, path.join(dir, "measure"), "font_measure", [{ role: "source", sha256: result.stored.sha256 }], {
    version: 1,
    ...grid(guide),
    codepoints: page.codepoints,
    alphaThreshold: 128,
    tracking: guide.tracking,
    snapBaseline: true,
    keyColor: guide.backgroundKey,
  });
  if (measure.status === "error") throw new DomainFailure("validation_failed", tx(`Página de glyphs fora da grade: ${measure.message}`, `Glyph page off the grid: ${measure.message}`), { code: measure.code });
  const pageOut = await outputBytes(measure, "page");
  const stored = await env.blobs.putBytes(pageOut.bytes);
  const previewOut = await outputBytes(measure, "preview");
  const preview = await env.blobs.putBytes(previewOut.bytes);
  // A página binarizada substitui o canvas ajustado como imagem principal (o hash RGBA do ajuste não vale para ela).
  const fitted: ProcessedPart = { ...result.processed };
  delete fitted.rgbaSha256;
  const processed: ProcessedPart = {
    ...fitted,
    normalizedSha256: stored.sha256,
    width: pageOut.width,
    height: pageOut.height,
    warnings: [...fitted.warnings, ...measure.warnings],
    details: { partKey: page.partKey, measure: measure.report, previewSha256: preview.sha256 },
  };
  return { processed, stored, extraBlobs: [{ blob: preview, width: previewOut.width, height: previewOut.height }] };
}

interface Measured {
  glyphs: { codepoint: number; rect: Rect; bearingX: number; bearingY: number; advanceX: number }[];
  missing: number[];
  pageBaseline: number;
  declaredBaseline: number;
  snapped: { codepoint: number; deltaPx: number }[];
}

function publishFont(ctx: HandlerContext, plan: FontPlan, asset: AssetView, part: PartRow): string[] {
  // Uma revisão com todas as páginas: só a última parte publica.
  if (part.part_key !== plan.parts.at(-1)!.partKey) return [];
  const guide = guideOf(plan);
  const extend = guide.mode === "extend" && guide.baseRevisionId ? fontPages(getRevision(ctx.db, ctx.job.project_id, guide.baseRevisionId)) : null;
  const baseRevision = extend ? getRevision(ctx.db, ctx.job.project_id, guide.baseRevisionId!) : null;
  const prefix = extend ? `ext${extend.pages.filter((p) => p.fileKey.startsWith("ext")).length + 1}-` : "page-";
  const files: PublishFile[] = [];
  const glyphs: Glyph[] = extend ? [...extend.payload.glyphs] : [];
  const present = new Set(glyphs.map((g) => g.codepoint));
  const warnings: TextValue[] = [];
  const pages: Record<string, unknown>[] = [];
  const missing: number[] = [];
  if (extend && baseRevision) {
    for (const p of extend.pages) {
      const f = baseRevision.files.find((x) => x.fileKey === p.fileKey)!;
      files.push({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: mustBlob(ctx.db, f.sha256) });
    }
  }
  plan.parts.forEach((planPart, i) => {
    const row = partResults(ctx, planPart.partKey)[0];
    const page = guide.pages[i]!;
    if (!row) {
      missing.push(...page.codepoints);
      return;
    }
    const processed = parseJson<ProcessedPart>(row.processed_json)!;
    const details = processed.details as { measure: Measured; previewSha256: string };
    const fileKey = `${prefix}${i + 1}`;
    files.push({ fileKey, role: "atlas", idx: (extend?.pages.length ?? 0) + i, blob: mustBlob(ctx.db, processed.normalizedSha256) });
    files.push({ fileKey: `${prefix}raw-${i + 1}`, role: "raw", idx: i, blob: mustBlob(ctx.db, row.blob_sha256) });
    files.push({ fileKey: `${prefix}preview-${i + 1}`, role: "preview", idx: i, blob: mustBlob(ctx.db, details.previewSha256) });
    for (const g of details.measure.glyphs) {
      if (present.has(g.codepoint)) continue;
      present.add(g.codepoint);
      glyphs.push({
        codepoint: g.codepoint,
        fileId: fileKey,
        rect: g.rect,
        bearingX: g.bearingX,
        bearingY: g.bearingY,
        advanceX: g.advanceX,
        origin: extend ? "extended" : "generated",
        ...(extend ? { baseRevisionId: guide.baseRevisionId! } : {}),
      });
    }
    missing.push(...details.measure.missing);
    warnings.push(...processed.warnings);
    pages.push({ partKey: planPart.partKey, fileKey, requested: page.codepoints.length, measured: details.measure.glyphs.length, missing: details.measure.missing, pageBaseline: details.measure.pageBaseline, declaredBaseline: details.measure.declaredBaseline, snapped: details.measure.snapped });
  });
  if (glyphs.length === 0) throw new DomainFailure("validation_failed", tx("Nenhuma célula do gabarito voltou com tinta: nada a montar", "No template cell came back with ink: nothing to assemble"));
  const metrics = lineMetrics(glyphs, guide.capHeight);
  const extended = glyphs.filter((g) => g.origin === "extended" && g.baseRevisionId === guide.baseRevisionId).map((g) => g.codepoint);
  const payload: FontPayload = {
    nativeGlyphPx: guide.capHeight,
    metrics,
    glyphs,
    kerning: extend?.payload.kerning ?? [],
    declaredCoverage: sortCodepoints(glyphs.map((g) => g.codepoint)),
    missingGlyph: { policy: "report" },
    // TTF da base (se houver) segue com a cobertura que foi inspecionada nele, sem os glyphs estendidos.
    ttf: extend?.payload.ttf ?? null,
    license: extend
      ? { name: extend.payload.license.name, provenance: `${extend.payload.license.provenance}; +${extended.length} glyph(s) extended by image + reference of base revision ${guide.baseRevisionId}`.slice(0, 500) }
      : { name: "Project asset (generated)", provenance: `Glyph sheets drawn by an image model over a grid template (generic route) and assembled locally by Pixel Studio (${plan.recipeRevisionId})` },
  };
  if (missing.length) {
    warnings.push(
      tx(
        `${missing.length} glyph(s) pedido(s) ausente(s): ${missing.map((c) => String.fromCodePoint(c)).join(" ")}. Listados, nunca substituídos; use a extensão`,
        `${missing.length} requested glyph(s) missing: ${missing.map((c) => String.fromCodePoint(c)).join(" ")}. Listed, never substituted; use the extension`,
      ),
    );
  }
  const revision = publishRevision(ctx.db, ctx.clock, {
    projectId: ctx.job.project_id,
    assetId: asset.id,
    origin: "generation",
    styleRevisionId: plan.styleRevisionId,
    jobAttemptId: ctx.attempt.id,
    payload,
    files,
    technicalReport: {
      operation: "generate_pixel_font",
      routeLabel: extend ? DIALOGUE_ROUTE_LABELS.fontExtend : DIALOGUE_ROUTE_LABELS.font,
      mode: guide.mode,
      baseRevisionId: guide.baseRevisionId,
      weight: plan.params.weight,
      capHeight: guide.capHeight,
      cell: guide.cell,
      requested: plan.params.requiredCodepoints.length,
      missing: sortCodepoints(missing),
      missingLabels: sortCodepoints(missing).map(formatCodepoint),
      extendedCodepoints: extended,
      pages,
      metrics,
      spacing: "proportional",
      kerning: "none",
      warnings,
    },
  });
  return [revision.id];
}

export const fontPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "generate_pixel_font") throw new Error("inalcançável");
    if (asset.family !== "font" || asset.kind !== "bitmap") {
      throw new DomainFailure("validation_failed", tx(`A fonte publica em font/bitmap; o asset é ${asset.family}/${asset.kind}`, `The font publishes to font/bitmap; the asset is ${asset.family}/${asset.kind}`));
    }
    const guide = guideOf(plan);
    if (guide.mode === "extend" && guide.baseRevisionId && getRevision(db, projectId, guide.baseRevisionId).assetId !== asset.id) {
      throw new DomainFailure("validation_failed", tx("A extensão publica uma nova revisão da mesma fonte-base", "The extension publishes a new revision of the same base font"));
    }
  },
  loadInputs: (ctx, plan, _adapter, part) => loadFontInputs(ctx, plan, part),
  process: processFontPage,
  publish: (ctx, plan, asset, part) => publishFont(ctx, plan as FontPlan, asset, part),
};
