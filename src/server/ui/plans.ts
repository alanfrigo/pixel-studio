import { z } from "zod";
import { ButtonPayload, type Capability, type GenerationPlan, Id, type PlanSource, SlotPayload, type StylePayload, UiComponentType, UiState, type UiStateSheet } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { validatePlanReferences } from "@/domain/plan/references";
import { stateSheetLayout } from "@/domain/ui-geometry";
import { BASE_STATE, imageOfPayload, packTemplate } from "@/domain/ui-template";
import { type LocalizedText, tx } from "@/i18n/locales";
import { getAsset, getProject, getRevision, getStyleRevision, type RevisionView } from "../catalog/catalog";
import { catalogLookup } from "../catalog/plan-lookup";
import { DomainFailure } from "../errors";
import { getProfileRow } from "../providers/registry";
import { chooseKeyColor } from "../services";
import type { Studio } from "../studio";
import { compileStatesPrompt, compileTemplatePrompt, UI_ROUTE_LABELS } from "./core";

/**
 * Planos do cartão U3 (`POST /generation-plans`): capacidade, fontes, limites
 * e custo conferidos antes de qualquer cobrança. A resposta diz a rota usada e
 * o que ela NÃO faz (template achatado, estados por referência).
 */

const Language = z.enum(["pt-BR", "en"]).optional();

function context(studio: Studio, projectId: string, profileId: string) {
  const project = getProject(studio.db, projectId);
  if (!project.activeStyleRevisionId) throw new DomainFailure("validation_failed", tx("Projeto sem estilo ativo", "Project has no active style"));
  const style = getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload;
  studio.providers.assertReady(profileId);
  const adapter = studio.providers.adapterFor(profileId);
  const profile = getProfileRow(studio.db, profileId);
  return { styleRevisionId: project.activeStyleRevisionId, style, adapter, profile };
}

function languageOf(style: StylePayload, language?: "pt-BR" | "en") {
  return language ?? (style.briefLanguage === "en" ? "en" : "pt-BR");
}

function requireCaps(offered: Capability[], required: Capability[], profileId: string, what: LocalizedText) {
  const missing = required.filter((c) => !offered.includes(c));
  if (missing.length) {
    throw new DomainFailure(
      "capability_missing",
      tx(`O perfil ${profileId} não ${what["pt-BR"]}: falta ${missing.join(", ")}`, `Provider profile ${profileId} cannot ${what.en}: missing ${missing.join(", ")}`),
      { missing, offered },
    );
  }
}

function finish(studio: Studio, plan: GenerationPlan, profile: ReturnType<typeof getProfileRow>, extra: Record<string, unknown>) {
  const issues = validatePlanReferences(plan, catalogLookup(studio.db));
  if (issues.length > 0) throw new DomainFailure(issues[0]!.code === "cross_project_reference" ? "cross_project_reference" : "validation_failed", issues[0]!.message, { issues });
  return {
    plan,
    digest: canonicalDigest(plan),
    destination: { profileId: profile.id, name: profile.name, transport: profile.transport, simulated: profile.transport === "simulated" },
    ...extra,
  };
}

/** Imagem principal de uma revisão APROVADA do projeto (cena, item, componente...) usada como referência visual. */
export function referenceImage(studio: Studio, projectId: string, revisionId: string): { revision: RevisionView; fileKey: string; sha256: string } {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (revision.status !== "approved") {
    throw new DomainFailure("source_not_approved", tx(`${asset.name} r${revision.number} precisa estar aprovada`, `${asset.name} r${revision.number} must be approved`));
  }
  const region = imageOfPayload(asset.family, asset.kind, revision.payload);
  const file = region ? revision.files.find((f) => f.fileKey === region.fileId) : undefined;
  if (!file) {
    throw new DomainFailure("validation_failed", tx(`${asset.name} r${revision.number} (${asset.family}/${asset.kind}) não tem imagem de referência`, `${asset.name} r${revision.number} (${asset.family}/${asset.kind}) has no reference image`));
  }
  return { revision, fileKey: file.fileKey, sha256: file.sha256 };
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export const UiTemplatePlanInput = z.strictObject({
  operation: z.literal("generate_ui_template"),
  providerProfileId: Id,
  brief: z.string().trim().min(1).max(1000),
  components: z
    .array(
      z.strictObject({
        localId: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "ID local: minúsculas, dígitos, _ ou -"),
        componentType: UiComponentType,
        logicalSize: z.tuple([z.number().int().min(4).max(256), z.number().int().min(4).max(256)]),
        requiredStates: z.array(UiState).max(7).optional(),
      }),
    )
    .min(1)
    .max(12),
  /** Cena e item aprovados como referência de material e tom (ordem significativa). */
  referenceRevisionIds: z.array(Id).max(4).default([]),
  language: Language,
});
export type UiTemplatePlanInput = z.input<typeof UiTemplatePlanInput>;

export function buildUiTemplatePlan(studio: Studio, projectId: string, raw: UiTemplatePlanInput) {
  const input = UiTemplatePlanInput.parse(raw);
  const ids = input.components.map((c) => c.localId);
  if (new Set(ids).size !== ids.length) throw new DomainFailure("validation_failed", tx("IDs locais repetidos no kit", "Repeated local IDs in the kit"));
  const { styleRevisionId, style, adapter, profile } = context(studio, projectId, input.providerProfileId);
  const offered = adapter.capabilities("generate_ui_template");
  const required: Capability[] = ["text_to_image", "image_references"];
  requireCaps(offered, required, input.providerProfileId, tx("aceita a guia raster do template (imagem + referências)", "accept the template raster guide (image + references)"));
  const sources: PlanSource[] = input.referenceRevisionIds.map((id, ordinal) => {
    const ref = referenceImage(studio, projectId, id);
    return { ordinal, revisionId: id, fileId: ref.fileKey, sha256: ref.sha256, role: "style" };
  });
  const maxRefs = adapter.limits?.("generate_ui_template").maxReferences;
  if (maxRefs !== undefined && sources.length + 1 > maxRefs) {
    throw new DomainFailure("capability_missing", tx(`A guia + ${sources.length} referência(s) excede o limite de ${maxRefs} do perfil`, `The guide + ${sources.length} reference(s) exceeds the profile limit of ${maxRefs}`), { maxReferences: maxRefs });
  }
  const { logicalSize, cells } = packTemplate(input.components);
  const backgroundKey = chooseKeyColor(style.palette.colors.map((c) => c.hex));
  const language = languageOf(style, input.language);
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_ui_template",
    styleRevisionId,
    recipeRevisionId: "builtin-ui-template-guide-v1",
    providerProfileId: input.providerProfileId,
    prompt: { brief: input.brief, compiled: compileTemplatePrompt({ language, brief: input.brief, cells, style, backgroundKey, references: sources.length }), language },
    sources,
    requiredCapabilities: required,
    parts: [{ partKey: "image:template", unit: "image", label: `Template ${logicalSize[0]}×${logicalSize[1]}` }],
    limits: { maxSubmissions: 1, costCeiling: null, estimate: adapter.estimate("generate_ui_template", 1) },
    params: {
      logicalSize,
      requestedComponents: cells.map((c) => ({
        localId: c.localId,
        componentId: c.componentId,
        componentType: c.componentType,
        logicalSize: [c.cell[2], c.cell[3]],
        requiredStates: c.requiredStates,
        cell: c.cell,
        ...(c.meterPart ? { meterPart: c.meterPart } : {}),
      })),
      guide: { backgroundKey },
    },
  };
  return finish(studio, plan, profile, {
    routeLabel: UI_ROUTE_LABELS.template,
    layout: { logicalSize, cells },
    restrictions: [
      tx("A imagem volta achatada: revise a proposta de separação e recorte cada peça antes de usá-la como componente", "The image comes back flat: review the split proposal and crop each piece before using it as a component"),
      tx("A barra é pedida como trilho, preenchimento e moldura separados; a moldura precisa deixar o miolo vazio", "The bar is requested as separate track, fill and frame; the frame must keep its middle empty"),
      tx("Estados (hover, pressed, disabled, selected) vêm depois, por imagem + referência do componente aprovado ou transformação local", "States (hover, pressed, disabled, selected) come later, by image + reference of the approved component or a local transformation"),
    ],
  });
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

export const UiStatesPlanInput = z.strictObject({
  operation: z.literal("generate_ui_states"),
  providerProfileId: Id,
  componentRevisionIds: z.array(Id).min(1).max(8),
  /** Estados pedidos; ausente = estados obrigatórios que ainda faltam em cada componente. */
  states: z.array(UiState).min(1).max(7).optional(),
  descriptions: z.array(z.strictObject({ state: UiState, description: z.string().trim().min(1).max(300) })).max(7).default([]),
  language: Language,
});
export type UiStatesPlanInput = z.input<typeof UiStatesPlanInput>;

/** Componente aprovado com estados (botão ou slot), seu estado-base e o arquivo dele. */
export function stateful(studio: Studio, projectId: string, revisionId: string) {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "ui" || (asset.kind !== "button" && asset.kind !== "slot")) {
    throw new DomainFailure("validation_failed", tx(`${asset.name} é ${asset.family}/${asset.kind}; estados valem para botões e slots`, `${asset.name} is ${asset.family}/${asset.kind}; states apply to buttons and slots`));
  }
  const payload = asset.kind === "button" ? ButtonPayload.parse(revision.payload) : SlotPayload.parse(revision.payload);
  const baseState = BASE_STATE[asset.kind]!;
  const base = payload.states.find((s) => s.state === baseState);
  if (!base) throw new DomainFailure("validation_failed", tx(`${asset.name} r${revision.number} não tem o estado-base ${baseState}`, `${asset.name} r${revision.number} has no ${baseState} base state`));
  const file = revision.files.find((f) => f.fileKey === base.fileId)!;
  return { revision, asset, payload, baseState, base, file, contentPadding: "contentPadding" in payload ? payload.contentPadding : null };
}

export function buildUiStatesPlan(studio: Studio, projectId: string, raw: UiStatesPlanInput) {
  const input = UiStatesPlanInput.parse(raw);
  const { styleRevisionId, style, adapter, profile } = context(studio, projectId, input.providerProfileId);
  const offered = adapter.capabilities("generate_ui_states");
  const required: Capability[] = ["text_to_image", "image_references"];
  requireCaps(offered, required, input.providerProfileId, tx("aceita o componente aprovado como referência (imagem + referências)", "accept the approved component as reference (image + references)"));
  const backgroundKey = chooseKeyColor(style.palette.colors.map((c) => c.hex));
  const sources: PlanSource[] = [];
  const sheets: UiStateSheet[] = [];
  const parts: GenerationPlan["parts"] = [];
  const baseStates: UiState[] = [];
  input.componentRevisionIds.forEach((id, i) => {
    const c = stateful(studio, projectId, id);
    if (c.revision.status !== "approved") {
      throw new DomainFailure("source_not_approved", tx(`Aprove ${c.asset.name} r${c.revision.number} antes de gerar estados`, `Approve ${c.asset.name} r${c.revision.number} before generating states`));
    }
    const present = new Set(c.payload.states.map((s) => s.state));
    const wanted = (input.states ?? c.payload.requiredStates.filter((s) => !present.has(s))).filter((s) => s !== c.baseState);
    if (wanted.length === 0) {
      throw new DomainFailure("validation_failed", tx(`${c.asset.name}: nenhum estado a gerar (todos os obrigatórios já existem)`, `${c.asset.name}: no state to generate (all required states exist)`));
    }
    if (c.base.rect[0] !== 0 || c.base.rect[1] !== 0) {
      // A referência enviada é o arquivo do estado-base; atlas compartilhado exige recorte antes.
      throw new DomainFailure("validation_failed", tx(`${c.asset.name}: o estado-base está num atlas; publique os estados em arquivos próprios antes`, `${c.asset.name}: the base state lives in an atlas; publish the states as separate files first`));
    }
    const layout = stateSheetLayout(c.payload.logicalSize, wanted.length + 1);
    sources.push({ ordinal: sources.length, revisionId: id, fileId: c.file.fileKey, sha256: c.file.sha256, role: "identity" });
    sheets.push({
      componentRevisionId: id,
      baseState: c.baseState,
      cell: c.payload.logicalSize,
      columns: layout.columns,
      rows: layout.rows,
      gapPx: layout.gapPx,
      states: wanted,
      sheetSize: layout.sheetSize,
      contentPadding: c.contentPadding,
    });
    baseStates.push(c.baseState);
    parts.push({ partKey: `component:${i}`, unit: "component", label: `${c.asset.name} · ${wanted.join("/")}`.slice(0, 120) });
  });
  const requiredStates = [...new Set(sheets.flatMap((s) => s.states))];
  const language = languageOf(style, input.language);
  const descriptions = new Map(input.descriptions.map((d) => [d.state, d.description]));
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_ui_states",
    styleRevisionId,
    recipeRevisionId: "builtin-ui-states-sheet-v1",
    providerProfileId: input.providerProfileId,
    prompt: {
      brief: requiredStates.map((s) => `${s}: ${descriptions.get(s) ?? ""}`.trim()).join("; "),
      compiled: compileStatesPrompt({ language, baseStates, states: requiredStates.map((s) => ({ state: s, description: descriptions.get(s) ?? null })), backgroundKey }),
      language,
    },
    sources,
    requiredCapabilities: required,
    parts,
    limits: { maxSubmissions: parts.length, costCeiling: null, estimate: adapter.estimate("generate_ui_states", parts.length) },
    params: {
      componentRevisionIds: input.componentRevisionIds,
      requiredStates,
      stateDescriptions: requiredStates.filter((s) => descriptions.has(s)).map((s) => ({ state: s, description: descriptions.get(s)! })),
      sheets,
      backgroundKey,
    },
  };
  const first = getRevision(studio.db, projectId, input.componentRevisionIds[0]!);
  return finish(studio, plan, profile, {
    routeLabel: UI_ROUTE_LABELS.states,
    targetAssetId: first.assetId,
    sheets: sheets.map((s) => ({ componentRevisionId: s.componentRevisionId, states: s.states, sheetSize: s.sheetSize })),
    restrictions: [
      tx("Cada estado é conferido contra o estado-base (célula, contorno, miolo e padding); só translação inteira é corrigida", "Each state is checked against the base state (cell, outline, center and padding); only integer translation is corrected"),
      tx("Estado ausente ou fora da célula não entra: o componente fica incompleto até ser refeito ou feito localmente", "A missing or off-cell state is left out: the component stays incomplete until it is redone or made locally"),
    ],
  });
}

/** Registro no `POST /generation-plans` (ver `plan-builders.ts`). */
export const UI_PLAN_BUILDERS = [
  { operation: "generate_ui_template", input: UiTemplatePlanInput, build: (studio: Studio, projectId: string, body: never) => buildUiTemplatePlan(studio, projectId, body) },
  { operation: "generate_ui_states", input: UiStatesPlanInput, build: (studio: Studio, projectId: string, body: never) => buildUiStatesPlan(studio, projectId, body) },
] as const;

