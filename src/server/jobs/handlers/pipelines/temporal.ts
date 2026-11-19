import { readFile } from "node:fs/promises";
import path from "node:path";
import { type BasePayload, type ClipPayload, DIRECTIONS_8, type Direction, type FrameLayout, type GenerationPlan, type ReferenceSheet } from "@/contracts";
import { cellFrame, distributeDurations, frameDigest, insertFrames, intermediateFrameIds, interpolateOffset, interpolateSockets, replaceFrameLayers, replaceLayer } from "@/domain/animation/temporal";
import { entryRefs } from "@/domain/manifest/refs";
import { createImage, encodePng, fillRect, readPngInfo } from "@/lib/media/png";
import { parseRevisionPayload } from "@/contracts";
import { loadBase, loadClip, textFrameIds } from "../../../animation/base";
import { correctionMarkColor, TEMPORAL_ROUTE_LABELS } from "../../../animation/temporal-plans";
import { getRevision, getStyleRevision, publishRevision, type RevisionView } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { guideScale } from "../../../inpaint";
import { affectedByFrames } from "../../../library/affected";
import type { ProviderAdapter } from "../../../providers/types";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { scaledReference } from "./animation";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, python, pythonWith } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";
import type { StoredBlob } from "../../../storage/blob-store";

/**
 * Pipelines do cartão S3 (estados, objetos, interpolação, edição de trecho,
 * roupa e correção de quadro). Regras comuns:
 *
 * - entradas recompostas das camadas congeladas no plano (`compose_frames`),
 *   nunca do catálogo vivo;
 * - resposta nativa: um quadro/vista por imagem, na célula exata (padding
 *   transparente aparado ou fator inteiro; nunca esticar);
 * - rota genérica: folha na grade do plano → grade aparente → cor-chave →
 *   quadros casados com os originais (mesma disposição) ou assentados no apoio
 *   (quadros novos);
 * - a publicação deriva da revisão de origem: o que não foi tocado mantém os
 *   mesmos arquivos (mesmos blobs e chaves) e o mesmo payload.
 */

type Plan<O extends GenerationPlan["operation"]> = Extract<GenerationPlan, { operation: O }>;

interface FrameOut {
  frameId: string;
  sha256: string;
  rgbaSha256: string | null;
}

function sheetOf(plan: GenerationPlan): ReferenceSheet | undefined {
  return "sheet" in plan.params ? (plan.params.sheet as ReferenceSheet | undefined) : undefined;
}

/** Fator inteiro da folha de referência: lado menor ≥ 256 px, maior ≤ 1024 px (como no S1). */
export function sheetScale(columns: number, rows: number, [w, h]: [number, number]): number {
  const W = columns * w;
  const H = rows * h;
  return Math.max(1, Math.min(Math.ceil(256 / Math.min(W, H)), Math.floor(1024 / Math.max(W, H))));
}

/** Recompõe os quadros congelados; com `sheet`, monta também a folha de referência ampliada. */
async function composeLayouts(
  env: PipelineEnv,
  plan: GenerationPlan,
  layouts: FrameLayout[],
  cell: [number, number],
  dir: string,
  sheet: { columns: number; rows: number; scale: number; flattenOnto: string | null } | null = null,
): Promise<{ frames: (FrameOut & { contentBox: number[] | null })[]; sheetSha: string | null }> {
  const used = [...new Set(layouts.flatMap((l) => l.layers.map((x) => x.source)))].sort((a, b) => a - b);
  const inputs = used.map((ordinal) => {
    const source = plan.sources[ordinal];
    if (!source) throw new DomainFailure("validation_failed", `Camada cita a fonte ${ordinal}, ausente no plano`);
    return { role: "layer", sha256: source.sha256 };
  });
  const out = await pythonWith(env, dir, "compose_frames", inputs, {
    version: 1,
    cell,
    frames: layouts.map((l) => ({ key: l.frameId, layers: l.layers.map((x) => ({ input: used.indexOf(x.source), rect: x.rect, offset: x.offset })) })),
    sheet,
    emitFrames: true,
  });
  if (out.status === "error") throw new DomainFailure("validation_failed", `Falha ao recompor os quadros: ${out.message}`, { code: out.code });
  const report = out.report as { frames: { key: string; contentBox: number[] | null; rgbaSha256: string }[] };
  const frames = [];
  for (const o of out.outputs.filter((x) => x.role === "frame")) {
    const stored = await env.blobs.putFile(o.absolutePath);
    const r = report.frames.find((f) => f.key === o.key)!;
    frames.push({ frameId: o.key!, sha256: stored.sha256, rgbaSha256: r.rgbaSha256, contentBox: r.contentBox });
  }
  const sheetOut = out.outputs.find((x) => x.role === "sheet");
  return { frames, sheetSha: sheetOut ? (await env.blobs.putFile(sheetOut.absolutePath)).sha256 : null };
}

async function bytesOf(env: PipelineEnv, sha256: string): Promise<Uint8Array> {
  return new Uint8Array(await env.blobs.read(sha256));
}

/** Referência de uma rota genérica: os quadros na grade do plano, ampliados e achatados na cor-chave. */
async function referenceSheet(env: PipelineEnv, plan: GenerationPlan, layouts: FrameLayout[], cell: [number, number], sheet: ReferenceSheet, dir: string): Promise<Uint8Array> {
  const { sheetSha } = await composeLayouts(env, plan, layouts, cell, dir, { columns: sheet.columns, rows: sheet.rows, scale: sheetScale(sheet.columns, sheet.rows, cell), flattenOnto: sheet.backgroundKey });
  return bytesOf(env, sheetSha!);
}

interface Fitted {
  stored: StoredBlob;
  width: number;
  height: number;
  rgbaSha256?: string;
  receivedSize: [number, number];
  steps: Record<string, unknown>[];
  warnings: string[];
}

/** Imagem nativa → célula exata: tamanho igual, padding transparente aparado (há provedores que acolchoam a tela) ou fator inteiro. */
async function fitCell(env: PipelineEnv, sha256: string, dir: string, cell: [number, number]): Promise<Fitted> {
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") throw new DomainFailure("validation_failed", `Resposta do provedor não é uma imagem utilizável: ${ingest.message}`, { code: ingest.code });
  let out = ingest.outputs.find((o) => o.role === "normalized")!;
  const steps: Record<string, unknown>[] = [];
  const warnings = [...ingest.warnings];
  const [cw, ch] = cell;
  if (out.width! >= cw && out.height! >= ch && (out.width !== cw || out.height !== ch)) {
    const current = await env.blobs.putFile(out.absolutePath);
    const trim = await pythonWith(env, path.join(dir, "trim"), "canvas_fit", [{ role: "source", sha256: current.sha256 }], {
      version: 1,
      size: cell,
      offset: [-Math.floor((out.width! - cw) / 2), -Math.floor((out.height! - ch) / 2)],
    });
    if (trim.status !== "error") {
      out = trim.outputs.find((o) => o.role === "fitted")!;
      steps.push({ operation: "canvas_fit", ...trim.report });
      warnings.push(`Tela recebida ${ingest.report.size} com borda transparente aparada para a célula ${cw}×${ch}`);
    }
  }
  if (out.width !== cw || out.height !== ch) {
    const current = await env.blobs.putFile(out.absolutePath);
    const fit = await python(env, path.join(dir, "fit"), "fit_logical", current.sha256, { version: 1, targetSize: cell, exactAspect: true, alphaThreshold: 128 });
    if (fit.status === "error") throw new DomainFailure("validation_failed", `Imagem fora da célula ${cw}×${ch}: ${fit.message}`, { code: fit.code });
    out = fit.outputs.find((o) => o.role === "fitted")!;
    steps.push({ operation: "fit_logical", ...fit.report });
    warnings.push(...fit.warnings);
  }
  const stored = await env.blobs.putFile(out.absolutePath);
  return { stored, width: out.width!, height: out.height!, ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}), receivedSize: ingest.report.size as [number, number], steps, warnings };
}

function nativeResult(fitted: Fitted, details: Record<string, unknown>): ProcessResult {
  return {
    processed: {
      normalizedSha256: fitted.stored.sha256,
      width: fitted.width,
      height: fitted.height,
      ...(fitted.rgbaSha256 ? { rgbaSha256: fitted.rgbaSha256 } : {}),
      receivedSize: fitted.receivedSize,
      steps: fitted.steps,
      warnings: fitted.warnings,
      details: { kind: "cell", ...details },
    },
    stored: fitted.stored,
  };
}

/**
 * Folha de uma rota genérica → quadros. `match`: mesma disposição da referência
 * (cada célula casada com o quadro original pelo apoio); `seat`: quadros novos
 * assentados pelo apoio de uma base (como no S1).
 */
async function sheetToFrames(
  env: PipelineEnv,
  sha256: string,
  dir: string,
  sheet: ReferenceSheet,
  opts: { mode: "match"; originals: string[] } | { mode: "seat"; baseSha: string; keepHorizontal: boolean },
): Promise<ProcessResult & { frames: FrameOut[] }> {
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") throw new DomainFailure("validation_failed", `Resposta do provedor não é uma imagem utilizável: ${ingest.message}`, { code: ingest.code });
  let out = ingest.outputs.find((o) => o.role === "normalized")!;
  const warnings = [...ingest.warnings];
  const steps: Record<string, unknown>[] = [];
  const key = sheet.backgroundKey;
  const step = async (name: "unzoom" | "remove_background_flood", recipe: Record<string, unknown>, role: string) => {
    const current = await env.blobs.putFile(out.absolutePath);
    const result = await python(env, path.join(dir, name), name, current.sha256, recipe);
    if (result.status === "error") throw new DomainFailure("validation_failed", `Etapa ${name} falhou: ${result.message}`, { code: result.code });
    out = result.outputs.find((o) => o.role === role)!;
    warnings.push(...result.warnings);
    steps.push({ operation: name, ...result.report });
  };
  const logical = [sheet.columns * sheet.cell[0], sheet.rows * sheet.cell[1]];
  await step("unzoom", { version: 1, minAgreement: 0.9, minContentCells: Math.ceil(Math.max(logical[0]!, logical[1]!) / 2), ...(key ? { ignoreKeyHue: { hueTolerance: 30, minSaturation: 96, minValue: 100 } } : {}) }, "native");
  if (key) {
    await step("remove_background_flood", { version: 1, color: key, tolerance: 0, seeds: { borders: true, points: [] }, connectivity: 4, match: { mode: "hue", hueTolerance: 25, minSaturation: 96, keyFrom: "border" } }, "cutout");
  }
  const current = await env.blobs.putFile(out.absolutePath);
  const sliced =
    opts.mode === "match"
      ? await pythonWith(env, path.join(dir, "match"), "sheet_match", [{ role: "candidate", sha256: current.sha256 }, ...opts.originals.map((s) => ({ role: "layer", sha256: s }))], {
          version: 1,
          columns: sheet.columns,
          rows: sheet.rows,
          frameIds: sheet.frameIds,
          cell: sheet.cell,
          alphaThreshold: 128,
          scaleTolerance: 0.12,
          // O corpo conserva a largura (a tampa aberta muda a altura); modelos nem sempre mantêm o enquadramento.
          scaleBy: "width",
        })
      : await pythonWith(env, path.join(dir, "sheet"), "animation_sheet", [{ role: "candidate", sha256: current.sha256 }, { role: "source", sha256: opts.baseSha }], {
          version: 1,
          columns: sheet.columns,
          rows: sheet.rows,
          frameIds: sheet.frameIds,
          cell: sheet.cell,
          alphaThreshold: 128,
          scaleTolerance: 0.15,
          keepHorizontalOffsets: opts.keepHorizontal,
          // Objeto/estado: a escala comum vem da largura, não da altura que a ação muda.
          scaleBy: "width",
        });
  if (sliced.status === "error") throw new DomainFailure("validation_failed", `A folha não pôde ser fatiada: ${sliced.message}`, { code: sliced.code });
  warnings.push(...sliced.warnings);
  steps.push({ operation: opts.mode === "match" ? "sheet_match" : "animation_sheet", ...sliced.report });
  const strip = sliced.outputs.find((o) => o.role === "strip")!;
  const stored = await env.blobs.putFile(strip.absolutePath);
  const frames: FrameOut[] = [];
  const extraBlobs = [];
  for (const o of sliced.outputs.filter((x) => x.role === "frame")) {
    const blob = await env.blobs.putFile(o.absolutePath);
    frames.push({ frameId: o.key!, sha256: blob.sha256, rgbaSha256: o.rgbaSha256 ?? null });
    extraBlobs.push({ blob, width: o.width!, height: o.height! });
  }
  const processed: ProcessedPart = {
    normalizedSha256: stored.sha256,
    width: strip.width!,
    height: strip.height!,
    receivedSize: ingest.report.size as [number, number],
    steps,
    warnings,
    details: { kind: "sheet", frames, sheet: sliced.report },
  };
  return { processed, stored, extraBlobs, frames };
}

function processedRows(ctx: HandlerContext, part: PartRow) {
  return partResults(ctx, part.part_key).map((row) => ({ row, processed: parseJson<ProcessedPart>(row.processed_json)! }));
}

/** Quadros da parte: nativo = um por imagem recebida; folha = os fatiados da primeira imagem. */
function partFrames(ctx: HandlerContext, plan: GenerationPlan, part: PartRow): FrameOut[] {
  const rows = processedRows(ctx, part);
  if (sheetOf(plan)) return (rows[0]!.processed.details as { frames: FrameOut[] }).frames;
  return rows.map(({ processed }, i) => ({ frameId: String(i), sha256: processed.normalizedSha256, rgbaSha256: processed.rgbaSha256 ?? null }));
}

function rawFiles(ctx: HandlerContext, part: PartRow, prefix = "raw") {
  return partResults(ctx, part.part_key).map((row) => ({ fileKey: `${prefix}-${row.idx}`, role: "raw", idx: row.idx, blob: mustBlob(ctx.db, row.blob_sha256) }));
}

function partWarnings(ctx: HandlerContext, part: PartRow): string[] {
  return processedRows(ctx, part).flatMap(({ processed }) => processed.warnings);
}

function partSteps(ctx: HandlerContext, part: PartRow) {
  return processedRows(ctx, part).map(({ processed }) => ({ receivedSize: processed.receivedSize, steps: processed.steps ?? [], details: processed.details }));
}

/** Arquivos citados pelo payload de origem, com as MESMAS chaves e blobs (nada do que não mudou é regravado). */
function keptFiles(revision: RevisionView, family: "character", kind: "clip" | "base", payload: unknown) {
  const parsed = parseRevisionPayload(family, kind, payload);
  if (!parsed.success) throw new DomainFailure("internal", "Payload de origem não passa no schema");
  const referenced = new Set(entryRefs(parsed.entry).files.map((f) => f.fileId));
  return revision.files.filter((f) => referenced.has(f.fileKey));
}

function fileRef(db: HandlerContext["db"], f: { fileKey: string; role: string; idx: number; sha256: string }) {
  return { fileKey: f.fileKey, role: f.role, idx: f.idx, blob: mustBlob(db, f.sha256) };
}

/** Sufixo estável por job para chaves de arquivo novas (sem colidir com as da revisão de origem). */
function suffix(ctx: HandlerContext): string {
  return ctx.job.id.replace(/[^A-Za-z0-9]/g, "").slice(-6);
}

function sortViews<T extends { direction: Direction }>(views: T[]): T[] {
  return [...views].sort((a, b) => DIRECTIONS_8.indexOf(a.direction) - DIRECTIONS_8.indexOf(b.direction));
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

function stateLayouts(plan: Plan<"create_state">): FrameLayout[] {
  const [w, h] = plan.params.logicalSize;
  return plan.params.directions.map((d, i) => ({ frameId: `view-${d.toLowerCase()}`, layers: [{ source: i, rect: [0, 0, w, h], offset: [0, 0] }] }));
}

export const statePipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "create_state") throw new Error("inalcançável");
    if (asset.family !== "character" || asset.kind !== "base") throw new DomainFailure("validation_failed", "O estado publica num asset de base (character/base) próprio do estado");
    if (asset.id === plan.params.identityAssetId) throw new DomainFailure("validation_failed", "O estado nunca substitui a base de origem: ele tem asset próprio");
    if (plan.params.existingStateRevisionId && getRevision(db, projectId, plan.params.existingStateRevisionId).assetId !== asset.id) {
      throw new DomainFailure("validation_failed", "A lacuna é preenchida no asset do próprio estado");
    }
  },
  // Só rota genérica: a folha de referência com as vistas pedidas vai ao modelo e volta casada com cada original.
  async loadInputs(ctx, plan) {
    const p = plan as Plan<"create_state">;
    return [{ role: "source", mime: "image/png", bytes: await referenceSheet(envOf(ctx), p, stateLayouts(p), p.params.logicalSize, p.params.sheet, path.join(ctx.workDir, "state-inputs")) }];
  },
  async process(env, plan, sha256, dir) {
    const p = plan as Plan<"create_state">;
    const originals = await composeLayouts(env, p, stateLayouts(p), p.params.logicalSize, path.join(dir, "originals"));
    return sheetToFrames(env, sha256, dir, p.params.sheet, { mode: "match", originals: originals.frames.map((f) => f.sha256) });
  },
  publish(ctx, plan, asset, part) {
    const p = plan as Plan<"create_state">;
    const frames = partFrames(ctx, p, part);
    if (frames.length !== p.params.directions.length) {
      throw new DomainFailure("validation_failed", `O provedor devolveu ${frames.length} vista(s) para ${p.params.directions.length} direção(ões) pedidas. Respostas brutas guardadas no job.`);
    }
    const sourceId = p.params.predecessorStateRevisionId ?? p.params.baseRevisionId;
    const source = loadBase(ctx.db, ctx.job.project_id, sourceId, { approved: false });
    const existing = p.params.existingStateRevisionId ? loadBase(ctx.db, ctx.job.project_id, p.params.existingStateRevisionId, { approved: false }) : null;
    const [w, h] = p.params.logicalSize;
    const kept = existing ? existing.payload.views.map((v) => ({ view: v, file: existing.revision.files.find((f) => f.fileKey === v.fileId)! })) : [];
    const fresh = p.params.directions.map((direction, i) => ({ direction, fileId: `view-${direction.toLowerCase()}`, sha256: frames[i]!.sha256 }));
    const views = sortViews([
      ...kept.map((k) => k.view),
      ...fresh.map((f) => ({ direction: f.direction, fileId: kept.some((k) => k.file.fileKey === f.fileId) ? `${f.fileId}-${suffix(ctx)}` : f.fileId, rect: [0, 0, w, h] as [number, number, number, number], sourceOffset: [0, 0] as [number, number] })),
    ]);
    const payload: BasePayload = {
      logicalSize: [w, h],
      groundOrigin: source.payload.groundOrigin,
      state: p.params.stateKey,
      predecessorRevisionId: source.revision.id,
      subject: p.params.subject,
      views,
      ...(source.payload.orientation ? { orientation: source.payload.orientation } : {}),
    };
    const files = [
      ...kept.map((k) => fileRef(ctx.db, k.file)),
      ...fresh.map((f, i) => ({ fileKey: views.find((v) => v.direction === f.direction)!.fileId, role: "view", idx: kept.length + i, blob: mustBlob(ctx.db, f.sha256) })),
      ...rawFiles(ctx, part),
    ];
    const sourceDirections = source.payload.views.map((v) => v.direction);
    const covered = views.map((v) => v.direction);
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "generation",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      predecessorId: existing?.revision.id ?? null,
      payload,
      files,
      edges: [
        { toRevisionId: p.params.baseRevisionId, role: "identity", ordinal: 0, runtime: false },
        ...(existing ? [{ toRevisionId: existing.revision.id, role: "source", ordinal: 0, runtime: false }] : []),
      ],
      technicalReport: {
        operation: "create_state",
        stateKey: p.params.stateKey,
        subject: p.params.subject,
        identityAssetId: p.params.identityAssetId,
        sourceRevisionId: source.revision.id,
        strategy: "reference_sheet",
        routeLabel: TEMPORAL_ROUTE_LABELS.state_sheet,
        requestedDirections: p.params.directions,
        newViews: fresh.map((f) => f.direction),
        keptViews: kept.map((k) => ({ direction: k.view.direction, fileKey: k.file.fileKey, sha256: k.file.sha256 })),
        // Matriz de direções: o que a fonte tem e o estado ainda não cobre fica como lacuna explícita.
        gaps: sourceDirections.filter((d) => !covered.includes(d)).map((direction) => ({ direction, reason: "não gerada neste estado" })),
        remoteId: part.remote_id,
        frames: partSteps(ctx, part),
        warnings: partWarnings(ctx, part),
      },
    });
    return [revision.id];
  },
};

// ---------------------------------------------------------------------------
// Animação de objeto
// ---------------------------------------------------------------------------

export const objectAnimationPipeline: OperationPipeline = {
  validateTarget({ asset }) {
    if (asset.family !== "character" || asset.kind !== "clip") throw new DomainFailure("validation_failed", `A animação de objeto publica num clipe (character/clip); o alvo é ${asset.family}/${asset.kind}`);
  },
  // Só rota genérica: a vista (e a pose final, se houver) vão ampliadas; o modelo devolve a folha dos quadros gerados.
  async loadInputs(ctx, plan) {
    const p = plan as Plan<"animate_object">;
    const sheet = p.params.sheet;
    const view = p.sources.find((s) => s.role === "source")!;
    const end = p.sources.find((s) => s.role === "last_frame");
    const env = envOf(ctx);
    const dir = path.join(ctx.workDir, "object-inputs");
    return [
      { role: "source", mime: "image/png", bytes: await scaledReference(env, path.join(dir, "start"), view.sha256, p.params.logicalSize, sheet.backgroundKey) },
      ...(end ? [{ role: "last_frame", mime: "image/png", bytes: await scaledReference(env, path.join(dir, "end"), end.sha256, p.params.logicalSize, sheet.backgroundKey) }] : []),
    ];
  },
  async process(env, plan, sha256, dir) {
    const p = plan as Plan<"animate_object">;
    const view = p.sources.find((s) => s.role === "source")!;
    return sheetToFrames(env, sha256, dir, p.params.sheet, { mode: "seat", baseSha: view.sha256, keepHorizontal: p.params.playback !== "loop" });
  },
  publish(ctx, plan, asset, part) {
    const p = plan as Plan<"animate_object">;
    const object = loadBase(ctx.db, ctx.job.project_id, p.params.objectRevisionId, { approved: false });
    const view = p.sources.find((s) => s.role === "source")!;
    const generated = textFrameIds(p.params.durationsMs.length);
    const keep = p.params.keepFirstFrame;
    const expected = generated.length + (keep ? 1 : 0);
    // Só os gerados vêm do modelo; a referência entra como quadro 0 com os pixels exatos da vista aprovada.
    const frames: FrameOut[] = [...(keep ? [{ frameId: "ref", sha256: view.sha256, rgbaSha256: null }] : []), ...partFrames(ctx, p, part)];
    if (frames.length !== expected) {
      throw new DomainFailure("validation_failed", `A folha trouxe ${frames.length - (keep ? 1 : 0)} quadro(s) gerado(s); o plano pede ${generated.length}. Respostas brutas guardadas no job.`, {
        received: frames.length,
        expected,
        keepFirstFrame: keep,
      });
    }
    const ids = [...(keep ? ["ref"] : []), ...generated];
    const durations = [...(keep ? [p.params.firstFrameMs ?? p.params.durationsMs[0]!] : []), ...p.params.durationsMs];
    const [w, h] = p.params.logicalSize;
    const payload: ClipPayload = {
      rigRevisionId: null,
      motionRevisionId: null,
      action: p.params.action,
      state: p.params.state,
      stance: null,
      direction: p.params.direction,
      logicalSize: [w, h],
      pivot: object.payload.groundOrigin,
      margins: { left: 0, right: 0, top: 0, bottom: 0 },
      playback: p.params.playback,
      frames: ids.map((id, i) => cellFrame(id, durations[i]!, `frame-${id}`, [w, h])),
      events: [],
    };
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "generation",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      payload,
      files: [...ids.map((id, i) => ({ fileKey: `frame-${id}`, role: "frame", idx: i, blob: mustBlob(ctx.db, frames[i]!.sha256) })), ...rawFiles(ctx, part)],
      edges: [
        { toRevisionId: object.revision.id, role: "object", ordinal: 0, runtime: false },
        ...(p.params.endFrame ? [{ toRevisionId: p.params.endFrame.revisionId, role: "end_frame", ordinal: 0, runtime: false }] : []),
      ],
      technicalReport: {
        operation: "animate_object",
        strategy: "reference_sheet",
        routeLabel: TEMPORAL_ROUTE_LABELS.object_sheet,
        objectAssetId: object.asset.id,
        objectRevisionId: object.revision.id,
        keepFirstFrame: keep,
        keepFirstFrameSemantics: keep ? "Quadro 0 (ref) é a vista aprovada copiada localmente; a folha trouxe só os gerados" : "Só os quadros gerados: a referência não se repete no clipe",
        frameCount: generated.length,
        expectedFrames: expected,
        receivedImages: partResults(ctx, part.part_key).length,
        frameIds: ids,
        durationsMs: durations,
        endFrame: p.params.endFrame,
        remoteId: part.remote_id,
        frames: partSteps(ctx, part),
        warnings: partWarnings(ctx, part),
      },
    });
    return [revision.id];
  },
};

// ---------------------------------------------------------------------------
// Interpolação
// ---------------------------------------------------------------------------

async function endpointFrames(env: PipelineEnv, p: Plan<"interpolate_frames">, dir: string) {
  return (await composeLayouts(env, p, p.params.frames, p.params.logicalSize, dir)).frames;
}

export const interpolationPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "interpolate_frames") throw new Error("inalcançável");
    if (asset.family !== "character" || asset.kind !== "clip") throw new DomainFailure("validation_failed", "Os intermediários publicam num clipe (character/clip)");
    const t = plan.params.target;
    if (t.kind === "insert" && getRevision(db, projectId, t.clipRevisionId).assetId !== asset.id) throw new DomainFailure("validation_failed", "Os intermediários entram no próprio clipe dos keyframes");
  },
  async loadInputs(ctx, plan) {
    const p = plan as Plan<"interpolate_frames">;
    const env = envOf(ctx);
    const dir = path.join(ctx.workDir, "interp-inputs");
    const sheet = sheetOf(p);
    if (!sheet) {
      const [a, b] = await endpointFrames(env, p, dir);
      return [
        { role: "first_frame", mime: "image/png", bytes: await bytesOf(env, a!.sha256) },
        { role: "last_frame", mime: "image/png", bytes: await bytesOf(env, b!.sha256) },
      ];
    }
    const one = { columns: 1, rows: 1, scale: sheetScale(1, 1, p.params.logicalSize), flattenOnto: sheet.backgroundKey };
    const start = await composeLayouts(env, p, [p.params.frames[0]!], p.params.logicalSize, path.join(dir, "a"), one);
    const end = await composeLayouts(env, p, [p.params.frames[1]!], p.params.logicalSize, path.join(dir, "b"), one);
    return [
      { role: "first_frame", mime: "image/png", bytes: await bytesOf(env, start.sheetSha!) },
      { role: "last_frame", mime: "image/png", bytes: await bytesOf(env, end.sheetSha!) },
    ];
  },
  async process(env, plan, sha256, dir) {
    const p = plan as Plan<"interpolate_frames">;
    const [a, b] = await endpointFrames(env, p, path.join(dir, "endpoints"));
    const endpoints = [a!.rgbaSha256, b!.rgbaSha256];
    const sheet = sheetOf(p);
    if (!sheet) return nativeResult(await fitCell(env, sha256, dir, p.params.logicalSize), { endpoints });
    const result = await sheetToFrames(env, sha256, dir, sheet, { mode: "seat", baseSha: a!.sha256, keepHorizontal: true });
    result.processed.details = { ...result.processed.details, endpoints };
    return result;
  },
  publish(ctx, plan, asset, part) {
    const p = plan as Plan<"interpolate_frames">;
    const rows = processedRows(ctx, part);
    const endpoints = new Set((rows[0]!.processed.details as { endpoints: string[] }).endpoints);
    const all = partFrames(ctx, p, part);
    // Sem duplicar os extremos: um "intermediário" idêntico a um keyframe é descartado e relatado.
    const duplicates = all.filter((f) => f.rgbaSha256 && endpoints.has(f.rgbaSha256)).map((f) => f.frameId);
    const frames = all.filter((f) => !(f.rgbaSha256 && endpoints.has(f.rgbaSha256)));
    if (frames.length === 0) throw new DomainFailure("validation_failed", "O provedor não devolveu nenhum intermediário novo (só cópias dos extremos)");
    const durations = distributeDurations(p.params.transitionMs, frames.length);
    const [w, h] = p.params.logicalSize;
    const t = p.params.target;
    const sfx = suffix(ctx);
    const report = {
      operation: "interpolate_frames",
      strategy: sheetOf(p) ? "reference_sheet" : "native",
      routeLabel: sheetOf(p) ? TEMPORAL_ROUTE_LABELS.interpolate_sheet : TEMPORAL_ROUTE_LABELS.interpolate_native,
      countRequested: p.params.count,
      countDecidedBy: p.params.count === null ? "rota nativa" : "plano (rota genérica)",
      receivedImages: partResults(ctx, part.part_key).length,
      droppedEndpointCopies: duplicates,
      transitionMs: p.params.transitionMs,
      durationsMs: durations,
      remoteId: part.remote_id,
      frames: partSteps(ctx, part),
      warnings: [...partWarnings(ctx, part), ...(duplicates.length ? [`${duplicates.length} imagem(ns) idêntica(s) a um keyframe descartada(s): os extremos não se repetem`] : [])],
    };
    if (t.kind === "insert") {
      const clip = loadClip(ctx.db, ctx.job.project_id, t.clipRevisionId);
      const a = clip.payload.frames.find((f) => f.frameId === t.afterFrameId)!;
      const b = clip.payload.frames.find((f) => f.frameId === t.beforeFrameId)!;
      const ids = sheetOf(p) ? frames.map((f) => f.frameId) : intermediateFrameIds(clip.payload.frames.map((f) => f.frameId), a.frameId, b.frameId, frames.length);
      const inserted = ids.map((id, i) => {
        const k = (i + 1) / (ids.length + 1);
        return cellFrame(id, durations[i]!, `frame-${id}-${sfx}`, [w, h], { sockets: interpolateSockets(a.sockets, b.sockets, k), rootOffset: interpolateOffset(a.rootOffset, b.rootOffset, k) });
      });
      const payload = insertFrames(clip.payload, a.frameId, inserted);
      const kept = keptFiles(clip.revision, "character", "clip", clip.payload);
      const sha = (fileId: string) => clip.revision.files.find((f) => f.fileKey === fileId)?.sha256 ?? fileId;
      const revision = publishRevision(ctx.db, ctx.clock, {
        projectId: ctx.job.project_id,
        assetId: asset.id,
        origin: "generation",
        styleRevisionId: plan.styleRevisionId,
        jobAttemptId: ctx.attempt.id,
        predecessorId: clip.revision.id,
        payload,
        files: [...kept.map((f) => fileRef(ctx.db, f)), ...inserted.map((f, i) => ({ fileKey: f.layers[0]!.fileId, role: "frame", idx: kept.length + i, blob: mustBlob(ctx.db, frames[i]!.sha256) })), ...rawFiles(ctx, part, `raw-${sfx}`)],
        edges: [{ toRevisionId: clip.revision.id, role: "source", ordinal: 0, runtime: false }],
        technicalReport: {
          ...report,
          target: "insert",
          insertedFrameIds: ids,
          between: [a.frameId, b.frameId],
          // Originais preservados: mesmo digest de geometria (arquivo, retângulo, posição, sockets, duração).
          preserved: clip.payload.frames.map((f) => ({ frameId: f.frameId, digest: frameDigest(f, sha) })),
          socketsInterpolated: inserted.map((f) => ({ frameId: f.frameId, sockets: f.sockets.map((s) => s.socketId) })),
        },
      });
      return [revision.id];
    }
    // Clipe novo entre duas vistas: início, intermediários e fim, com cada extremo uma única vez.
    const startSrc = p.sources.find((s) => s.role === "first_frame")!;
    const endSrc = p.sources.find((s) => s.role === "last_frame")!;
    const ids = sheetOf(p) ? frames.map((f) => f.frameId) : intermediateFrameIds(["start", "end"], "start", "end", frames.length);
    const clipFrames = [cellFrame("start", t.startMs, "kf-start", [w, h]), ...ids.map((id, i) => cellFrame(id, durations[i]!, `frame-${id}`, [w, h])), cellFrame("end", t.endMs, "kf-end", [w, h])];
    const payload: ClipPayload = {
      rigRevisionId: null,
      motionRevisionId: null,
      action: t.action,
      state: t.state,
      stance: null,
      direction: t.direction,
      logicalSize: [w, h],
      pivot: p.params.pivot,
      margins: { left: 0, right: 0, top: 0, bottom: 0 },
      playback: t.playback,
      frames: clipFrames,
      events: [],
    };
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "generation",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      payload,
      files: [
        { fileKey: "kf-start", role: "keyframe", idx: 0, blob: mustBlob(ctx.db, startSrc.sha256) },
        { fileKey: "kf-end", role: "keyframe", idx: 1, blob: mustBlob(ctx.db, endSrc.sha256) },
        ...ids.map((id, i) => ({ fileKey: `frame-${id}`, role: "frame", idx: i, blob: mustBlob(ctx.db, frames[i]!.sha256) })),
        ...rawFiles(ctx, part),
      ],
      edges: [
        { toRevisionId: startSrc.revisionId, role: "first_frame", ordinal: 0, runtime: false },
        { toRevisionId: endSrc.revisionId, role: "last_frame", ordinal: 0, runtime: false },
      ],
      technicalReport: { ...report, target: "new_clip", insertedFrameIds: ids, endpointFiles: { start: startSrc.sha256, end: endSrc.sha256 } },
    });
    return [revision.id];
  },
};

// ---------------------------------------------------------------------------
// Edição de trecho e roupa (mesma disposição dos quadros de origem)
// ---------------------------------------------------------------------------

async function frameInputs(ctx: HandlerContext, p: Plan<"edit_animation"> | Plan<"transfer_outfit">, dir: string) {
  const env = envOf(ctx);
  const sheet = sheetOf(p);
  if (!sheet) {
    const { frames } = await composeLayouts(env, p, p.params.frames, p.params.logicalSize, dir);
    return Promise.all(frames.map(async (f) => ({ role: "source", mime: "image/png", bytes: await bytesOf(env, f.sha256) })));
  }
  return [{ role: "source", mime: "image/png", bytes: await referenceSheet(env, p, p.params.frames, p.params.logicalSize, sheet, dir) }];
}

async function sameLayoutProcess(env: PipelineEnv, p: Plan<"edit_animation"> | Plan<"transfer_outfit">, sha256: string, dir: string): Promise<ProcessResult> {
  const sheet = sheetOf(p);
  if (!sheet) return nativeResult(await fitCell(env, sha256, dir, p.params.logicalSize), {});
  const originals = await composeLayouts(env, p, p.params.frames, p.params.logicalSize, path.join(dir, "originals"));
  return sheetToFrames(env, sha256, dir, sheet, { mode: "match", originals: originals.frames.map((f) => f.sha256) });
}

function orderedFrames(ctx: HandlerContext, p: Plan<"edit_animation"> | Plan<"transfer_outfit">, part: PartRow): FrameOut[] {
  const frames = partFrames(ctx, p, part);
  if (frames.length !== p.params.frameIds.length) {
    throw new DomainFailure("validation_failed", `O provedor devolveu ${frames.length} quadro(s); o trecho tem ${p.params.frameIds.length}. Respostas brutas guardadas no job.`, {
      received: frames.length,
      expected: p.params.frameIds.length,
    });
  }
  return p.params.frameIds.map((frameId, i) => ({ ...frames[i]!, frameId }));
}

export const editAnimationPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "edit_animation") throw new Error("inalcançável");
    if (getRevision(db, projectId, plan.params.clipRevisionId).assetId !== asset.id) throw new DomainFailure("validation_failed", "O trecho editado publica no próprio clipe");
  },
  loadInputs: (ctx, plan) => frameInputs(ctx, plan as Plan<"edit_animation">, path.join(ctx.workDir, "edit-inputs")),
  process: (env, plan, sha256, dir) => sameLayoutProcess(env, plan as Plan<"edit_animation">, sha256, dir),
  publish(ctx, plan, asset, part) {
    const p = plan as Plan<"edit_animation">;
    const frames = orderedFrames(ctx, p, part);
    const clip = loadClip(ctx.db, ctx.job.project_id, p.params.clipRevisionId);
    const [w, h] = p.params.logicalSize;
    const sfx = suffix(ctx);
    const replacements = Object.fromEntries(frames.map((f) => [f.frameId, [{ partId: "body", fileId: `edit-${f.frameId}-${sfx}`, rect: [0, 0, w, h] as [number, number, number, number], offset: [0, 0] as [number, number] }]]));
    const payload = replaceFrameLayers(clip.payload, replacements);
    const kept = keptFiles(clip.revision, "character", "clip", payload);
    const sha = (rev: RevisionView, map: Map<string, string>) => (fileId: string) => map.get(fileId) ?? rev.files.find((f) => f.fileKey === fileId)?.sha256 ?? fileId;
    const fresh = new Map(frames.map((f) => [`edit-${f.frameId}-${sfx}`, f.sha256]));
    const before = sha(clip.revision, new Map());
    const after = sha(clip.revision, fresh);
    const protectedFrames = clip.payload.frames.filter((f) => !p.params.frameIds.includes(f.frameId));
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "edit",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      predecessorId: clip.revision.id,
      payload,
      files: [...kept.map((f) => fileRef(ctx.db, f)), ...frames.map((f, i) => ({ fileKey: `edit-${f.frameId}-${sfx}`, role: "frame", idx: kept.length + i, blob: mustBlob(ctx.db, f.sha256) })), ...rawFiles(ctx, part, `raw-${sfx}`)],
      edges: [{ toRevisionId: clip.revision.id, role: "source", ordinal: 0, runtime: false }],
      technicalReport: {
        operation: "edit_animation",
        strategy: sheetOf(p) ? "reference_sheet" : "native",
        routeLabel: sheetOf(p) ? TEMPORAL_ROUTE_LABELS.edit_sheet : TEMPORAL_ROUTE_LABELS.edit_native,
        editedFrameIds: p.params.frameIds,
        flattenedLayers: clip.payload.frames.filter((f) => p.params.frameIds.includes(f.frameId) && f.layers.length > 1).map((f) => f.frameId),
        // Quadros protegidos: mesmo digest antes e depois (mesmos arquivos, retângulos, sockets e duração).
        protectedFrames: protectedFrames.map((f) => ({ frameId: f.frameId, before: frameDigest(f, before), after: frameDigest(payload.frames.find((x) => x.frameId === f.frameId)!, after) })),
        affected: affectedByFrames(ctx.db, ctx.job.project_id, clip.revision.id, p.params.frameIds),
        remoteId: part.remote_id,
        frames: partSteps(ctx, part),
        warnings: partWarnings(ctx, part),
      },
    });
    return [revision.id];
  },
};

export const outfitPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "transfer_outfit") throw new Error("inalcançável");
    if (asset.family !== "character" || asset.kind !== "clip") throw new DomainFailure("validation_failed", "A roupa transferida publica um clipe candidato vestido (character/clip), não um overlay");
    if (getRevision(db, projectId, plan.params.clipRevisionId).assetId === asset.id) throw new DomainFailure("validation_failed", "O clipe vestido tem asset próprio: nunca substitui o clipe da base limpa");
  },
  async loadInputs(ctx, plan) {
    const p = plan as Plan<"transfer_outfit">;
    const env = envOf(ctx);
    const outfit = p.sources.find((s) => s.role === "equipment")!;
    const frames = await frameInputs(ctx, p, path.join(ctx.workDir, "outfit-inputs"));
    const sheet = sheetOf(p);
    if (!sheet) return [{ role: "equipment", mime: "image/png", bytes: await ctx.blobs.read(outfit.sha256) }, ...frames];
    const info = readPngInfo(await bytesOf(env, outfit.sha256));
    const ref = await scaledReference(env, path.join(ctx.workDir, "outfit-ref"), outfit.sha256, [info?.width ?? p.params.logicalSize[0], info?.height ?? p.params.logicalSize[1]], sheet.backgroundKey);
    // Ordem das imagens no prompt: 1 = folha do clipe, 2 = roupa.
    return [...frames, { role: "equipment", mime: "image/png", bytes: ref }];
  },
  process: (env, plan, sha256, dir) => sameLayoutProcess(env, plan as Plan<"transfer_outfit">, sha256, dir),
  publish(ctx, plan, asset, part) {
    const p = plan as Plan<"transfer_outfit">;
    const frames = orderedFrames(ctx, p, part);
    const clip = loadClip(ctx.db, ctx.job.project_id, p.params.clipRevisionId);
    const [w, h] = p.params.logicalSize;
    const included = new Set(p.params.frameIds);
    const payload: ClipPayload = {
      ...clip.payload,
      state: p.params.stateKey,
      frames: clip.payload.frames.filter((f) => included.has(f.frameId)).map((f) => ({ ...f, layers: [{ partId: "body", fileId: `outfit-${f.frameId}`, rect: [0, 0, w, h], offset: [0, 0] }] })),
      events: clip.payload.events.filter((e) => included.has(e.frameId)),
    };
    const outfit = p.sources.find((s) => s.role === "equipment")!;
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "generation",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      payload,
      files: [...frames.map((f, i) => ({ fileKey: `outfit-${f.frameId}`, role: "frame", idx: i, blob: mustBlob(ctx.db, f.sha256) })), ...rawFiles(ctx, part)],
      edges: [
        { toRevisionId: clip.revision.id, role: "source", ordinal: 0, runtime: false },
        { toRevisionId: outfit.revisionId, role: "outfit", ordinal: 0, runtime: false },
      ],
      technicalReport: {
        operation: "transfer_outfit",
        strategy: sheetOf(p) ? "reference_sheet" : "native",
        routeLabel: sheetOf(p) ? TEMPORAL_ROUTE_LABELS.outfit_sheet : TEMPORAL_ROUTE_LABELS.outfit_native,
        // Contrato com o S2: clipe vestido achatado, mesmos frameIds e célula do clipe de origem.
        dressedCandidate: true,
        modularOverlay: false,
        replacesCleanBase: false,
        note: "Clipe candidato vestido: não é overlay modular nem substitui a base limpa; a cobertura modular é extraída pelo fluxo de equipamentos",
        sourceClipRevisionId: clip.revision.id,
        outfit: p.params.outfit,
        frameIds: p.params.frameIds,
        remoteId: part.remote_id,
        frames: partSteps(ctx, part),
        warnings: partWarnings(ctx, part),
      },
    });
    return [revision.id];
  },
};

// ---------------------------------------------------------------------------
// Correção de um quadro/região (máquina do E1: proteção exata do RGBA)
// ---------------------------------------------------------------------------

/** Máscara da correção: o upload congelado ou, sem máscara, o quadro inteiro (255 em toda a célula). */
async function correctionMask(env: PipelineEnv, p: Plan<"correct_frame">): Promise<{ sha256: string; generated: { blob: StoredBlob; width: number; height: number } | null }> {
  const source = p.sources.find((s) => s.role === "edit_mask");
  if (source) return { sha256: source.sha256, generated: null };
  const [w, h] = p.params.logicalSize;
  const img = createImage(w, h);
  fillRect(img, 0, 0, w, h, [255, 255, 255, 255]);
  const blob = await env.blobs.putBytes(encodePng(img));
  return { sha256: blob.sha256, generated: { blob, width: w, height: h } };
}

export const correctFramePipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "correct_frame") throw new Error("inalcançável");
    if (getRevision(db, projectId, plan.params.clipRevisionId).assetId !== asset.id) throw new DomainFailure("validation_failed", "A correção publica no próprio clipe");
  },
  async loadInputs(ctx, plan, adapter: ProviderAdapter) {
    const p = plan as Plan<"correct_frame">;
    const env = envOf(ctx);
    const dir = path.join(ctx.workDir, "correct-inputs");
    const { frames } = await composeLayouts(env, p, p.params.frames, p.params.logicalSize, path.join(dir, "frames"));
    const target = frames[0]!;
    const mask = await correctionMask(env, p);
    const read = async (absolutePath: string) => new Uint8Array(await readFile(absolutePath));
    if (p.params.mode === "native-mask") {
      const encoding = adapter.maskEncoding ?? "white_edits_black_preserves";
      const encoded = await pythonWith(env, path.join(dir, "mask"), "encode_mask", [{ role: "editMask", sha256: mask.sha256 }], { version: 1, encoding });
      if (encoded.status === "error") throw new DomainFailure("validation_failed", `Máscara inválida: ${encoded.message}`, { code: encoded.code });
      if ((encoded.report as { editedPixels: number }).editedPixels === 0) throw new DomainFailure("validation_failed", "Máscara vazia: nenhuma região a corrigir. Nada foi enviado.", { emptyMask: true });
      return [
        { role: "source", mime: "image/png", bytes: await bytesOf(env, target.sha256) },
        { role: encoding === "alpha_zero_edits" ? "remote_mask" : "edit_mask", mime: "image/png", bytes: await read(encoded.outputs[0]!.absolutePath) },
      ];
    }
    const sheet = sheetOf(p)!;
    const style = getStyleRevision(ctx.db, ctx.job.project_id, p.styleRevisionId).payload;
    const guide = await pythonWith(env, path.join(dir, "guide"), "inpaint_guide", [{ role: "source", sha256: target.sha256 }, { role: "editMask", sha256: mask.sha256 }], {
      version: 1,
      scale: guideScale(p.params.logicalSize),
      markColor: correctionMarkColor({ style }, sheet.backgroundKey),
      ...(sheet.backgroundKey ? { flattenOnto: sheet.backgroundKey } : {}),
    });
    if (guide.status === "error") throw new DomainFailure("validation_failed", `Falha ao preparar a guia: ${guide.message}`, { code: guide.code });
    if ((guide.report as { editedPixels: number }).editedPixels === 0) throw new DomainFailure("validation_failed", "Máscara vazia: nenhuma região a corrigir. Nada foi enviado.", { emptyMask: true });
    const byRole = (role: string) => guide.outputs.find((o) => o.role === role)!;
    const neighbors = [];
    for (const [i, layout] of p.params.frames.slice(1).entries()) {
      const one = await composeLayouts(env, p, [layout], p.params.logicalSize, path.join(dir, `n${i}`), { columns: 1, rows: 1, scale: guideScale(p.params.logicalSize), flattenOnto: sheet.backgroundKey });
      neighbors.push({ role: "composition", mime: "image/png", bytes: await bytesOf(env, one.sheetSha!) });
    }
    return [{ role: "source", mime: "image/png", bytes: await read(byRole("context").absolutePath) }, { role: "guide", mime: "image/png", bytes: await read(byRole("guide").absolutePath) }, ...neighbors];
  },
  async process(env, plan, sha256, dir) {
    const p = plan as Plan<"correct_frame">;
    const { frames } = await composeLayouts(env, p, [p.params.frames[0]!], p.params.logicalSize, path.join(dir, "target"));
    const target = frames[0]!;
    const mask = await correctionMask(env, p);
    const sheet = sheetOf(p);
    let candidate: StoredBlob;
    let steps: Record<string, unknown>[];
    let warnings: string[];
    let receivedSize: [number, number] | undefined;
    if (!sheet) {
      const fitted = await fitCell(env, sha256, dir, p.params.logicalSize);
      candidate = fitted.stored;
      ({ steps, warnings, receivedSize } = fitted);
    } else {
      const matched = await sheetToFrames(env, sha256, dir, sheet, { mode: "match", originals: [target.sha256] });
      candidate = matched.extraBlobs!.find((b) => b.blob.sha256 === matched.frames[0]!.sha256)!.blob;
      steps = matched.processed.steps ?? [];
      warnings = matched.processed.warnings;
      receivedSize = matched.processed.receivedSize;
    }
    const composite = await pythonWith(env, path.join(dir, "composite"), "composite_protected", [{ role: "source", sha256: target.sha256 }, { role: "candidate", sha256: candidate.sha256 }, { role: "editMask", sha256: mask.sha256 }], {
      version: 1,
      maskConvention: "white_edits_black_preserves",
    });
    if (composite.status === "error") throw new DomainFailure("validation_failed", composite.message, { code: composite.code });
    const out = composite.outputs.find((o) => o.role === "protected")!;
    const stored = await env.blobs.putFile(out.absolutePath);
    const [w, h] = p.params.logicalSize;
    return {
      processed: {
        normalizedSha256: stored.sha256,
        width: out.width!,
        height: out.height!,
        ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}),
        ...(receivedSize ? { receivedSize } : {}),
        steps: [...steps, { operation: "composite_protected", ...composite.report }],
        warnings: [...warnings, ...composite.warnings],
        candidateSha256: candidate.sha256,
        composite: composite.report,
        details: { kind: "correction", maskSha256: mask.sha256, targetSha256: target.sha256 },
      },
      stored,
      extraBlobs: [{ blob: candidate, width: w, height: h }, ...(mask.generated ? [mask.generated] : [])],
    };
  },
  publish(ctx, plan, asset, part) {
    const p = plan as Plan<"correct_frame">;
    const row = processedRows(ctx, part)[0]!;
    const clip = loadClip(ctx.db, ctx.job.project_id, p.params.clipRevisionId);
    const [w, h] = p.params.logicalSize;
    const sfx = suffix(ctx);
    const fileId = `fix-${p.params.frameId}-${sfx}`;
    const payload = replaceLayer(clip.payload, p.params.frameId, p.params.partId, { partId: p.params.partId, fileId, rect: [0, 0, w, h], offset: [0, 0] });
    const kept = keptFiles(clip.revision, "character", "clip", payload);
    const details = row.processed.details as { maskSha256: string; targetSha256: string };
    const before = (fileId: string) => clip.revision.files.find((f) => f.fileKey === fileId)?.sha256 ?? fileId;
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "edit",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      predecessorId: clip.revision.id,
      payload,
      files: [
        ...kept.map((f) => fileRef(ctx.db, f)),
        { fileKey: fileId, role: "corrected", idx: 0, blob: mustBlob(ctx.db, row.processed.normalizedSha256) },
        { fileKey: `fix-candidate-${sfx}`, role: "candidate", idx: 0, blob: mustBlob(ctx.db, row.processed.candidateSha256!) },
        { fileKey: `fix-mask-${sfx}`, role: "mask", idx: 0, blob: mustBlob(ctx.db, details.maskSha256) },
        ...rawFiles(ctx, part, `raw-${sfx}`),
      ],
      edges: [{ toRevisionId: clip.revision.id, role: "source", ordinal: 0, runtime: false }],
      technicalReport: {
        operation: "correct_frame",
        mode: p.params.mode,
        modeLabel: p.params.mode === "native-mask" ? TEMPORAL_ROUTE_LABELS.correct_native : TEMPORAL_ROUTE_LABELS.correct_candidate,
        frameId: p.params.frameId,
        partId: p.params.partId,
        contextFrameIds: p.params.contextFrameIds,
        mask: p.params.editMaskFileId ? { uploadId: p.params.editMaskFileId } : { fullFrame: true },
        composite: row.processed.composite,
        // Os outros quadros ficam com o mesmo digest (mesmos arquivos, retângulos, sockets e duração).
        unchangedFrames: clip.payload.frames.filter((f) => f.frameId !== p.params.frameId).map((f) => ({ frameId: f.frameId, digest: frameDigest(f, before) })),
        affected: affectedByFrames(ctx.db, ctx.job.project_id, clip.revision.id, [p.params.frameId]),
        remoteId: part.remote_id,
        receivedSize: row.processed.receivedSize,
        steps: row.processed.steps ?? [],
        warnings: row.processed.warnings,
      },
    });
    return [revision.id];
  },
};

