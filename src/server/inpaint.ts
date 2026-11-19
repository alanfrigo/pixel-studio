import { pick, tx } from "@/i18n/locales";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type Capability, type GenerationPlan, Id, type StylePayload } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { colorName } from "@/domain/color-names";
import { validatePlanReferences } from "@/domain/plan/references";
import { getProject, getRevision, getStyleRevision, getUpload } from "./catalog/catalog";
import { catalogLookup } from "./catalog/plan-lookup";
import { DomainFailure } from "./errors";
import { getProfileRow } from "./providers/registry";
import { runPython } from "./python/bridge";
import { chooseKeyColor } from "./services";
import type { Studio } from "./studio";
import { newId } from "./util";

/**
 * Inpainting (05 §inpainting, cartão E1): reconstruir só a região marcada.
 *
 * - `native-mask`: o provedor recebe fonte + máscara (ex.: API com contrato OpenAI Images e máscara).
 * - `candidate-composite`: o provedor recebe a fonte e uma guia com a região pintada e
 *   devolve o canvas inteiro editado; localmente só os pixels marcados são copiados.
 *   É escolha explícita e identificada, nunca substituto silencioso do modo nativo.
 *
 * Nos dois modos, todo pixel protegido sai idêntico à fonte nos quatro bytes RGBA.
 */

export const InpaintPlanInput = z.strictObject({
  operation: z.literal("inpaint"),
  providerProfileId: Id,
  sourceRevisionId: Id,
  sourceFileKey: z.string().min(1).max(128),
  maskUploadId: Id,
  instruction: z.string().trim().min(1).max(1000),
  mode: z.enum(["native-mask", "candidate-composite"]),
  language: z.enum(["pt-BR", "en"]).optional(),
});
export type InpaintPlanInput = z.input<typeof InpaintPlanInput>;

export const INPAINT_MODE_LABEL = {
  "native-mask": tx("Inpainting com máscara nativa", "Inpainting with a native mask"),
  "candidate-composite": tx("Candidato editado + recorte local; sem condicionamento nativo por máscara", "Edited candidate + local crop; no native mask conditioning"),
} as const;

export interface MaskReport {
  size: [number, number];
  editedPixels: number;
  protectedPixels: number;
  emptyMask: boolean;
  fullMask: boolean;
  editRect: [number, number, number, number] | null;
}

/** Cor de marcação da guia: a mesma escolha da cor-chave, longe da paleta do estilo congelado. */
export function inpaintMarkColor(style: StylePayload): string {
  return chooseKeyColor(style.palette.colors.map((c) => c.hex));
}

/** Fator inteiro para o contexto enviado: lado maior perto de 1024 px, nunca acima de 2048. */
export function guideScale([w, h]: [number, number]): number {
  return Math.max(1, Math.min(Math.floor(1024 / Math.max(w, h)) || 1, Math.floor(2048 / Math.max(w, h)) || 1));
}

export function compileInpaintPrompt(o: {
  mode: "native-mask" | "candidate-composite";
  language: "pt-BR" | "en";
  instruction: string;
  markColor: string;
  fullMask: boolean;
  style: StylePayload;
}): string {
  const light = o.style.lighting.lightFrom;
  if (o.mode === "native-mask") {
    // O provedor já recebe a máscara: a descrição fala só do conteúdo da região.
    return o.language === "en"
      ? `${o.instruction}. Pixel art matching the rest of the image: same lighting from the ${light}, same outline and palette.`
      : `${o.instruction}. Pixel art coerente com o restante da imagem: mesma luz vinda de ${light}, mesmo contorno e paleta.`;
  }
  const mark = colorName(o.markColor, o.language);
  if (o.language === "en") {
    return [
      "Edit image 1, a pixel art image.",
      o.fullMask
        ? `Image 2 is fully painted ${mark}: redraw the whole image following this instruction: ${o.instruction}.`
        : `Image 2 is the same image with the region to change painted flat ${mark}. Change only that region: ${o.instruction}.`,
      "Everything outside that region must stay identical to image 1: same framing, same size, same pixel grid, same colors and lighting.",
      `Return the full edited image (not just the region), with no ${mark} left, no frame and no text.`,
    ].join(" ");
  }
  return [
    "Edite a imagem 1, uma imagem em pixel art.",
    o.fullMask
      ? `A imagem 2 está toda pintada de ${mark}: redesenhe a imagem inteira seguindo esta instrução: ${o.instruction}.`
      : `A imagem 2 é a mesma imagem com a região a mudar pintada de ${mark} chapado. Mude só essa região: ${o.instruction}.`,
    "Tudo fora dessa região deve ficar idêntico à imagem 1: mesmo enquadramento, mesmo tamanho, mesma grade de pixels, mesmas cores e luz.",
    `Devolva a imagem inteira editada (não só a região), sem sobrar ${mark}, sem moldura e sem texto.`,
  ].join(" ");
}

/** Valida a máscara contra a fonte no Python (binária, mesma grade) e conta a região, sem enviar nada. */
async function inspectMask(studio: Studio, source: { sha256: string }, mask: { sha256: string }): Promise<MaskReport> {
  const dir = path.join(studio.config.paths.staging, "plans", newId("insp"));
  try {
    await mkdir(path.join(dir, "in"), { recursive: true });
    await writeFile(path.join(dir, "in", "source"), await studio.blobs.read(source.sha256));
    await writeFile(path.join(dir, "in", "mask"), await studio.blobs.read(mask.sha256));
    const result = await runPython(
      {
        protocolVersion: 1,
        jobId: "plan",
        attemptId: "plan",
        operation: "inspect_mask",
        inputs: [
          { ordinal: 0, role: "source", sha256: source.sha256, relPath: "in/source" },
          { ordinal: 1, role: "editMask", sha256: mask.sha256, relPath: "in/mask" },
        ],
        recipe: { version: 1, maskConvention: "white_edits_black_preserves" },
      },
      { python: studio.config.python, workDir: dir, timeoutMs: studio.config.pythonTimeoutMs, signal: AbortSignal.timeout(studio.config.pythonTimeoutMs) },
    );
    if (result.status === "error") throw new DomainFailure("validation_failed", tx(`Máscara inválida: ${pick(result.message, "pt-BR")}`, `Invalid mask: ${pick(result.message, "en")}`), { code: result.code });
    return result.report as unknown as MaskReport;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function buildInpaintPlan(studio: Studio, projectId: string, raw: InpaintPlanInput) {
  const input = InpaintPlanInput.parse(raw);
  const project = getProject(studio.db, projectId);
  if (!project.activeStyleRevisionId) throw new DomainFailure("validation_failed", tx("Projeto sem estilo ativo", "Project has no active style"));
  const style = getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload;
  studio.providers.assertReady(input.providerProfileId);
  const adapter = studio.providers.adapterFor(input.providerProfileId);
  const required: Capability[] = input.mode === "native-mask" ? ["native_mask"] : ["image_edit"];
  const offered = adapter.capabilities("inpaint");
  if (!required.every((c) => offered.includes(c))) {
    throw new DomainFailure(
      "capability_missing",
      input.mode === "native-mask"
        ? tx(`O perfil ${input.providerProfileId} não recebe máscara nativa${offered.includes("image_edit") ? '; ele aceita o modo "candidato editado + recorte local", que é outro modo e precisa ser escolhido explicitamente' : ""}`, `Provider profile ${input.providerProfileId} does not take a native mask${offered.includes("image_edit") ? '; it accepts the "edited candidate + local crop" mode, which is a different mode and must be chosen explicitly' : ""}`)
        : tx(`O perfil ${input.providerProfileId} não edita a partir da imagem de origem (precisa aceitar a fonte e a guia como referências)`, `Provider profile ${input.providerProfileId} does not edit from the source image (it must accept the source and the guide as references)`),
      { missing: required.filter((c) => !offered.includes(c)), offered },
    );
  }

  const revision = getRevision(studio.db, projectId, input.sourceRevisionId);
  if (revision.status !== "approved") throw new DomainFailure("source_not_approved", tx(`A fonte r${revision.number} precisa estar aprovada antes do inpainting`, `Source r${revision.number} must be approved before inpainting`));
  const file = revision.files.find((f) => f.fileKey === input.sourceFileKey);
  const { width: w, height: h } = (file?.metadata ?? {}) as { width?: number; height?: number };
  if (!file || !file.mime.startsWith("image/") || !w || !h) throw new DomainFailure("not_found", tx(`A revisão não tem a imagem ${input.sourceFileKey}`, `The revision has no image ${input.sourceFileKey}`));
  const upload = getUpload(studio.db, projectId, input.maskUploadId);
  if (upload.status !== "ready" || upload.modality !== "raster") throw new DomainFailure("validation_failed", tx("A máscara precisa ser uma imagem já importada", "The mask must be an already imported image"));
  const mask = { sha256: upload.normalizedSha256 ?? upload.sha256 };

  const report = await inspectMask(studio, file, mask);
  if (report.emptyMask) {
    // Nada a reconstruir: zero envios e zero cobrança.
    throw new DomainFailure("validation_failed", tx("Máscara vazia: nenhuma região a editar. Nada foi enviado.", "Empty mask: no region to edit. Nothing was sent."), { emptyMask: true });
  }

  const language = input.language ?? (style.briefLanguage === "en" ? "en" : "pt-BR");
  const markColor = inpaintMarkColor(style);
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "inpaint",
    styleRevisionId: project.activeStyleRevisionId,
    recipeRevisionId: input.mode === "native-mask" ? "builtin-inpaint-native-v1" : "builtin-inpaint-candidate-v1",
    providerProfileId: input.providerProfileId,
    prompt: { brief: input.instruction, compiled: compileInpaintPrompt({ mode: input.mode, language, instruction: input.instruction, markColor, fullMask: report.fullMask, style }), language },
    sources: [
      { ordinal: 0, revisionId: revision.id, fileId: input.sourceFileKey, sha256: file.sha256, role: "source" },
      { ordinal: 1, revisionId: revision.id, fileId: upload.id, sha256: mask.sha256, role: "edit_mask" },
    ],
    requiredCapabilities: required,
    parts: [{ partKey: "image:inpaint", unit: "image", label: report.fullMask ? "Imagem inteira (máscara cheia)" : "Região editada" }],
    limits: { maxSubmissions: 1, costCeiling: null, estimate: adapter.estimate("inpaint", 1) },
    params: {
      sourceRevisionId: revision.id,
      sourceFileId: input.sourceFileKey,
      editMaskFileId: upload.id,
      maskConvention: "white_edits_black_preserves",
      logicalSize: [w, h],
      mode: input.mode,
      instruction: input.instruction,
    },
  };
  const issues = validatePlanReferences(plan, catalogLookup(studio.db));
  if (issues.length > 0) {
    throw new DomainFailure(issues[0]!.code === "cross_project_reference" ? "cross_project_reference" : "validation_failed", issues[0]!.message, { issues });
  }
  const profile = getProfileRow(studio.db, input.providerProfileId);
  return {
    plan,
    digest: canonicalDigest(plan),
    destination: { profileId: profile.id, name: profile.name, transport: profile.transport, simulated: profile.transport === "simulated" },
    mask: report,
    modeLabel: INPAINT_MODE_LABEL[input.mode],
    scope: report.fullMask
      ? tx("Máscara cheia: regeneração integral condicionada à fonte, sem pixels protegidos.", "Full mask: complete regeneration conditioned on the source, with no protected pixels.")
      : tx(`${report.editedPixels} pixel(s) editáveis; ${report.protectedPixels} protegido(s) saem idênticos à fonte.`, `${report.editedPixels} editable pixel(s); ${report.protectedPixels} protected pixel(s) come out identical to the source.`),
  };
}
