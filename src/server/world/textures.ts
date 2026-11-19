import { z } from "zod";
import { type Capability, type GenerationPlan, Id, type PlanPart, type PlanSource, TexturePayload } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { validatePlanReferences } from "@/domain/plan/references";
import { type BlobRecord, getAsset, getBlob, getProject, getRevision, getStyleRevision, publishRevision, type RevisionView } from "../catalog/catalog";
import { catalogLookup } from "../catalog/plan-lookup";
import { DomainFailure } from "../errors";
import { getProfileRow } from "../providers/registry";
import { ImageRef, resolveLocalInput } from "../services";
import type { Studio } from "../studio";
import { compileTexturePrompt, DEFAULT_SEAM_THRESHOLD, type SeamReport, seamVerdict, texturePayloadFrom } from "./core";
import { dataUrl, outputOf, runWorldPython, storeOutput, type WorldRun } from "./python";

export { DEFAULT_SEAM_THRESHOLD } from "./core";

/**
 * Textura repetível própria (06 §repetição verificável, cartão T1). A
 * repetição resulta da geração de material + validação local da emenda:
 * diferença RGBA na junção de bordas opostas comparada à diferença interna,
 * com limiar declarado por material. Eixo reprovado não é marcado repetível;
 * repetir em um eixo não promete o outro.
 */

const Axes = z.strictObject({ x: z.boolean(), y: z.boolean() }).refine((a) => a.x || a.y, { message: "Escolha ao menos um eixo de repetição" });

/** Resolve a imagem (upload, arquivo de revisão ou saída local) para o blob, dentro do projeto. */
export function resolveImageRef(studio: Studio, projectId: string, ref: z.infer<typeof ImageRef>): BlobRecord & { width: number; height: number } {
  const sha =
    ref.from === "upload"
      ? resolveLocalInput(studio, projectId, { kind: "upload", uploadId: ref.uploadId })
      : ref.from === "revision"
        ? resolveLocalInput(studio, projectId, { kind: "revision", revisionId: ref.revisionId, fileKey: ref.fileKey })
        : resolveLocalInput(studio, projectId, { kind: "job_output", jobId: ref.jobId, outputIndex: ref.outputIndex });
  const blob = getBlob(studio.db, sha);
  const { width, height } = (blob?.metadata ?? {}) as { width?: number; height?: number };
  if (!blob || !width || !height) throw new DomainFailure("validation_failed", "Imagem sem dimensões medidas");
  return { ...blob, width, height };
}

export async function runTextureSeams(studio: Studio, sha256: string, axes: { x: boolean; y: boolean }, threshold: number): Promise<WorldRun & { report: SeamReport }> {
  const run = await runWorldPython(studio, "texture_seams", [{ role: "source", sha256 }], { axes, threshold, zoom: 4 });
  return run as WorldRun & { report: SeamReport };
}

// ---------------------------------------------------------------------------
// Verificação e publicação (importação ou correção local)
// ---------------------------------------------------------------------------

export const TextureCheckInput = z.strictObject({
  image: ImageRef,
  axes: Axes,
  threshold: z.number().positive().max(20).default(DEFAULT_SEAM_THRESHOLD),
});

/** Bancada de repetição: relatório + mosaico 1×, mosaico ampliado com linhas e deslocamento cíclico. */
export async function checkTexture(studio: Studio, projectId: string, raw: z.input<typeof TextureCheckInput>) {
  const input = TextureCheckInput.parse(raw);
  const image = resolveImageRef(studio, projectId, input.image);
  const run = await runTextureSeams(studio, image.sha256, input.axes, input.threshold);
  return {
    report: run.report,
    warnings: run.warnings,
    verdict: seamVerdict(run.report, input.axes),
    previews: {
      mosaic: dataUrl(outputOf(run, "mosaic")),
      mosaicLines: dataUrl(outputOf(run, "mosaic_lines")),
      shifted: dataUrl(outputOf(run, "shifted")),
    },
  };
}

export const PublishTextureInput = z.strictObject({
  image: ImageRef,
  material: z.string().trim().min(1).max(120),
  axes: Axes,
  threshold: z.number().positive().max(20).default(DEFAULT_SEAM_THRESHOLD),
  /** Revisão de origem quando a imagem é uma correção (ex.: inpainting da emenda deslocada). */
  sourceRevisionId: Id.optional(),
  /**
   * Bancada (06): desfaz o deslocamento cíclico de meio período antes de
   * validar — depois de corrigir por inpainting as emendas trazidas ao centro.
   */
  unshift: z.boolean().default(false),
});

export async function publishTexture(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof PublishTextureInput>): Promise<{ revision: RevisionView; report: SeamReport; verdict: string }> {
  const input = PublishTextureInput.parse(raw);
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "texture" || asset.kind !== "material") throw new DomainFailure("validation_failed", `O asset é ${asset.family}/${asset.kind}; esperado texture/material`);
  let image: BlobRecord = resolveImageRef(studio, projectId, input.image);
  if (input.unshift) {
    // Deslocar meio período de novo devolve a orientação original (tamanhos pares nos eixos pedidos).
    const back = await runTextureSeams(studio, image.sha256, input.axes, input.threshold);
    image = await storeOutput(studio, outputOf(back, "shifted"));
  }
  const run = await runTextureSeams(studio, image.sha256, input.axes, input.threshold);
  const previews = await Promise.all(["mosaic", "mosaic_lines", "shifted"].map((role) => storeOutput(studio, outputOf(run, role))));
  const payload = texturePayloadFrom(run.report, { fileId: "texture", material: input.material, axes: input.axes });
  const verdict = seamVerdict(run.report, input.axes);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: input.image.from === "upload" && !input.unshift ? "import" : "local_process",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload,
    files: [
      { fileKey: "texture", role: "texture", idx: 0, blob: image },
      ...previews.map((blob, idx) => ({ fileKey: ["mosaic", "mosaic-lines", "shifted"][idx]!, role: "preview", idx, blob })),
    ],
    ...(input.sourceRevisionId ? { edges: [{ toRevisionId: input.sourceRevisionId, role: "source", ordinal: 0, runtime: false }] } : {}),
    technicalReport: {
      operation: "texture_seams",
      label: input.unshift
        ? "Deslocamento cíclico desfeito após a correção; emenda validada localmente"
        : input.image.from === "upload"
          ? "Textura importada; emenda validada localmente"
          : "Textura derivada localmente; emenda validada",
      verdict,
      seams: run.report,
      warnings: run.warnings,
    },
  });
  return { revision, report: run.report, verdict };
}

// ---------------------------------------------------------------------------
// Plano de geração de material (generate_texture)
// ---------------------------------------------------------------------------

export const TexturePlanInput = z.strictObject({
  operation: z.literal("generate_texture"),
  providerProfileId: Id,
  materialBrief: z.string().trim().min(1).max(500),
  logicalSize: z.tuple([z.number().int().min(8).max(256), z.number().int().min(8).max(256)]),
  repeatAxes: Axes,
  seamThreshold: z.number().positive().max(20).optional(),
  /** Texturas aprovadas usadas como referência de material, em ordem. */
  referenceRevisionIds: z.array(Id).max(4).default([]),
  variants: z.number().int().min(1).max(4).default(1),
  language: z.enum(["pt-BR", "en"]).optional(),
});
export type TexturePlanInput = z.input<typeof TexturePlanInput>;

/** Arquivo de imagem principal de uma revisão aprovada de textura (fonte de material). */
export function textureSource(studio: Studio, projectId: string, revisionId: string): { revision: RevisionView; fileKey: string; sha256: string; size: [number, number] } {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "texture") throw new DomainFailure("validation_failed", `${asset.name} r${revision.number} não é uma textura`);
  if (revision.status !== "approved") throw new DomainFailure("source_not_approved", `${asset.name} r${revision.number} precisa estar aprovada`);
  const payload = TexturePayload.parse(revision.payload);
  const file = revision.files.find((f) => f.fileKey === payload.fileId);
  if (!file) throw new DomainFailure("not_found", `Arquivo ${payload.fileId} ausente na revisão`);
  return { revision, fileKey: payload.fileId, sha256: file.sha256, size: payload.logicalSize };
}

export function buildTexturePlan(studio: Studio, projectId: string, raw: TexturePlanInput) {
  const input = TexturePlanInput.parse(raw);
  const project = getProject(studio.db, projectId);
  if (!project.activeStyleRevisionId) throw new DomainFailure("validation_failed", "Projeto sem estilo ativo");
  const style = getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload;
  studio.providers.assertReady(input.providerProfileId);
  const adapter = studio.providers.adapterFor(input.providerProfileId);
  const sources: PlanSource[] = input.referenceRevisionIds.map((id, ordinal) => {
    const src = textureSource(studio, projectId, id);
    return { ordinal, revisionId: id, fileId: src.fileKey, sha256: src.sha256, role: "material" };
  });
  const required: Capability[] = ["text_to_image", ...(sources.length ? (["image_references"] as const) : [])];
  const offered = adapter.capabilities("generate_texture");
  const missing = required.filter((c) => !offered.includes(c));
  if (missing.length) {
    throw new DomainFailure("capability_missing", `O perfil ${input.providerProfileId} não gera material com ${missing.join(", ")}`, { missing, offered });
  }
  const maxRefs = adapter.limits?.("generate_texture").maxReferences;
  if (maxRefs !== undefined && sources.length > maxRefs) throw new DomainFailure("capability_missing", `O perfil aceita até ${maxRefs} referências`);
  const language = input.language ?? (style.briefLanguage === "en" ? "en" : "pt-BR");
  const parts: PlanPart[] = Array.from({ length: input.variants }, (_, i) => ({ partKey: `image:material-${i + 1}`, unit: "image", label: `Candidata ${i + 1}` }));
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_texture",
    styleRevisionId: project.activeStyleRevisionId,
    recipeRevisionId: "builtin-texture-material-v1",
    providerProfileId: input.providerProfileId,
    prompt: { brief: input.materialBrief, compiled: compileTexturePrompt({ language, brief: input.materialBrief, size: input.logicalSize, axes: input.repeatAxes, style, references: sources.length }), language },
    sources,
    requiredCapabilities: required,
    parts,
    limits: { maxSubmissions: parts.length, costCeiling: null, estimate: adapter.estimate("generate_texture", parts.length) },
    params: {
      materialBrief: input.materialBrief,
      logicalSize: input.logicalSize,
      repeatAxes: input.repeatAxes,
      seamThreshold: input.seamThreshold ?? DEFAULT_SEAM_THRESHOLD,
    },
  };
  const issues = validatePlanReferences(plan, catalogLookup(studio.db));
  if (issues.length > 0) throw new DomainFailure(issues[0]!.code === "cross_project_reference" ? "cross_project_reference" : "validation_failed", issues[0]!.message, { issues });
  const profile = getProfileRow(studio.db, input.providerProfileId);
  return {
    plan,
    digest: canonicalDigest(plan),
    destination: { profileId: profile.id, name: profile.name, transport: profile.transport, simulated: profile.transport === "simulated" },
    routeLabel: "Geração de material por modelo de imagem; a repetição é validada localmente depois (não há parâmetro nativo de emenda)",
  };
}
