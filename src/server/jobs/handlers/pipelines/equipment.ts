import path from "node:path";
import type { ClipPayload, CoverageStrip, GenerationPlan, OverlayPayload } from "@/contracts";
import { defaultDrawIndex } from "@/domain/equipment/template";
import { readPngInfo } from "@/lib/media/png";
import { type AssetView, getRevision, publishRevision, type PublishFile } from "../../../catalog/catalog";
import { loadOverlay } from "../../../equipment/load";
import { reuseFiles } from "../../../equipment/overlays";
import { EQUIPMENT_ROUTE_LABELS } from "../../../equipment/provider-caps";
import { runEquipmentPython, uniqueFiles } from "../../../equipment/python";
import { DomainFailure } from "../../../errors";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { scaledReference } from "./animation";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, python } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";

/**
 * "Criar peça para este personagem" (cartão S2) em rota genérica:
 *
 * - cobertura: cada tira vai ao modelo como frames da base (grade numa tela de
 *   proporção padrão) + guia com a zona autorizada pintada; volta um CANDIDATO
 *   VESTIDO, que é normalizado à tela lógica, sem a cor-chave, e de onde a peça
 *   é extraída localmente por máscara explícita (registro, zona, proteções,
 *   validação de bordas). Publica UMA revisão candidata da peça com todas as
 *   tiras e as células reaproveitadas de poses equivalentes;
 * - vista rígida: item isolado por texto, recortado e levado ao tamanho
 *   declarado, com as empunhaduras do gabarito (revisáveis no editor).
 */

type EquipmentPlan = Extract<GenerationPlan, { operation: "generate_overlay_coverage" }>;
export type CoveragePlan = EquipmentPlan & { params: Extract<EquipmentPlan["params"], { mode: "coverage" }> };

function stripOf(plan: GenerationPlan, part: PartRow | undefined): CoverageStrip {
  if (plan.operation !== "generate_overlay_coverage" || plan.params.mode !== "coverage") throw new Error("inalcançável");
  const strip = part ? plan.params.strips.find((s) => `strip:${s.stripKey}` === part.part_key) : plan.params.strips.length === 1 ? plan.params.strips[0] : undefined;
  if (!strip) throw new DomainFailure("internal", `Parte ${part?.part_key ?? "?"} não corresponde a nenhuma tira do plano`);
  return strip;
}

/** Frames limpos da base, recompostos das camadas congeladas no plano (mesmos bytes a cada tentativa). */
async function baseFrames(env: PipelineEnv, strip: CoverageStrip): Promise<{ frameId: string; sha256: string }[]> {
  const inputs: { role: "layer"; sha256: string }[] = [];
  const ordinal = new Map<string, number>();
  const frames = strip.frames.map((f) => ({
    frameId: f.frameId,
    layers: f.layers.map((l, i) => {
      if (!ordinal.has(l.sha256)) {
        ordinal.set(l.sha256, inputs.length);
        inputs.push({ role: "layer", sha256: l.sha256 });
      }
      return { key: `base:${i}`, inputOrdinal: ordinal.get(l.sha256)!, rect: l.rect, offset: l.offset, mirrored: false };
    }),
  }));
  const run = await runEquipmentPython(env, "equipment_compose", inputs, { cell: strip.cell, frames, tolerancePx: 1 });
  const out = [];
  for (const o of run.outputs.filter((x) => x.role === "frame")) {
    const stored = await env.blobs.putBytes(o.bytes);
    out.push({ frameId: o.key!, sha256: stored.sha256 });
  }
  return out;
}

function zonesFor(plan: CoveragePlan, strip: CoverageStrip, frameId: string, partId: string) {
  return plan.params.zones.find((z) => z.clipRevisionId === strip.clipRevisionId && z.frameId === frameId && z.partId === partId)?.rects ?? [];
}

function protectFor(plan: CoveragePlan, strip: CoverageStrip, frameId: string) {
  return plan.params.protect.find((p) => p.clipRevisionId === strip.clipRevisionId && p.frameId === frameId)?.rects ?? [];
}

/** Lado maior da referência perto de 1024 px por fator inteiro. */
function guideScale(canvas: [number, number]): number {
  return Math.max(1, Math.floor(1024 / Math.max(canvas[0], canvas[1])));
}

async function loadEquipmentInputs(ctx: HandlerContext, plan: EquipmentPlan, part: PartRow | undefined) {
  const env = envOf(ctx);
  const material = plan.sources.find((s) => s.role === "material");
  const materialRef = material
    ? [{ role: "material", mime: "image/png", bytes: await scaledReference(env, path.join(ctx.workDir, "material"), material.sha256, sizeOf(await env.blobs.read(material.sha256)), plan.params.backgroundKey) }]
    : [];
  if (plan.params.mode === "rigid_view") return materialRef;
  const guide = await stripGuide(env, plan as CoveragePlan, stripOf(plan, part));
  return [{ role: "base", mime: "image/png", bytes: guide.context }, { role: "composition", mime: "image/png", bytes: guide.guide }, ...materialRef];
}

/** Referências de uma tira: frames da base na tela (cor-chave) e a mesma tela com a zona autorizada pintada. */
export async function stripGuide(env: PipelineEnv | Pick<PipelineEnv, "blobs" | "config" | "signal">, plan: CoveragePlan, strip: CoverageStrip) {
  const frames = await baseFrames(env as PipelineEnv, strip);
  const guide = await runEquipmentPython(env, "equipment_guide", frames.map((f) => ({ role: "layer" as const, sha256: f.sha256 })), {
    cell: strip.cell,
    canvas: strip.canvas,
    frames: strip.frames.map((f, i) => ({
      frameId: f.frameId,
      baseOrdinal: i,
      at: f.at,
      zones: plan.params.parts.flatMap((p) => zonesFor(plan, strip, f.frameId, p)),
      protect: protectFor(plan, strip, f.frameId),
    })),
    scale: guideScale(strip.canvas),
    markColor: plan.params.markColor,
    flattenOnto: plan.params.backgroundKey,
  });
  const byRole = (role: string) => guide.outputs.find((o) => o.role === role)!.bytes;
  return { context: byRole("context"), guide: byRole("guide") };
}

function sizeOf(bytes: Uint8Array): [number, number] {
  const info = readPngInfo(bytes);
  if (!info) throw new DomainFailure("validation_failed", "Referência não é PNG");
  return [info.width, info.height];
}

/** Resposta do provedor → tela lógica (grade aparente, cor-chave, só fator de escala; nunca esticar). */
async function normalizeCandidate(env: PipelineEnv, sha256: string, dir: string, target: [number, number], key: string | null, opts: { crop: boolean }) {
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") throw new DomainFailure("validation_failed", `Resposta do provedor não é uma imagem utilizável: ${ingest.message}`, { code: ingest.code });
  let out = ingest.outputs.find((o) => o.role === "normalized")!;
  const steps: Record<string, unknown>[] = [];
  const warnings = [...ingest.warnings];
  const step = async (name: "unzoom" | "remove_background_flood" | "fit_logical", recipe: Record<string, unknown>, role: string) => {
    const current = await env.blobs.putFile(out.absolutePath);
    const result = await python(env, path.join(dir, name), name, current.sha256, recipe);
    if (result.status === "error") throw new DomainFailure("validation_failed", `Etapa ${name} falhou: ${result.message}`, { code: result.code });
    out = result.outputs.find((o) => o.role === role)!;
    warnings.push(...result.warnings);
    steps.push({ operation: name, ...result.report });
  };
  if (out.width !== target[0] || out.height !== target[1]) {
    await step(
      "unzoom",
      { version: 1, minAgreement: 0.9, minContentCells: Math.ceil(Math.max(target[0], target[1]) / 2), ...(key ? { ignoreKeyHue: { hueTolerance: 30, minSaturation: 96, minValue: 100 } } : {}) },
      "native",
    );
  }
  if (key) {
    await step(
      "remove_background_flood",
      { version: 1, color: key, tolerance: 0, seeds: { borders: true, points: [] }, connectivity: 4, match: { mode: "hue", hueTolerance: 25, minSaturation: 96, keyFrom: "border" } },
      "cutout",
    );
  }
  if (opts.crop || out.width !== target[0] || out.height !== target[1]) {
    await step("fit_logical", { version: 1, targetSize: target, ...(opts.crop ? { cropToContent: { padding: 0 }, alphaThreshold: 128 } : { exactAspect: true, alphaThreshold: 128 }) }, "fitted");
  }
  return { out, ingest, steps, warnings };
}

async function processCoverage(env: PipelineEnv, plan: CoveragePlan, sha256: string, dir: string, part: PartRow | undefined): Promise<ProcessResult> {
  const strip = stripOf(plan, part);
  const { out, ingest, steps, warnings } = await normalizeCandidate(env, sha256, dir, strip.canvas, plan.params.backgroundKey, { crop: false });
  const candidate = await env.blobs.putFile(out.absolutePath);
  const frames = await baseFrames(env, strip);
  const extract = await runEquipmentPython(
    env,
    "equipment_extract",
    [...frames.map((f) => ({ role: "layer" as const, sha256: f.sha256 })), { role: "candidate" as const, sha256: candidate.sha256 }],
    {
      cell: strip.cell,
      frames: strip.frames.map((f, i) => ({
        frameId: f.frameId,
        baseOrdinal: i,
        candidateOrdinal: frames.length,
        candidateRect: [f.at[0], f.at[1], strip.cell[0], strip.cell[1]],
        parts: plan.params.parts.map((p) => ({ partId: p, zones: zonesFor(plan, strip, f.frameId, p) })).filter((p) => p.zones.length > 0),
        protect: protectFor(plan, strip, f.frameId),
      })),
      tolerance: 24,
      alphaThreshold: 128,
      maxShift: 3,
      minComponentPx: 3,
      forbidColors: [plan.params.markColor, ...(plan.params.backgroundKey ? [plan.params.backgroundKey] : [])],
      forbidTolerance: 40,
    },
  );
  warnings.push(...extract.warnings);
  steps.push({ operation: "equipment_extract", frames: extract.report.frames });
  const extraBlobs: ProcessResult["extraBlobs"] = [];
  const blobByKey = new Map<string, string>();
  for (const o of extract.outputs) {
    const stored = await env.blobs.putBytes(o.bytes);
    extraBlobs.push({ blob: stored, width: o.width, height: o.height });
    blobByKey.set(`${o.role}|${o.key}`, stored.sha256);
  }
  const reportFrames = extract.report.frames as { frameId: string; shift: [number, number]; parts: { partId: string; empty: boolean; rect: [number, number, number, number] | null; offset: [number, number] | null; pixels: number }[] }[];
  const cells = reportFrames.flatMap((f) =>
    f.parts.map((p) => ({ frameId: f.frameId, partId: p.partId, empty: p.empty, rect: p.rect, offset: p.offset, pixels: p.pixels, sha256: p.empty ? null : (blobByKey.get(`layer|${f.frameId}|${p.partId}`) ?? null) })),
  );
  const processed: ProcessedPart = {
    normalizedSha256: candidate.sha256,
    width: out.width!,
    height: out.height!,
    ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}),
    receivedSize: ingest.report.size as [number, number],
    steps,
    warnings,
    details: {
      kind: "coverage",
      stripKey: strip.stripKey,
      clipRevisionId: strip.clipRevisionId,
      cells,
      previews: Object.fromEntries(strip.frames.map((f) => [f.frameId, blobByKey.get(`preview|${f.frameId}`) ?? null])),
      shifts: Object.fromEntries(reportFrames.map((f) => [f.frameId, f.shift])),
    },
  };
  return { processed, stored: candidate, extraBlobs };
}

async function processRigid(env: PipelineEnv, plan: EquipmentPlan, sha256: string, dir: string): Promise<ProcessResult> {
  if (plan.params.mode !== "rigid_view") throw new Error("inalcançável");
  const { out, ingest, steps, warnings } = await normalizeCandidate(env, sha256, dir, plan.params.size, plan.params.backgroundKey, { crop: true });
  const stored = await env.blobs.putFile(out.absolutePath);
  const processed: ProcessedPart = {
    normalizedSha256: stored.sha256,
    width: out.width!,
    height: out.height!,
    ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}),
    receivedSize: ingest.report.size as [number, number],
    steps,
    warnings: [...warnings, "Empunhaduras vêm do gabarito declarado: confira no editor se caem sobre o cabo"],
    details: { kind: "rigid", viewId: plan.params.viewId },
  };
  return { processed, stored };
}

/** Uma revisão candidata da peça com tudo o que as partes do job produziram (publica na última parte). */
function publishEquipment(ctx: HandlerContext, plan: EquipmentPlan, asset: AssetView, part: PartRow): string[] {
  if (part.part_key !== plan.parts.at(-1)!.partKey) return [];
  const params = plan.params;
  const base = params.overlayRevisionId ? loadOverlay(ctx.db, ctx.job.project_id, params.overlayRevisionId) : null;
  const payload: OverlayPayload = base
    ? structuredClone(base.payload)
    : { itemRevisionId: null, rigRevisionId: params.rigRevisionId, slots: params.slots, stances: params.stances, parts: [], rigidViews: [] };
  const files: PublishFile[] = base ? reuseFiles(ctx.db, base.revision, "equipment", "overlay", base.payload) : [];
  const report: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const allRows = plan.parts.flatMap((p) => partResults(ctx, p.partKey).map((row) => ({ partKey: p.partKey, row, processed: parseJson<ProcessedPart>(row.processed_json)! })));

  if (params.mode === "rigid_view") {
    const first = allRows[0];
    if (!first) throw new DomainFailure("validation_failed", "Resposta sem imagem da vista");
    const fileKey = `view-${params.viewId}`;
    const blob = mustBlob(ctx.db, first.processed.normalizedSha256);
    const { width = params.size[0], height = params.size[1] } = blob.metadata as { width?: number; height?: number };
    const view = { viewId: params.viewId, fileId: fileKey, rect: [0, 0, width, height] as [number, number, number, number], grips: params.grips, ...(params.mirrorAllowed ? { mirrorAllowed: true } : {}) };
    payload.rigidViews = [...payload.rigidViews.filter((v) => v.viewId !== params.viewId), view];
    files.splice(0, files.length, ...files.filter((f) => f.fileKey !== fileKey), { fileKey, role: "rigid_view", idx: 0, blob });
    report.push({ viewId: params.viewId, receivedSize: first.processed.receivedSize, steps: first.processed.steps ?? [] });
    warnings.push(...first.processed.warnings);
  } else {
    const clipPayloads = new Map<string, ClipPayload>();
    const clipOf = (id: string) => {
      if (!clipPayloads.has(id)) clipPayloads.set(id, getRevision(ctx.db, ctx.job.project_id, id).payload as ClipPayload);
      return clipPayloads.get(id)!;
    };
    const partEntry = (partId: string) => {
      let entry = payload.parts.find((p) => p.partId === partId);
      if (!entry) {
        entry = { partId, coverage: [] };
        payload.parts.push(entry);
      }
      return entry;
    };
    const setCell = (partId: string, cell: OverlayPayload["parts"][number]["coverage"][number]) => {
      const entry = partEntry(partId);
      entry.coverage = [...entry.coverage.filter((c) => !(c.clipRevisionId === cell.clipRevisionId && c.frameId === cell.frameId)), cell];
    };
    for (const { row, processed, partKey } of allRows) {
      const d = processed.details as { stripKey: string; clipRevisionId: string; cells: { frameId: string; partId: string; empty: boolean; rect: [number, number, number, number] | null; offset: [number, number] | null; sha256: string | null; pixels: number }[]; shifts: Record<string, [number, number]> };
      const clip = clipOf(d.clipRevisionId);
      const strip = params.strips.find((s) => s.stripKey === d.stripKey);
      for (const cell of d.cells) {
        const wanted = strip?.frames.find((f) => f.frameId === cell.frameId)?.parts;
        if (wanted && !wanted.includes(cell.partId)) continue; // célula já coberta: o frame veio por outra parte em lacuna
        if (cell.empty || !cell.sha256 || !cell.rect || !cell.offset) {
          warnings.push(`${d.stripKey}/${cell.frameId}/${cell.partId}: nada extraído dentro da zona; célula deixada como lacuna`);
          continue;
        }
        // O hash no nome evita colisão com arquivos herdados da revisão de origem.
        const fileKey = `cov-${d.stripKey}-${cell.frameId}-${cell.partId}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 110) + `-${cell.sha256.slice(0, 8)}`;
        files.push({ fileKey, role: "coverage", idx: files.length, blob: mustBlob(ctx.db, cell.sha256) });
        const frame = clip.frames.find((f) => f.frameId === cell.frameId)!;
        setCell(cell.partId, { clipRevisionId: d.clipRevisionId, frameId: cell.frameId, layer: { fileId: fileKey, rect: cell.rect, offset: cell.offset }, drawIndex: defaultDrawIndex(cell.partId, frame) });
      }
      const job = ctx.job.id.slice(-8);
      files.push({ fileKey: `candidate-${d.stripKey}-${job}-${row.idx}`.slice(0, 120), role: "candidate", idx: row.idx, blob: mustBlob(ctx.db, processed.normalizedSha256) });
      files.push({ fileKey: `raw-${d.stripKey}-${job}-${row.idx}`.slice(0, 120), role: "raw", idx: row.idx, blob: mustBlob(ctx.db, row.blob_sha256) });
      report.push({ partKey, stripKey: d.stripKey, clipRevisionId: d.clipRevisionId, cells: d.cells.map((c) => ({ frameId: c.frameId, partId: c.partId, pixels: c.pixels, empty: c.empty })), shifts: d.shifts, receivedSize: processed.receivedSize, steps: processed.steps ?? [] });
      warnings.push(...processed.warnings);
    }
    const extracted = allRows.flatMap(({ processed }) => (processed.details as { cells: { empty: boolean }[] }).cells).filter((c) => !c.empty).length;
    if (extracted === 0) {
      throw new DomainFailure("validation_failed", "O candidato não trouxe nada da peça dentro da zona autorizada em nenhum frame; nada foi publicado (as respostas brutas ficam guardadas no job)", { warnings });
    }
    // Poses equivalentes: a mesma arte (mesmo arquivo, retângulo e offset) vinculada ao frame novo.
    for (const r of params.reused) {
      const source = payload.parts.find((p) => p.partId === r.partId)?.coverage.find((c) => c.clipRevisionId === r.from.clipRevisionId && c.frameId === r.from.frameId);
      if (!source?.layer) continue;
      setCell(r.partId, { ...source, clipRevisionId: r.clipRevisionId, frameId: r.frameId });
    }
  }

  // Uma chave por arquivo (o mais novo prevalece) e índices únicos por papel.
  const unique = uniqueFiles(files);
  const revision = publishRevision(ctx.db, ctx.clock, {
    projectId: ctx.job.project_id,
    assetId: asset.id,
    origin: "generation",
    styleRevisionId: plan.styleRevisionId,
    jobAttemptId: ctx.attempt.id,
    ...(base ? { predecessorId: base.revisionId } : {}),
    payload,
    files: unique,
    ...(base ? { edges: [{ toRevisionId: base.revisionId, role: "source", ordinal: 0, runtime: false }] } : {}),
    technicalReport: {
      operation: "generate_overlay_coverage",
      mode: params.mode,
      strategy: params.mode === "coverage" ? params.strategy : "rigid_view",
      routeLabel: params.mode === "coverage" ? EQUIPMENT_ROUTE_LABELS.dressed_candidate : EQUIPMENT_ROUTE_LABELS.rigid_view,
      proofPose: params.mode === "coverage" ? params.proofPose : false,
      reused: params.mode === "coverage" ? params.reused : [],
      parts: report,
      warnings,
    },
  });
  return [revision.id];
}

export const equipmentPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "generate_overlay_coverage") throw new Error("inalcançável");
    if (asset.family !== "equipment" || asset.kind !== "overlay") throw new DomainFailure("validation_failed", `A peça publica num asset equipment/overlay; o alvo é ${asset.family}/${asset.kind}`);
    if (plan.params.overlayRevisionId && getRevision(db, projectId, plan.params.overlayRevisionId).assetId !== asset.id) {
      throw new DomainFailure("validation_failed", "A cobertura nova publica no asset da própria peça");
    }
  },
  loadInputs: (ctx, plan, _adapter, part) => loadEquipmentInputs(ctx, plan as EquipmentPlan, part),
  process: (env, plan, sha256, dir, part) => {
    const p = plan as EquipmentPlan;
    return p.params.mode === "coverage" ? processCoverage(env, p as CoveragePlan, sha256, dir, part) : processRigid(env, p, sha256, dir);
  },
  publish: (ctx, plan, asset, part) => publishEquipment(ctx, plan as EquipmentPlan, asset, part),
};
