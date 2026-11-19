import { pick, tx } from "@/i18n/locales";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type ClipPayload, type Direction, type GenerationPlan, type MotionPayload, type ReferenceSheet } from "@/contracts";
import { renderPoseGuide } from "@/domain/animation/pose-guide";
import { parsePresetRevisionId } from "@/domain/animation/presets";
import { canonicalDigest } from "@/domain/canonical-json";
import { readPngInfo } from "@/lib/media/png";
import { loadBase, rigForBase, ROUTE_LABELS, textActionKey, textFrameIds } from "../../../animation/base";
import { type AssetView, getRevision, publishRevision } from "../../../catalog/catalog";
import type { Db } from "../../../db/connection";
import { DomainFailure } from "../../../errors";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, python, pythonWith } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";

/**
 * Animação (cartão S1): preset, texto livre e esqueleto.
 *
 * - Nativo: o provedor devolve um quadro por imagem, já na célula do quadro
 *   inicial; só se valida contagem, tamanho e alfa — o deslocamento desenhado
 *   (passada, salto, recuo) é preservado.
 * - Folha (rota genérica): uma imagem com a grade do plano; normaliza a grade
 *   aparente, remove a cor-chave e o `animation_sheet` fatia e assenta cada
 *   quadro pelo apoio da base com uma escala comum.
 *
 * Publica uma revisão CANDIDATA de clipe (`character/clip`) por job, com um
 * arquivo por quadro e `durationMs` de cada quadro; aprovação no fluxo de revisão.
 */

export type AnimationPlan = Extract<GenerationPlan, { operation: "animate_preset" | "animate_text" | "animate_skeleton" }>;

export function sheetOf(plan: GenerationPlan): ReferenceSheet | undefined {
  return "sheet" in plan.params ? (plan.params.sheet as ReferenceSheet | undefined) : undefined;
}

export interface FrameSpec {
  frameIds: string[];
  durationsMs: number[];
  action: string;
  stance: string | null;
  direction: Direction;
  playback: ClipPayload["playback"];
  motionRevisionId: string | null;
  presetKey: string | null;
}

function frozenMotion(db: Db, projectId: string, plan: AnimationPlan): MotionPayload | null {
  const source = plan.sources.find((s) => s.role === "motion");
  if (!source) return null;
  const revision = getRevision(db, projectId, source.revisionId);
  if (canonicalDigest(revision.payload) !== source.sha256) throw new DomainFailure("validation_failed", tx("Movimento diverge do digest congelado no plano", "Motion differs from the digest frozen in the plan"));
  return revision.payload as MotionPayload;
}

/** Quadros esperados do plano: IDs do preset, das poses aprovadas ou sequenciais no texto livre. */
export function frameSpec(db: Db, projectId: string, plan: AnimationPlan): FrameSpec {
  switch (plan.operation) {
    case "animate_preset": {
      const preset = parsePresetRevisionId(plan.params.presetRevisionId)?.preset;
      if (!preset) throw new DomainFailure("not_found", tx(`Preset ${plan.params.presetRevisionId} desconhecido`, `Unknown preset ${plan.params.presetRevisionId}`));
      return {
        frameIds: [...preset.frameIds],
        durationsMs: plan.params.durationsMs,
        action: plan.params.action,
        stance: plan.params.stance,
        direction: plan.params.directions[0]!,
        playback: plan.params.playback,
        motionRevisionId: plan.params.motionRevisionId ?? null,
        presetKey: preset.key,
      };
    }
    case "animate_text":
      return {
        frameIds: textFrameIds(plan.params.durationsMs.length),
        durationsMs: plan.params.durationsMs,
        action: textActionKey(plan.params.actionText),
        stance: null,
        direction: plan.params.direction,
        playback: plan.params.playback,
        motionRevisionId: null,
        presetKey: null,
      };
    case "animate_skeleton": {
      const motion = frozenMotion(db, projectId, plan)!;
      return {
        frameIds: motion.poses.map((p) => p.poseId),
        durationsMs: motion.poses.map((p) => p.durationMs),
        action: motion.action,
        stance: null,
        direction: motion.direction,
        playback: plan.params.playback,
        motionRevisionId: plan.params.motionRevisionId,
        presetKey: null,
      };
    }
  }
}

/** Fator inteiro para a referência enviada a rota genérica: lado menor ≥ 256 px, maior ≤ 1024. */
export function referenceScale([w, h]: [number, number]): number {
  return Math.max(1, Math.min(Math.ceil(256 / Math.min(w, h)), Math.floor(1024 / Math.max(w, h))));
}

/** Vista da base ampliada por fator inteiro (vizinho mais próximo), achatada na cor-chave quando a rota não tem alfa. */
export async function scaledReference(env: PipelineEnv, dir: string, sha256: string, size: [number, number], key: string | null): Promise<Uint8Array> {
  const k = referenceScale(size);
  const out = await pythonWith(env, dir, "make_thumbnail", [{ role: "source", sha256 }], { version: 1, maxSize: Math.max(size[0], size[1]) * k, ...(key ? { flattenOnto: key } : {}) });
  if (out.status === "error") throw new DomainFailure("internal", tx(`Falha ao preparar a referência: ${pick(out.message, "pt-BR")}`, `Failed to prepare the reference: ${pick(out.message, "en")}`));
  return new Uint8Array(await readFile(out.outputs[0]!.absolutePath));
}

async function baseSize(env: PipelineEnv, plan: GenerationPlan): Promise<{ sha256: string; size: [number, number] }> {
  const source = plan.sources.find((s) => s.role === "base" || s.role === "identity")!;
  const info = readPngInfo(await env.blobs.read(source.sha256));
  if (!info) throw new DomainFailure("validation_failed", tx("A vista da base não é PNG", "The base view is not a PNG"));
  return { sha256: source.sha256, size: [info.width, info.height] };
}

async function loadAnimationInputs(ctx: HandlerContext, plan: AnimationPlan) {
  const env = envOf(ctx);
  const base = await baseSize(env, plan);
  const motion = frozenMotion(ctx.db, ctx.job.project_id, plan);
  const sheet = sheetOf(plan);
  if (!sheet) {
    // Nativo: quadro inicial real + poses como DADOS (referência JSON), nunca só no prompt.
    return [
      { role: "base", mime: "image/png", bytes: await ctx.blobs.read(base.sha256) },
      ...(motion ? [{ role: "motion", mime: "application/json", bytes: new TextEncoder().encode(JSON.stringify(motion)) }] : []),
    ];
  }
  const dir = path.join(ctx.workDir, "animation-inputs");
  const refs = [{ role: "identity", mime: "image/png", bytes: await scaledReference(env, path.join(dir, "identity"), base.sha256, base.size, sheet.backgroundKey) }];
  if (motion) {
    // Rota genérica: a sequência aprovada vira guia raster com a mesma grade da folha pedida (papel `pose`).
    const scale = Math.max(1, Math.floor(1024 / (sheet.columns * sheet.cell[0])));
    refs.push({
      role: "pose",
      mime: "image/png",
      bytes: renderPoseGuide({ skeleton: motion.skeleton, poses: motion.poses.map((p) => p.joints), columns: sheet.columns, rows: sheet.rows, cell: sheet.cell, scale, background: [255, 255, 255, 255] }),
    });
  }
  return refs;
}

/** Imagem nativa: um quadro na célula do quadro inicial. Tamanho diferente só por fator exato, nunca esticado. */
export async function processNativeFrame(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult> {
  const { size } = await baseSize(env, plan);
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") throw new DomainFailure("validation_failed", tx(`Resposta do provedor não é uma imagem utilizável: ${pick(ingest.message, "pt-BR")}`, `Provider response is not a usable image: ${pick(ingest.message, "en")}`), { code: ingest.code });
  let out = ingest.outputs.find((o) => o.role === "normalized")!;
  const steps: Record<string, unknown>[] = [];
  const warnings = [...ingest.warnings];
  if (out.width !== size[0] || out.height !== size[1]) {
    const current = await env.blobs.putFile(out.absolutePath);
    const fit = await python(env, path.join(dir, "fit"), "fit_logical", current.sha256, { version: 1, targetSize: size, exactAspect: true, alphaThreshold: 128 });
    if (fit.status === "error") throw new DomainFailure("validation_failed", tx(`Quadro fora da célula ${size.join("×")}: ${pick(fit.message, "pt-BR")}`, `Frame does not fit the ${size.join("×")} cell: ${pick(fit.message, "en")}`), { code: fit.code });
    out = fit.outputs.find((o) => o.role === "fitted")!;
    steps.push({ operation: "fit_logical", ...fit.report });
    warnings.push(tx(`Quadro veio com ${ingest.report.size} e foi levado à célula ${size.join("×")}`, `Frame came in at ${ingest.report.size} and was fitted to the ${size.join("×")} cell`), ...fit.warnings);
  }
  const stored = await env.blobs.putFile(out.absolutePath);
  const processed: ProcessedPart = {
    normalizedSha256: stored.sha256,
    width: out.width!,
    height: out.height!,
    ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}),
    partialAlpha: Boolean(ingest.report.partialAlpha),
    receivedSize: ingest.report.size as [number, number],
    steps,
    warnings,
    details: { kind: "frame" },
  };
  return { processed, stored };
}

/**
 * Folha de uma rota genérica → quadros na célula da base: grade aparente
 * (unzoom), cor-chave removida e `animation_sheet` (escala comum + apoio).
 */
export async function processSheet(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string, frameIds: string[]): Promise<ProcessResult> {
  const sheet = sheetOf(plan)!;
  const base = await baseSize(env, plan);
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") throw new DomainFailure("validation_failed", tx(`Resposta do provedor não é uma imagem utilizável: ${pick(ingest.message, "pt-BR")}`, `Provider response is not a usable image: ${pick(ingest.message, "en")}`), { code: ingest.code });
  let out = ingest.outputs.find((o) => o.role === "normalized")!;
  const warnings = [...ingest.warnings];
  const steps: Record<string, unknown>[] = [];
  const key = sheet.backgroundKey;
  const step = async (name: "unzoom" | "remove_background_flood", recipe: Record<string, unknown>, role: string) => {
    const current = await env.blobs.putFile(out.absolutePath);
    const result = await python(env, path.join(dir, name), name, current.sha256, recipe);
    if (result.status === "error") throw new DomainFailure("validation_failed", tx(`Etapa ${name} falhou: ${pick(result.message, "pt-BR")}`, `Step ${name} failed: ${pick(result.message, "en")}`), { code: result.code });
    out = result.outputs.find((o) => o.role === role)!;
    warnings.push(...result.warnings);
    steps.push({ operation: name, ...result.report });
  };
  const logical = [sheet.columns * sheet.cell[0], sheet.rows * sheet.cell[1]];
  await step(
    "unzoom",
    {
      version: 1,
      minAgreement: 0.9,
      minContentCells: Math.ceil(Math.max(logical[0]!, logical[1]!) / 2),
      ...(key ? { ignoreKeyHue: { hueTolerance: 30, minSaturation: 96, minValue: 100 } } : {}),
    },
    "native",
  );
  if (key) {
    await step(
      "remove_background_flood",
      { version: 1, color: key, tolerance: 0, seeds: { borders: true, points: [] }, connectivity: 4, match: { mode: "hue", hueTolerance: 25, minSaturation: 96, keyFrom: "border" } },
      "cutout",
    );
  }
  const current = await env.blobs.putFile(out.absolutePath);
  const sliced = await pythonWith(
    env,
    path.join(dir, "sheet"),
    "animation_sheet",
    [
      { role: "candidate", sha256: current.sha256 },
      { role: "source", sha256: base.sha256 },
    ],
    { version: 1, columns: sheet.columns, rows: sheet.rows, frameIds, cell: sheet.cell, alphaThreshold: 128, scaleTolerance: 0.15, keepHorizontalOffsets: keepHorizontal(plan) },
  );
  if (sliced.status === "error") throw new DomainFailure("validation_failed", tx(`A folha não pôde ser fatiada: ${pick(sliced.message, "pt-BR")}`, `The sheet could not be sliced: ${pick(sliced.message, "en")}`), { code: sliced.code });
  warnings.push(...sliced.warnings);
  steps.push({ operation: "animation_sheet", ...sliced.report });
  const strip = sliced.outputs.find((o) => o.role === "strip")!;
  const stored = await env.blobs.putFile(strip.absolutePath);
  const frames = [];
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
    ...(strip.rgbaSha256 ? { rgbaSha256: strip.rgbaSha256 } : {}),
    receivedSize: ingest.report.size as [number, number],
    steps,
    warnings,
    details: { kind: "sheet", frames, sheet: sliced.report },
  };
  return { processed, stored, extraBlobs };
}

/** Ciclos no lugar (andar, correr, respirar) ancoram o pé no pivô; ações únicas preservam o recuo desenhado. */
function keepHorizontal(plan: GenerationPlan): boolean {
  if (plan.operation === "animate_preset" || plan.operation === "animate_text" || plan.operation === "animate_skeleton") return plan.params.playback !== "loop";
  return false;
}

interface PublishedFrame {
  frameId: string;
  sha256: string;
}

function publishClip(ctx: HandlerContext, plan: AnimationPlan, asset: AssetView, part: PartRow): string[] {
  const spec = frameSpec(ctx.db, ctx.job.project_id, plan);
  const rows = partResults(ctx, part.part_key);
  const sheet = sheetOf(plan);
  const processedRows = rows.map((row) => ({ row, processed: parseJson<ProcessedPart>(row.processed_json)! }));
  let frames: PublishedFrame[];
  if (sheet) {
    const first = processedRows[0]!.processed.details as { frames: PublishedFrame[] };
    frames = first.frames;
  } else {
    // Contagem exata: nunca descartar ou duplicar quadros em silêncio.
    if (processedRows.length !== spec.frameIds.length) {
      throw new DomainFailure("validation_failed", tx(`O provedor devolveu ${processedRows.length} quadro(s); o plano pede ${spec.frameIds.length}. Respostas brutas guardadas no job.`, `The provider returned ${processedRows.length} frame(s); the plan asks for ${spec.frameIds.length}. Raw responses are kept in the job.`), {
        received: processedRows.length,
        expected: spec.frameIds.length,
      });
    }
    frames = processedRows.map(({ processed }, i) => ({ frameId: spec.frameIds[i]!, sha256: processed.normalizedSha256 }));
  }
  if (frames.map((f) => f.frameId).join("|") !== spec.frameIds.join("|")) throw new DomainFailure("validation_failed", tx("Ordem ou IDs dos quadros divergem do plano", "Frame order or IDs differ from the plan"));

  const base = loadBase(ctx.db, ctx.job.project_id, plan.params.baseRevisionId, { approved: false });
  const [w, h] = base.payload.logicalSize;
  const rig = rigForBase(ctx.db, ctx.job.project_id, base);
  const payload: ClipPayload = {
    rigRevisionId: rig?.id ?? null,
    motionRevisionId: spec.motionRevisionId,
    action: spec.action,
    state: null,
    stance: rig && spec.stance && rig.payload.stances.includes(spec.stance) ? spec.stance : null,
    direction: spec.direction,
    logicalSize: [w, h],
    pivot: base.payload.groundOrigin,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    playback: spec.playback,
    frames: frames.map((f, i) => ({
      frameId: f.frameId,
      durationMs: spec.durationsMs[i]!,
      layers: [{ partId: "body", fileId: `frame-${f.frameId}`, rect: [0, 0, w, h], offset: [0, 0] }],
      sockets: [],
      rootOffset: [0, 0],
    })),
    events: [],
  };
  const files = [
    ...frames.map((f, i) => ({ fileKey: `frame-${f.frameId}`, role: "frame", idx: i, blob: mustBlob(ctx.db, f.sha256) })),
    ...(sheet ? [{ fileKey: "strip", role: "strip", idx: 0, blob: mustBlob(ctx.db, processedRows[0]!.processed.normalizedSha256) }] : []),
    ...rows.map((row) => ({ fileKey: `raw-${row.idx}`, role: "raw", idx: row.idx, blob: mustBlob(ctx.db, row.blob_sha256) })),
  ];
  const mode = plan.operation === "animate_preset" ? plan.params.mode : plan.operation === "animate_text" ? "text" : "skeleton";
  const label = sheet ? (mode === "skeleton" ? ROUTE_LABELS.sheet_skeleton : ROUTE_LABELS.sheet_text) : mode === "skeleton" ? ROUTE_LABELS.native_skeleton : ROUTE_LABELS.native_text;
  const revision = publishRevision(ctx.db, ctx.clock, {
    projectId: ctx.job.project_id,
    assetId: asset.id,
    origin: "generation",
    styleRevisionId: plan.styleRevisionId,
    jobAttemptId: ctx.attempt.id,
    payload,
    files,
    edges: [{ toRevisionId: base.revision.id, role: "base", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: plan.operation,
      mode,
      strategy: sheet ? "reference_sheet" : "native",
      routeLabel: label,
      presetKey: spec.presetKey,
      baseRevisionId: base.revision.id,
      baseAssetId: base.asset.id,
      frameIds: spec.frameIds,
      durationsMs: spec.durationsMs,
      remoteId: part.remote_id,
      rig: rig ? { revisionId: rig.id } : null,
      receivedImages: rows.length,
      frames: processedRows.map(({ processed }) => ({ receivedSize: processed.receivedSize, steps: processed.steps ?? [], details: processed.details })),
      warnings: processedRows.flatMap(({ processed }) => processed.warnings),
    },
  });
  return [revision.id];
}

export const animationPipeline: OperationPipeline = {
  validateTarget({ asset }) {
    if (asset.family !== "character" || asset.kind !== "clip") {
      throw new DomainFailure("validation_failed", tx(`A animação publica num clipe (character/clip); o alvo é ${asset.family}/${asset.kind}`, `Animation publishes to a clip (character/clip); the target is ${asset.family}/${asset.kind}`));
    }
  },
  loadInputs: (ctx, plan) => loadAnimationInputs(ctx, plan as AnimationPlan),
  async process(env, plan, sha256, dir) {
    const sheet = sheetOf(plan);
    // A folha congelada declara os IDs dos quadros na ordem da grade: o fatiamento não consulta o catálogo.
    return sheet ? processSheet(env, plan, sha256, dir, sheet.frameIds) : processNativeFrame(env, plan, sha256, dir);
  },
  publish: (ctx, plan, asset, part) => publishClip(ctx, plan as AnimationPlan, asset, part),
};
