import { tx } from "@/i18n/locales";
import { statfs } from "node:fs/promises";
import { z } from "zod";
import { AssetFamily, Capability, type GenerationPlan, Id, Insets, ITEM_KINDS, NonNegInt, parseRevisionPayload, PythonInputRole, PythonRequest, ReferenceRole, Size, TextKey, UiState } from "@/contracts";
import { colorName } from "@/domain/color-names";
import { entryRefs } from "@/domain/manifest/refs";
import { canonicalDigest } from "@/domain/canonical-json";
import { validatePlanReferences } from "@/domain/plan/references";
import {
  type BlobRecord,
  getAsset,
  getBlob,
  getProject,
  getRevision,
  getStyleRevision,
  getUpload,
  insertUpload,
  linkUploadJob,
  publishRevision,
  type UploadView,
} from "./catalog/catalog";
import { catalogLookup } from "./catalog/plan-lookup";
import { migrationStatus } from "./db/migrate";
import { DomainFailure } from "./errors";
import { JobRequests, LocalInputRef, LocalOperation } from "./jobs/context";
import { PIPELINES } from "./jobs/handlers/pipelines";
import type { LocalProcessResult } from "./jobs/handlers/local-process";
import { type JobRow, toJobView } from "./jobs/queue";
import { sniff } from "./media/inspect";
import { getProfileRow, listProfiles } from "./providers/registry";
import { pythonInfo, type PythonInfo } from "./python/bridge";
import type { Studio } from "./studio";
import { isoAfter, slugify } from "./util";

/** Casos de uso chamados pelas rotas; regras ficam aqui, não no handler HTTP. */

export function jobView(studio: Studio, job: JobRow) {
  return toJobView(job, studio.queue.parts(job.id));
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** Uploads não vinculados expiram após este prazo (coleta futura). */
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function ingestUpload(studio: Studio, projectId: string, file: { name: string; bytes: Uint8Array }) {
  getProject(studio.db, projectId);
  if (file.bytes.length === 0) throw new DomainFailure("validation_failed", tx("Arquivo vazio", "Empty file"));
  if (file.bytes.length > studio.config.maxUploadBytes) {
    throw new DomainFailure("validation_failed", tx(`Arquivo maior que o limite de ${studio.config.maxUploadBytes} bytes`, `File exceeds the ${studio.config.maxUploadBytes}-byte limit`));
  }
  const kind = sniff(file.bytes);
  if (!kind) {
    throw new DomainFailure("validation_failed", tx("Formato não reconhecido. Aceitos: PNG, JPEG, GIF, WebP, WAV, TTF, OTF e pacote ZIP exportado", "Unrecognized format. Accepted: PNG, JPEG, GIF, WebP, WAV, TTF, OTF and an exported ZIP package"));
  }
  const stored = await studio.blobs.putBytes(file.bytes);
  return studio.db.transaction(() => {
    const upload = insertUpload(studio.db, studio.clock, {
      projectId,
      originalName: file.name.slice(0, 200) || "sem-nome",
      blob: { sha256: stored.sha256, bytes: stored.bytes, mime: kind.mime, modality: kind.modality, metadata: { format: kind.format, mime: kind.mime } },
      expiresAt: isoAfter(studio.clock, UPLOAD_TTL_MS),
    });
    const { job } = studio.queue.enqueue({
      projectId,
      kind: "ingest",
      request: { uploadId: upload.id },
      idempotencyKey: `ingest:${upload.id}`,
      apply: (jobId) => linkUploadJob(studio.db, upload.id, jobId),
    });
    return { upload: { ...upload, ingestJobId: job.id } satisfies UploadView, job: jobView(studio, job) };
  });
}

// ---------------------------------------------------------------------------
// Planos de geração (versão mínima do F1: ícone por texto; I1/U1 ampliam)
// ---------------------------------------------------------------------------

export const PlanInput = z.strictObject({
  operation: z.literal("generate_asset"),
  providerProfileId: Id,
  brief: z.string().trim().min(1).max(2000),
  params: z.strictObject({
    family: z.literal("item"),
    kind: z.enum(ITEM_KINDS),
    logicalSize: Size,
    transparent: z.boolean(),
    variants: z.number().int().min(1).max(4),
  }),
  /** Idioma do texto enviado (o briefing do artista segue literal). Padrão: idioma do estilo. */
  language: z.enum(["pt-BR", "en"]).optional(),
  /** Referências opcionais e ordenadas: revisões aprovadas do projeto, com papel explícito. */
  references: z
    .array(z.strictObject({ revisionId: Id, fileKey: z.string().min(1).max(128), role: ReferenceRole, instruction: z.string().trim().max(300).optional() }))
    .max(16)
    .default([]),
});
export type PlanInput = z.input<typeof PlanInput>;

const KEY_NAMES: Record<string, { "pt-BR": string; en: string }> = {
  "#ff00ff": { "pt-BR": "magenta puro", en: "pure magenta" },
  "#00ffff": { "pt-BR": "ciano puro", en: "pure cyan" },
  "#00ff00": { "pt-BR": "verde-limão puro", en: "pure lime green" },
};

const ROLE_LABEL_EN: Record<string, string> = {
  identity: "identity (keep shape and features)",
  style: "style (lighting, outline, finish)",
  pose: "pose",
  material: "material",
  palette: "palette",
  equipment: "equipment",
  silhouette: "silhouette",
  composition: "composition",
};

/**
 * Receita de ícone/sprite de item (03 §2). Sem códigos hexadecimais: cores
 * vão por nome. O briefing do artista entra literal, no idioma em que foi escrito.
 */
export function compileIconPrompt(o: {
  language: "pt-BR" | "en";
  size: [number, number];
  brief: string;
  backgroundKey: string | null;
  transparent: boolean;
  references: { role: string; instruction?: string | undefined }[];
  outline: { widthPx: number; policy: string };
  lightFrom: string;
  detail: string;
  palette: string[];
  strictPalette: boolean;
}): string {
  const names = [...new Set(o.palette.map((hex) => colorName(hex, o.language)))].join(", ");
  const [w, h] = o.size;
  if (o.language === "en") {
    return [
      `Pixel art item sprite for a ${w}×${h} game icon: ${o.brief}. Single isolated object, centered, no frame, no inventory slot, no decorative border, no text.`,
      o.backgroundKey
        ? `Flat ${KEY_NAMES[o.backgroundKey]?.en ?? "solid"} background, completely uniform, no shadow, no gradient, no texture. The object is fully opaque: the background color never shows through it, glass is painted with its own colors.`
        : o.transparent
          ? "Transparent background."
          : "Plain solid background.",
      "True pixel art: crisp square pixels on a coarse grid, no anti-aliasing, no blur.",
      ...o.references.map((r, i) => `Image ${i + 1}: ${ROLE_LABEL_EN[r.role] ?? r.role}${r.instruction ? ` — ${r.instruction}` : ""}.`),
      `${o.outline.widthPx}px dark outline, light from the ${o.lightFrom}, ${o.detail} detail.`,
      `${o.strictPalette ? "Use only" : "Prefer"} these colors: ${names}.`,
    ].join(" ");
  }
  return [
    `Sprite de item em pixel art para um ícone de jogo de ${w}×${h}: ${o.brief}. Um único objeto isolado e centralizado, sem moldura, sem slot de inventário, sem borda decorativa e sem texto.`,
    o.backgroundKey
      ? `Fundo ${KEY_NAMES[o.backgroundKey]?.["pt-BR"] ?? "sólido"} chapado e totalmente uniforme, sem sombra, sem degradê e sem textura. O objeto é totalmente opaco: a cor do fundo nunca aparece através dele, e vidro é pintado com cores próprias.`
      : o.transparent
        ? "Fundo transparente."
        : "Fundo sólido liso.",
    "Pixel art de verdade: pixels quadrados e nítidos numa grade grossa, sem anti-aliasing nem desfoque.",
    ...o.references.map((r, i) => `Imagem ${i + 1}: ${ROLE_LABEL[r.role] ?? r.role}${r.instruction ? ` — ${r.instruction}` : ""}.`),
    `Contorno escuro de ${o.outline.widthPx} px, luz vinda de ${o.lightFrom}, densidade de detalhe ${o.detail}.`,
    `${o.strictPalette ? "Use apenas" : "Prefira"} estas cores: ${names}.`,
  ].join(" ");
}

/** Cor-chave longe de todas as cores da paleta (magenta, ciano ou verde-limão). */
export function chooseKeyColor(palette: string[]): string {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const candidates = ["#ff00ff", "#00ffff", "#00ff00"];
  const distance = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  return candidates
    .map((c) => ({ c, d: Math.min(...palette.map((p) => distance(rgb(c), rgb(p))), Infinity) }))
    .sort((a, b) => b.d - a.d)[0]!.c;
}

const ROLE_LABEL: Record<string, string> = {
  identity: "identidade (manter forma e traços)",
  style: "estilo (luz, contorno, acabamento)",
  pose: "pose",
  material: "material",
  palette: "paleta",
  equipment: "equipamento",
  silhouette: "silhueta",
  composition: "composição",
};

export function buildGenerationPlan(studio: Studio, projectId: string, rawInput: PlanInput) {
  const input = PlanInput.parse(rawInput);
  const project = getProject(studio.db, projectId);
  if (!project.activeStyleRevisionId) throw new DomainFailure("validation_failed", tx("Projeto sem estilo ativo", "Project has no active style"));
  const style = getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload;
  studio.providers.assertReady(input.providerProfileId);
  const adapter = studio.providers.adapterFor(input.providerProfileId);
  // Transparência pedida numa rota sem alfa: fundo de cor-chave + remoção local, em vez de bloquear.
  const alphaReferences = adapter.limits?.("generate_asset").alphaReferences;
  const nativeAlpha =
    adapter.capabilities("generate_asset").includes("alpha_output") && (alphaReferences === undefined || alphaReferences === input.references.length);
  const backgroundKey = input.params.transparent && !nativeAlpha ? chooseKeyColor(style.palette.colors.map((c) => c.hex)) : null;
  const required: Capability[] = [
    "text_to_image",
    ...(input.params.transparent && nativeAlpha ? (["alpha_output"] as const) : []),
    ...(input.references.length > 0 ? (["image_references"] as const) : []),
  ];
  // Limite real da rota explicado antes de cobrar (08 §verificação integrada · texto e referências).
  const maxReferences = adapter.limits?.("generate_asset").maxReferences;
  if (input.references.length > 0 && maxReferences !== undefined && input.references.length > maxReferences) {
    throw new DomainFailure("capability_missing", tx(`O perfil ${input.providerProfileId} aceita até ${maxReferences} referência(s); o pedido tem ${input.references.length}`, `Provider profile ${input.providerProfileId} accepts up to ${maxReferences} reference(s); the request has ${input.references.length}`), {
      maxReferences,
      requested: input.references.length,
    });
  }
  const sources = input.references.map((ref, ordinal) => {
    const revision = getRevision(studio.db, projectId, ref.revisionId);
    const file = revision.files.find((f) => f.fileKey === ref.fileKey);
    if (!file) throw new DomainFailure("not_found", tx(`Arquivo ${ref.fileKey} não existe na revisão ${ref.revisionId}`, `File ${ref.fileKey} does not exist in revision ${ref.revisionId}`));
    if (revision.status !== "approved") throw new DomainFailure("source_not_approved", tx(`Referência r${revision.number} ainda não foi aprovada`, `Reference r${revision.number} has not been approved yet`));
    return { ordinal, revisionId: revision.id, fileId: ref.fileKey, sha256: file.sha256, role: ref.role };
  });
  const missing = required.filter((c) => !adapter.capabilities("generate_asset").includes(c));
  if (missing.length > 0) {
    throw new DomainFailure("capability_missing", tx(`O perfil ${input.providerProfileId} não oferece: ${missing.join(", ")}`, `Provider profile ${input.providerProfileId} does not offer: ${missing.join(", ")}`), { missing });
  }
  const [w, h] = input.params.logicalSize;
  const submissions = Math.max(1, Math.min(input.params.variants, adapter.submissionsFor?.("generate_asset", input.params.variants) ?? input.params.variants));
  const language = input.language ?? (style.briefLanguage === "en" ? "en" : "pt-BR");
  const compiled = compileIconPrompt({
    language,
    size: [w, h],
    brief: input.brief,
    backgroundKey,
    transparent: input.params.transparent,
    references: input.references,
    outline: style.outline,
    lightFrom: style.lighting.lightFrom,
    detail: style.detailDensity,
    palette: style.palette.colors.map((c) => c.hex),
    strictPalette: style.palette.policy === "strict",
  });
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_asset",
    styleRevisionId: project.activeStyleRevisionId,
    recipeRevisionId: "builtin-item-icon-v1",
    providerProfileId: input.providerProfileId,
    prompt: { brief: input.brief, compiled, language },
    sources,
    requiredCapabilities: required,
    parts: Array.from({ length: submissions }, (_, i) => ({ partKey: `image:v${i + 1}`, unit: "image" as const, label: submissions === input.params.variants ? `Variante ${i + 1}` : `Envio ${i + 1}` })),
    limits: { maxSubmissions: submissions, costCeiling: null, estimate: adapter.estimate("generate_asset", submissions) },
    params: { family: "item", kind: input.params.kind, logicalSize: [w, h], transparent: input.params.transparent, variants: input.params.variants, backgroundKey },
  };
  const profile = getProfileRow(studio.db, input.providerProfileId);
  return {
    plan,
    digest: canonicalDigest(plan),
    destination: { profileId: profile.id, name: profile.name, transport: profile.transport, simulated: profile.transport === "simulated" },
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const LocalProcessInput = z.strictObject({
  operation: LocalOperation,
  inputs: z.array(z.strictObject({ role: PythonInputRole, ref: LocalInputRef })).min(1).max(32),
  recipe: z.record(z.string(), z.unknown()),
});

export const SubmitJobInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("generation"), request: JobRequests.generation }),
  z.strictObject({ kind: z.literal("ingest"), request: JobRequests.ingest }),
  z.strictObject({ kind: z.literal("local_process"), request: LocalProcessInput }),
]);

/** Resolve a origem de uma entrada local para o hash dos bytes, sempre dentro do projeto. */
export function resolveLocalInput(studio: Studio, projectId: string, ref: z.infer<typeof LocalInputRef>): string {
  switch (ref.kind) {
    case "upload": {
      const upload = getUpload(studio.db, projectId, ref.uploadId);
      if (upload.status !== "ready" || upload.modality !== "raster") {
        throw new DomainFailure("validation_failed", tx(`Upload ${upload.originalName} não é uma imagem pronta para processar`, `Upload ${upload.originalName} is not an image ready for processing`));
      }
      return upload.normalizedSha256 ?? upload.sha256;
    }
    case "revision": {
      const file = getRevision(studio.db, projectId, ref.revisionId).files.find((f) => f.fileKey === ref.fileKey);
      if (!file) throw new DomainFailure("not_found", tx(`Arquivo ${ref.fileKey} não existe na revisão`, `File ${ref.fileKey} does not exist in the revision`));
      if (file.mime !== "image/png") throw new DomainFailure("validation_failed", tx(`${ref.fileKey} não é PNG`, `${ref.fileKey} is not a PNG`));
      return file.sha256;
    }
    case "job_output":
      return jobOutput(studio, projectId, ref.jobId, ref.outputIndex).sha256;
  }
}

export function jobOutput(studio: Studio, projectId: string, jobId: string, index: number) {
  const job = studio.queue.getForProject(projectId, jobId);
  if (job.kind !== "local_process" || job.state !== "succeeded") {
    throw new DomainFailure("not_found", tx("Saída disponível apenas para processamento local concluído", "Output is only available for a completed local process"));
  }
  const result = JSON.parse(job.result_json!) as LocalProcessResult;
  const output = result.outputs[index];
  if (!output) throw new DomainFailure("not_found", tx(`Saída ${index} não existe neste job`, `Output ${index} does not exist in this job`));
  return { ...output, result };
}

export function submitJob(studio: Studio, projectId: string, input: z.infer<typeof SubmitJobInput>, idempotencyKey: string) {
  getProject(studio.db, projectId);
  if (input.kind === "generation") {
    const { plan, planDigest, targetAssetId } = input.request;
    if (plan.projectId !== projectId) throw new DomainFailure("cross_project_reference", tx("Plano pertence a outro projeto", "Plan belongs to another project"));
    if (canonicalDigest(plan) !== planDigest) {
      throw new DomainFailure("validation_failed", tx("O plano mudou desde a prévia; recalcule antes de enviar", "The plan changed since the preview; recalculate it before submitting"));
    }
    const issues = validatePlanReferences(plan, catalogLookup(studio.db));
    if (issues.length > 0) {
      const code = issues.some((i) => i.code === "cross_project_reference" || i.code === "not_found") ? "not_found" : "validation_failed";
      throw new DomainFailure(code, issues[0]!.message, { issues });
    }
    const asset = getAsset(studio.db, projectId, targetAssetId);
    const pipeline = PIPELINES[plan.operation];
    if (pipeline) {
      pipeline.validateTarget({ db: studio.db, projectId, plan, asset });
    } else if (plan.operation !== "generate_asset") {
      throw new DomainFailure("capability_missing", tx(`Envio de ${plan.operation} entra com o cartão responsável`, `Submitting ${plan.operation} comes with the card that owns it`));
    } else if (asset.family !== plan.params.family || asset.kind !== plan.params.kind) {
      throw new DomainFailure("validation_failed", tx(`O asset é ${asset.family}/${asset.kind}; o plano gera outro tipo`, `The asset is ${asset.family}/${asset.kind}; the plan generates a different type`));
    }
    // Falta de capacidade ou de credencial bloqueia antes de qualquer cobrança.
    studio.providers.assertReady(plan.providerProfileId);
    const adapter = studio.providers.adapterFor(plan.providerProfileId);
    const missing = plan.requiredCapabilities.filter((c) => !adapter.capabilities(plan.operation).includes(c));
    if (missing.length > 0) throw new DomainFailure("capability_missing", tx(`O perfil não oferece: ${missing.join(", ")}`, `The provider profile does not offer: ${missing.join(", ")}`), { missing });
  }
  let request: unknown = input.request;
  if (input.kind === "local_process") {
    const inputs = input.request.inputs.map((i) => ({ ...i, sha256: resolveLocalInput(studio, projectId, i.ref) }));
    // Valida a receita contra o contrato do processador antes de enfileirar.
    const check = PythonRequest.safeParse({
      protocolVersion: 1,
      jobId: "job_check",
      attemptId: "att_check",
      operation: input.request.operation,
      inputs: inputs.map((i, ordinal) => ({ ordinal, role: i.role, sha256: i.sha256, relPath: `in/${ordinal}.png` })),
      recipe: input.request.recipe,
    });
    if (!check.success) {
      throw new DomainFailure("validation_failed", tx("Receita inválida para a operação", "Invalid recipe for this operation"), {
        issues: check.error.issues.slice(0, 10).map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }
    request = { operation: input.request.operation, inputs, recipe: input.request.recipe };
  }
  const { job, created } = studio.queue.enqueue({ projectId, kind: input.kind, request, idempotencyKey });
  return { job: jobView(studio, job), created };
}

export const CreateAssetInput = z.strictObject({
  family: AssetFamily,
  kind: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
});

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------

let pythonCache: { at: number; info: PythonInfo } | null = null;

export async function health(studio: Studio) {
  const now = Date.now();
  if (!pythonCache || now - pythonCache.at > 30_000) pythonCache = { at: now, info: await pythonInfo(studio.config.python) };
  const workers = studio.db.all<{ worker_id: string; pid: number; last_seen_at: string; current_job_id: string | null }>(
    "SELECT worker_id, pid, last_seen_at, current_job_id FROM worker_heartbeats ORDER BY last_seen_at DESC",
  );
  const online = workers.filter((w) => now - Date.parse(w.last_seen_at) < 15_000);
  const fs = await statfs(studio.config.paths.dataDir);
  const migrations = migrationStatus(studio.db);
  return {
    ok: online.length > 0 && pythonCache.info.ok,
    sqlite: { version: studio.db.sqliteVersion(), schemaVersion: migrations.current, latest: migrations.latest },
    storage: { dataDir: studio.config.paths.dataDir, freeBytes: Number(fs.bavail) * Number(fs.bsize) },
    python: pythonCache.info,
    worker: { online: online.length > 0, workers: online },
    providers: listProfiles(studio.db),
  };
}

// ---------------------------------------------------------------------------
// Publicação de revisões a partir de upload ou de processamento local
// ---------------------------------------------------------------------------

/** Origem de uma imagem de componente de UI. */
export const ImageRef = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("upload"), uploadId: Id }),
  z.strictObject({ from: z.literal("revision"), revisionId: Id, fileKey: z.string().min(1).max(128) }),
  z.strictObject({ from: z.literal("job_output"), jobId: Id, outputIndex: NonNegInt }),
]);

const TextInput = z.strictObject({
  key: TextKey,
  sample: z.string().min(1).max(500),
  align: z.enum(["start", "center", "end"]).default("center"),
  verticalAlign: z.enum(["top", "middle", "bottom"]).default("middle"),
  wrap: z.enum(["none", "word"]).default("none"),
  overflow: z.enum(["grow", "paginate", "ellipsis", "report"]).default("grow"),
  fontRevisionId: Id.nullable().default(null),
});

const StretchInput = z.strictObject({ center: z.enum(["stretch", "tile"]), edges: z.enum(["stretch", "tile"]) }).default({ center: "stretch", edges: "stretch" });

export const UiComponentInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("button"),
    states: z.array(z.strictObject({ state: UiState, image: ImageRef })).min(1),
    requiredStates: z.array(UiState).min(1).default(["normal", "hover", "pressed", "disabled"]),
    focus: z.strictObject({ mode: z.enum(["overlay", "full_image"]), image: ImageRef }).nullable(),
    nineSlice: Insets.nullable(),
    contentPadding: Insets,
    stretch: StretchInput,
    text: TextInput.nullable(),
    accessibleName: z.string().max(120).nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal("panel"),
    image: ImageRef,
    nineSlice: Insets,
    contentPadding: Insets,
    stretch: StretchInput,
  }),
]);

export const PublishRevisionInput = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("upload"), uploadId: Id }),
  z.strictObject({ from: z.literal("ui_component"), component: UiComponentInput }),
  z.strictObject({ from: z.literal("job_output"), jobId: Id, outputIndex: NonNegInt, baseRevisionId: Id, fileKey: z.string().min(1).max(128) }),
]);

function blobOrFail(studio: Studio, sha256: string): BlobRecord {
  const blob = getBlob(studio.db, sha256);
  if (!blob) throw new DomainFailure("internal", tx(`Blob ${sha256} sem registro`, `Blob ${sha256} has no record`));
  return blob;
}

/** Resolve a imagem de um componente para o blob e suas dimensões, dentro do projeto. */
function resolveImage(studio: Studio, projectId: string, ref: z.infer<typeof ImageRef>): BlobRecord & { width: number; height: number } {
  const sha =
    ref.from === "upload"
      ? resolveLocalInput(studio, projectId, { kind: "upload", uploadId: ref.uploadId })
      : ref.from === "revision"
        ? resolveLocalInput(studio, projectId, { kind: "revision", revisionId: ref.revisionId, fileKey: ref.fileKey })
        : resolveLocalInput(studio, projectId, { kind: "job_output", jobId: ref.jobId, outputIndex: ref.outputIndex });
  const blob = blobOrFail(studio, sha);
  const { width, height } = blob.metadata as { width?: number; height?: number };
  if (!width || !height) throw new DomainFailure("validation_failed", tx("Imagem sem dimensões medidas", "Image has no measured dimensions"));
  return { ...blob, width, height };
}

/** Componente de UI (07): estados na mesma célula, guias de nine-slice e texto separado da arte. */
export function publishUiComponent(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof UiComponentInput>) {
  const input = UiComponentInput.parse(raw); // aplica os padrões (estados exigidos, alinhamento, esticamento)
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "ui" || asset.kind !== input.kind) {
    throw new DomainFailure("validation_failed", tx(`O asset é ${asset.family}/${asset.kind}; o componente é ui/${input.kind}`, `The asset is ${asset.family}/${asset.kind}; the component is ui/${input.kind}`));
  }
  const styleRevisionId = getProject(studio.db, projectId).activeStyleRevisionId;
  if (input.kind === "panel") {
    const image = resolveImage(studio, projectId, input.image);
    return publishRevision(studio.db, studio.clock, {
      projectId,
      assetId,
      origin: "composition",
      styleRevisionId,
      payload: {
        logicalSize: [image.width, image.height],
        image: { fileId: "panel", rect: [0, 0, image.width, image.height] },
        nineSlice: input.nineSlice,
        contentPadding: input.contentPadding,
        stretch: input.stretch,
        minSize: [input.nineSlice.left + input.nineSlice.right + 1, input.nineSlice.top + input.nineSlice.bottom + 1],
      },
      files: [{ fileKey: "panel", role: "state", idx: 0, blob: image }],
    });
  }
  const states = input.states.map((s) => ({ state: s.state, image: resolveImage(studio, projectId, s.image) }));
  const normal = states.find((s) => s.state === "normal");
  if (!normal) throw new DomainFailure("validation_failed", tx("Botão exige a imagem do estado normal", "A button requires the normal-state image"));
  const [w, h] = [normal.image.width, normal.image.height];
  const off = states.find((s) => s.image.width !== w || s.image.height !== h);
  if (off) throw new DomainFailure("validation_failed", tx(`Estado ${off.state} tem ${off.image.width}×${off.image.height}; todos os estados mantêm a célula ${w}×${h}`, `State ${off.state} is ${off.image.width}×${off.image.height}; every state keeps the ${w}×${h} cell`));
  const focus = input.focus ? resolveImage(studio, projectId, input.focus.image) : null;
  if (focus && (focus.width !== w || focus.height !== h)) throw new DomainFailure("validation_failed", tx(`Foco tem ${focus.width}×${focus.height}; esperado ${w}×${h}`, `Focus is ${focus.width}×${focus.height}; expected ${w}×${h}`));
  const present = new Set(states.map((s) => s.state));
  return publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: "composition",
    styleRevisionId,
    payload: {
      logicalSize: [w, h],
      states: states.map((s) => ({ state: s.state, fileId: `state-${s.state}`, rect: [0, 0, w, h] })),
      requiredStates: input.requiredStates,
      focus: focus && input.focus ? { mode: input.focus.mode, fileId: "focus", rect: [0, 0, w, h] } : null,
      nineSlice: input.nineSlice,
      contentPadding: input.contentPadding,
      stretch: input.stretch,
      interactiveRect: null,
      text: input.text,
      accessibleName: input.accessibleName,
      complete: input.requiredStates.every((s) => present.has(s)),
    },
    files: [
      ...states.map((s, idx) => ({ fileKey: `state-${s.state}`, role: "state", idx, blob: s.image })),
      ...(focus ? [{ fileKey: "focus", role: "focus", idx: 0, blob: focus }] : []),
    ],
  });
}

export function publishFromSource(studio: Studio, projectId: string, assetId: string, input: z.input<typeof PublishRevisionInput>) {
  if (input.from === "ui_component") return publishUiComponent(studio, projectId, assetId, input.component);
  const asset = getAsset(studio.db, projectId, assetId);
  if (input.from === "upload") {
    // Imagem importada vira candidata de ícone; outras famílias usam o editor próprio.
    if (asset.family !== "item") throw new DomainFailure("capability_missing", tx("Criar a partir de upload está disponível para itens; outras famílias usam seus editores", "Creating from an upload is available for items; other families use their own editors"));
    const upload = getUpload(studio.db, projectId, input.uploadId);
    if (upload.status !== "ready" || upload.modality !== "raster" || !upload.normalizedSha256) {
      throw new DomainFailure("validation_failed", tx("O upload precisa ser uma imagem já normalizada", "The upload must be an already normalized image"));
    }
    const normalized = blobOrFail(studio, upload.normalizedSha256);
    const { width, height } = normalized.metadata as { width: number; height: number };
    return publishRevision(studio.db, studio.clock, {
      projectId,
      assetId,
      origin: "import",
      styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
      payload: {
        itemKey: slugify(asset.name),
        representations: [
          { role: "icon", state: "default", fileId: "image", rect: [0, 0, width, height], sourceOffset: [0, 0], logicalSize: [width, height], pivot: [Math.floor(width / 2), Math.floor(height / 2)] },
        ],
      },
      files: [
        { fileKey: "image", role: "normalized", idx: 0, blob: normalized },
        { fileKey: "original", role: "original", idx: 0, blob: blobOrFail(studio, upload.sha256) },
      ],
      technicalReport: { fromUpload: upload.id, originalName: upload.originalName, ...(upload.metadata ?? {}) },
    });
  }

  // Derivado local: mesma estrutura da revisão-base, com um arquivo substituído na mesma grade.
  const base = getRevision(studio.db, projectId, input.baseRevisionId);
  if (base.assetId !== asset.id) throw new DomainFailure("validation_failed", tx("A revisão-base pertence a outro asset", "The base revision belongs to another asset"));
  const output = jobOutput(studio, projectId, input.jobId, input.outputIndex);
  const replaced = base.files.find((f) => f.fileKey === input.fileKey);
  if (!replaced) throw new DomainFailure("not_found", tx(`Arquivo ${input.fileKey} não existe na revisão-base`, `File ${input.fileKey} does not exist in the base revision`));
  const { width, height } = replaced.metadata as { width?: number; height?: number };
  if (width !== output.width || height !== output.height) {
    throw new DomainFailure(
      "validation_failed",
      tx(`A saída tem ${output.width}×${output.height} e o arquivo ${input.fileKey} tem ${width}×${height}; operações que mudam a grade são publicadas pelo editor da família`, `The output is ${output.width}×${output.height} and file ${input.fileKey} is ${width}×${height}; operations that change the grid are published by the family editor`),
    );
  }
  const parsed = parseRevisionPayload(asset.family, asset.kind, base.payload);
  if (!parsed.success) throw new DomainFailure("internal", tx("Payload da revisão-base não passa no schema", "Base revision payload does not pass the schema"));
  const referenced = new Set(entryRefs(parsed.entry).files.map((f) => f.fileId));
  const files = base.files
    .filter((f) => referenced.has(f.fileKey))
    .map((f) => ({
      fileKey: f.fileKey,
      role: f.fileKey === input.fileKey ? "processed" : f.role,
      idx: f.idx,
      blob: f.fileKey === input.fileKey ? blobOrFail(studio, output.sha256) : blobOrFail(studio, f.sha256),
    }));
  return publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: "local_process",
    styleRevisionId: base.styleRevisionId,
    predecessorId: base.id,
    payload: base.payload,
    files,
    edges: [{ toRevisionId: base.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: output.result.operation,
      cacheKey: output.result.cacheKey,
      jobId: input.jobId,
      replacedFile: input.fileKey,
      report: output.result.report,
      warnings: output.result.warnings,
    },
  });
}
