import { readFile } from "node:fs/promises";
import path from "node:path";
import { type GenerationPlan, parseRevisionPayload } from "@/contracts";
import { entryRefs } from "@/domain/manifest/refs";
import { type AssetView, getRevision, getStyleRevision, publishRevision } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { guideScale, INPAINT_MODE_LABEL, inpaintMarkColor } from "../../../inpaint";
import type { ProviderAdapter } from "../../../providers/types";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, python, pythonWith } from "./shared";
import type { OperationPipeline } from "./types";

/** Inpainting (05 §inpainting): envio por modo, candidato na grade da fonte e proteção exata. */

type InpaintPlan = Extract<GenerationPlan, { operation: "inpaint" }>;

function inpaintSources(plan: InpaintPlan) {
  const source = plan.sources.find((s) => s.role === "source")!;
  const mask = plan.sources.find((s) => s.role === "edit_mask")!;
  return { source, mask };
}

/**
 * O que vai ao provedor. Nativo: fonte + máscara na codificação do adaptador
 * (a máscara local continua decidindo a proteção). Candidata: contexto ampliado
 * por fator inteiro + guia com a região pintada de cor chapada.
 */
async function loadInpaintInputs(ctx: HandlerContext, plan: InpaintPlan, adapter: ProviderAdapter) {
  const env = envOf(ctx);
  const { source, mask } = inpaintSources(plan);
  const dir = path.join(ctx.workDir, "inpaint-inputs");
  const read = async (absolutePath: string) => new Uint8Array(await readFile(absolutePath));
  if (plan.params.mode === "native-mask") {
    const encoding = adapter.maskEncoding ?? "white_edits_black_preserves";
    const encoded = await pythonWith(env, path.join(dir, "mask"), "encode_mask", [{ role: "editMask", sha256: mask.sha256 }], { version: 1, encoding });
    if (encoded.status === "error") throw new DomainFailure("validation_failed", `Máscara inválida: ${encoded.message}`, { code: encoded.code });
    return [
      { role: "source", mime: "image/png", bytes: await ctx.blobs.read(source.sha256) },
      { role: encoding === "alpha_zero_edits" ? "remote_mask" : "edit_mask", mime: "image/png", bytes: await read(encoded.outputs[0]!.absolutePath) },
    ];
  }
  const style = getStyleRevision(ctx.db, ctx.job.project_id, plan.styleRevisionId).payload;
  const guide = await pythonWith(
    env,
    path.join(dir, "guide"),
    "inpaint_guide",
    [
      { role: "source", sha256: source.sha256 },
      { role: "editMask", sha256: mask.sha256 },
    ],
    { version: 1, scale: guideScale(plan.params.logicalSize), markColor: inpaintMarkColor(style) },
  );
  if (guide.status === "error") throw new DomainFailure("validation_failed", `Falha ao preparar a guia: ${guide.message}`, { code: guide.code });
  const byRole = (role: string) => guide.outputs.find((o) => o.role === role)!;
  return [
    { role: "source", mime: "image/png", bytes: await read(byRole("context").absolutePath) },
    { role: "guide", mime: "image/png", bytes: await read(byRole("guide").absolutePath) },
  ];
}

/** Candidato → grade da fonte (só fator de escala, nunca esticar) → composição protegida. */
export async function processInpaintCandidate(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string) {
  if (plan.operation !== "inpaint") throw new Error("inalcançável");
  const [lw, lh] = plan.params.logicalSize;
  const { source, mask } = inpaintSources(plan);
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") throw new DomainFailure("validation_failed", `Resposta do provedor não é uma imagem utilizável: ${ingest.message}`, { code: ingest.code });
  let candidate = ingest.outputs.find((o) => o.role === "normalized")!;
  const steps: Record<string, unknown>[] = [];
  const warnings = [...ingest.warnings];
  if (candidate.width !== lw || candidate.height !== lh) {
    const current = await env.blobs.putFile(candidate.absolutePath);
    const fit = await python(env, path.join(dir, "fit"), "fit_logical", current.sha256, { version: 1, targetSize: [lw, lh], exactAspect: true });
    if (fit.status === "error") throw new DomainFailure("validation_failed", fit.message, { code: fit.code });
    candidate = fit.outputs.find((o) => o.role === "fitted")!;
    steps.push({ operation: "fit_logical", ...fit.report });
    warnings.push(...fit.warnings);
  }
  const candidateBlob = await env.blobs.putFile(candidate.absolutePath);
  const composite = await pythonWith(
    env,
    path.join(dir, "composite"),
    "composite_protected",
    [
      { role: "source", sha256: source.sha256 },
      { role: "candidate", sha256: candidateBlob.sha256 },
      { role: "editMask", sha256: mask.sha256 },
    ],
    { version: 1, maskConvention: "white_edits_black_preserves" },
  );
  if (composite.status === "error") throw new DomainFailure("validation_failed", composite.message, { code: composite.code });
  steps.push({ operation: "composite_protected", ...composite.report });
  warnings.push(...composite.warnings);
  const out = composite.outputs.find((o) => o.role === "protected")!;
  const stored = await env.blobs.putFile(out.absolutePath);
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
  };
  return { processed, stored, extraBlobs: [{ blob: candidateBlob, width: processed.width, height: processed.height }] };
}

/** Nova revisão do asset da fonte: mesma estrutura, o arquivo editado trocado, candidato e máscara guardados. */
function publishInpaint(ctx: HandlerContext, plan: InpaintPlan, asset: AssetView, part: PartRow): string[] {
  const base = getRevision(ctx.db, ctx.job.project_id, plan.params.sourceRevisionId);
  const parsed = parseRevisionPayload(asset.family, asset.kind, base.payload);
  if (!parsed.success) throw new DomainFailure("internal", "Payload da revisão-fonte não passa no schema");
  const referenced = new Set(entryRefs(parsed.entry).files.map((f) => f.fileId));
  const { mask } = inpaintSources(plan);
  return partResults(ctx, part.part_key).map((row) => {
    const processed = parseJson<ProcessedPart>(row.processed_json)!;
    const files = base.files
      .filter((f) => referenced.has(f.fileKey) || f.fileKey === plan.params.sourceFileId)
      .map((f) =>
        f.fileKey === plan.params.sourceFileId
          ? { fileKey: f.fileKey, role: "inpainted", idx: f.idx, blob: mustBlob(ctx.db, processed.normalizedSha256) }
          : { fileKey: f.fileKey, role: f.role, idx: f.idx, blob: mustBlob(ctx.db, f.sha256) },
      );
    files.push(
      { fileKey: "inpaint-candidate", role: "candidate", idx: 0, blob: mustBlob(ctx.db, processed.candidateSha256!) },
      { fileKey: "inpaint-mask", role: "mask", idx: 0, blob: mustBlob(ctx.db, mask.sha256) },
      { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
    );
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "edit",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      predecessorId: base.id,
      payload: base.payload,
      files,
      edges: [{ toRevisionId: base.id, role: "source", ordinal: 0, runtime: false }],
      technicalReport: {
        operation: "inpaint",
        mode: plan.params.mode,
        modeLabel: INPAINT_MODE_LABEL[plan.params.mode],
        instruction: plan.params.instruction,
        editedFile: plan.params.sourceFileId,
        maskUploadId: plan.params.editMaskFileId,
        remoteId: part.remote_id,
        requestedSize: plan.params.logicalSize,
        receivedSize: processed.receivedSize,
        composite: processed.composite,
        steps: processed.steps ?? [],
        warnings: processed.warnings,
      },
    });
    return revision.id;
  });
}

export const inpaintPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    if (plan.operation !== "inpaint") throw new Error("inalcançável");
    // O resultado é nova revisão do asset da própria fonte.
    if (getRevision(db, projectId, plan.params.sourceRevisionId).assetId !== asset.id) {
      throw new DomainFailure("validation_failed", "O inpainting publica no asset da própria fonte");
    }
  },
  loadInputs: (ctx, plan, adapter) => loadInpaintInputs(ctx, plan as InpaintPlan, adapter),
  process: processInpaintCandidate,
  publish: (ctx, plan, asset, part) => publishInpaint(ctx, plan as InpaintPlan, asset, part),
};
