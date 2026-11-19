import { z } from "zod";
import {
  BasePayload,
  type Capability,
  ExpressionPayload,
  FontPayload,
  type GenerationPlan,
  HexColor,
  Id,
  type PlanSource,
  PortraitPayload,
  Slug,
  type StylePayload,
  VISEME_GRID,
  VISEME_IDS,
  VISEME_SET_ID,
} from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { coverageReport, FONT_TEST_STRINGS, type FontKit, glyphGeometry, PAGE_GRID, pageCodepoints, requiredCoverage, sortCodepoints } from "@/domain/dialogue/font";
import { validatePlanReferences } from "@/domain/plan/references";
import { type LocalizedText, tx } from "@/i18n/locales";
import { type AssetView, getAsset, getProject, getRevision, getStyleRevision, listAssets, listRevisions, type RevisionView } from "../catalog/catalog";
import { catalogLookup } from "../catalog/plan-lookup";
import { DomainFailure } from "../errors";
import { getProfileRow } from "../providers/registry";
import { chooseKeyColor } from "../services";
import type { Studio } from "../studio";
import { compileFontPrompt, compilePortraitPrompt, compileVisemesPrompt, DIALOGUE_ROUTE_LABELS, MOUTH_MARK } from "./core";
import { projectTexts } from "./texts";

/**
 * Planos do cartão D1 (`POST /generation-plans`): retrato ligado à revisão do
 * personagem, folha de bocas de UMA expressão (cada expressão é um job e uma
 * aprovação) e páginas de glyphs da fonte bitmap (base ou extensão dos
 * ausentes). Capacidade, fontes, limite de referências e custo são conferidos
 * antes de qualquer cobrança; a resposta diz a rota e o que ela NÃO faz.
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

const languageOf = (style: StylePayload, language?: "pt-BR" | "en") => language ?? (style.briefLanguage === "en" ? "en" : "pt-BR");

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

/** Sem a capacidade, bloqueia antes de cobrar e diz qual falta (nunca simula sucesso com prompt genérico). */
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

function requireReferences(adapter: ReturnType<Studio["providers"]["adapterFor"]>, operation: GenerationPlan["operation"], needed: number) {
  const max = adapter.limits?.(operation).maxReferences;
  if (max !== undefined && needed > max) {
    throw new DomainFailure("capability_missing", tx(`O perfil aceita até ${max} referência(s); esta operação envia ${needed}`, `The profile accepts up to ${max} reference(s); this operation sends ${needed}`), { maxReferences: max, needed });
  }
}

function approved(studio: Studio, projectId: string, revisionId: string, family: AssetView["family"], kinds: string[]): { revision: RevisionView; asset: AssetView } {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== family || !kinds.includes(asset.kind)) {
    throw new DomainFailure("validation_failed", tx(`${asset.name} r${revision.number} é ${asset.family}/${asset.kind}; esperado ${family}/${kinds.join("|")}`, `${asset.name} r${revision.number} is ${asset.family}/${asset.kind}; expected ${family}/${kinds.join("|")}`));
  }
  if (revision.status !== "approved") throw new DomainFailure("source_not_approved", tx(`${asset.name} r${revision.number} precisa estar aprovada`, `${asset.name} r${revision.number} must be approved`));
  return { revision, asset };
}

function fileSha(revision: RevisionView, fileKey: string): string {
  const file = revision.files.find((f) => f.fileKey === fileKey);
  if (!file) throw new DomainFailure("internal", tx(`Arquivo ${fileKey} sem vínculo na revisão`, `File ${fileKey} not linked in the revision`));
  return file.sha256;
}

/** Vista do personagem usada como identidade: frente (S) quando existe, senão a primeira. */
export function characterView(revision: RevisionView) {
  const base = BasePayload.parse(revision.payload);
  const view = base.views.find((v) => v.direction === "S") ?? base.views[0]!;
  return { view, sha256: fileSha(revision, view.fileId), logicalSize: base.logicalSize };
}

// ---------------------------------------------------------------------------
// Retrato
// ---------------------------------------------------------------------------

export const PortraitPlanInput = z.strictObject({
  operation: z.literal("generate_portrait"),
  providerProfileId: Id,
  characterRevisionId: Id,
  brief: z.string().trim().max(500).default(""),
  framing: z.enum(["bust", "head"]).default("bust"),
  logicalSize: z.tuple([z.number().int().min(24).max(160), z.number().int().min(24).max(160)]).default([64, 64]),
  variants: z.number().int().min(1).max(4).default(1),
  language: Language,
});
export type PortraitPlanInput = z.input<typeof PortraitPlanInput>;

export function buildPortraitPlan(studio: Studio, projectId: string, raw: PortraitPlanInput) {
  const input = PortraitPlanInput.parse(raw);
  const { styleRevisionId, style, adapter, profile } = context(studio, projectId, input.providerProfileId);
  const { revision: character, asset: characterAsset } = approved(studio, projectId, input.characterRevisionId, "character", ["base"]);
  const view = characterView(character);
  const offered = adapter.capabilities("generate_portrait");
  const alpha = offered.includes("alpha_output");
  const key = alpha ? null : chooseKeyColor(style.palette.colors.map((c) => c.hex));
  const required: Capability[] = ["text_to_image", "image_references", ...(alpha ? (["alpha_output"] as const) : [])];
  requireCaps(offered, required, input.providerProfileId, tx("gera retrato por imagem + referência do personagem", "generate a portrait by image + character reference"));
  requireReferences(adapter, "generate_portrait", 1);
  const language = languageOf(style, input.language);
  const parts = Array.from({ length: input.variants }, (_, i) => ({ partKey: `image:portrait-${i + 1}`, unit: "image" as const, label: `portrait ${i + 1}` }));
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_portrait",
    styleRevisionId,
    recipeRevisionId: "builtin-portrait-reference-v1",
    providerProfileId: input.providerProfileId,
    prompt: { brief: input.brief, compiled: compilePortraitPrompt({ language, brief: input.brief, framing: input.framing, size: input.logicalSize, style, backgroundKey: key, alpha }), language },
    sources: [{ ordinal: 0, revisionId: character.id, fileId: view.view.fileId, sha256: view.sha256, role: "identity" }],
    requiredCapabilities: required,
    parts,
    limits: { maxSubmissions: parts.length, costCeiling: null, estimate: adapter.estimate("generate_portrait", parts.length) },
    params: { characterRevisionId: character.id, logicalSize: input.logicalSize, route: "image_references", framing: input.framing, transparent: true, backgroundKey: key },
  };
  return finish(studio, plan, profile, {
    routeLabel: DIALOGUE_ROUTE_LABELS.portrait,
    character: { assetId: characterAsset.id, name: characterAsset.name, number: character.number, view: view.view.direction },
    transparency: alpha ? tx("alfa nativo da rota", "native alpha from the route") : tx("fundo de cor-chave removido localmente", "key-color background removed locally"),
    restrictions: [
      tx("Identidade, paleta e escala são conferidas localmente e revisadas pelo artista; a rota não garante identidade", "Identity, palette and scale are checked locally and reviewed by the artist; the route does not guarantee identity"),
      tx("Âncora facial e regiões do rosto/boca são sugeridas e precisam de revisão antes das expressões", "Face anchor and face/mouth regions are suggested and need review before expressions"),
    ],
  });
}

// ---------------------------------------------------------------------------
// Expressão (folha de bocas)
// ---------------------------------------------------------------------------

export const VisemesPlanInput = z.strictObject({
  operation: z.literal("generate_visemes"),
  providerProfileId: Id,
  portraitRevisionId: Id,
  expressionKey: Slug,
  expressionBrief: z.string().trim().max(500).default(""),
  language: Language,
});
export type VisemesPlanInput = z.input<typeof VisemesPlanInput>;

/** Asset de expressão já existente para o mesmo retrato e a mesma chave (uma nova geração vira nova candidata dele). */
export function findExpressionAsset(studio: Studio, projectId: string, portraitAssetId: string, expressionKey: string): AssetView | null {
  for (const asset of listAssets(studio.db, projectId, { family: "portrait" }).filter((a) => a.kind === "expression")) {
    const match = listRevisions(studio.db, projectId, asset.id).some((r) => {
      const p = r.payload as ExpressionPayload;
      if (p.expressionKey !== expressionKey) return false;
      try {
        return getRevision(studio.db, projectId, p.portraitRevisionId).assetId === portraitAssetId;
      } catch {
        return false;
      }
    });
    if (match) return asset;
  }
  return null;
}

export function buildVisemesPlan(studio: Studio, projectId: string, raw: VisemesPlanInput) {
  const input = VisemesPlanInput.parse(raw);
  const { styleRevisionId, style, adapter, profile } = context(studio, projectId, input.providerProfileId);
  const { revision: portraitRev, asset: portraitAsset } = approved(studio, projectId, input.portraitRevisionId, "portrait", ["portrait"]);
  const portrait = PortraitPayload.parse(portraitRev.payload);
  if (!portrait.faceRect || !portrait.mouthRect) {
    throw new DomainFailure("validation_failed", tx("Revise a âncora e as regiões do rosto e da boca do retrato antes de gerar expressões", "Review the portrait's face anchor and face/mouth regions before generating expressions"));
  }
  const offered = adapter.capabilities("generate_visemes");
  const alpha = offered.includes("alpha_output");
  const key = alpha ? null : chooseKeyColor([...style.palette.colors.map((c) => c.hex), MOUTH_MARK]);
  const required: Capability[] = ["text_to_image", "image_references", ...(alpha ? (["alpha_output"] as const) : [])];
  requireCaps(offered, required, input.providerProfileId, tx("desenha a folha de bocas por imagem + referência do retrato", "draw the mouth sheet by image + portrait reference"));
  requireReferences(adapter, "generate_visemes", 2);
  const language = languageOf(style, input.language);
  const visemeIds = [...VISEME_IDS];
  const cell = portrait.logicalSize;
  const sheet = { columns: VISEME_GRID.columns, rows: VISEME_GRID.rows, cell, backgroundKey: key, frameIds: visemeIds };
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_visemes",
    styleRevisionId,
    recipeRevisionId: "builtin-viseme-sheet-v1",
    providerProfileId: input.providerProfileId,
    prompt: {
      brief: input.expressionBrief,
      compiled: compileVisemesPrompt({ language, expressionKey: input.expressionKey, expressionBrief: input.expressionBrief, visemeIds, columns: sheet.columns, rows: sheet.rows, cell, backgroundKey: key }),
      language,
    },
    sources: [{ ordinal: 0, revisionId: portraitRev.id, fileId: portrait.fileId, sha256: fileSha(portraitRev, portrait.fileId), role: "identity" }],
    requiredCapabilities: required,
    parts: [{ partKey: `strip:visemes-${input.expressionKey}`, unit: "strip", label: `visemes · ${input.expressionKey}` }],
    limits: { maxSubmissions: 1, costCeiling: null, estimate: adapter.estimate("generate_visemes", 1) },
    params: {
      portraitRevisionId: portraitRev.id,
      expressionKey: input.expressionKey,
      visemeCount: visemeIds.length,
      visemeIds,
      visemeSet: VISEME_SET_ID,
      expressionBrief: input.expressionBrief,
      faceRect: portrait.faceRect,
      mouthRect: portrait.mouthRect,
      sheet,
    },
  };
  const existing = findExpressionAsset(studio, projectId, portraitAsset.id, input.expressionKey);
  return finish(studio, plan, profile, {
    routeLabel: DIALOGUE_ROUTE_LABELS.visemes,
    ...(existing ? { targetAssetId: existing.id } : {}),
    grid: { columns: sheet.columns, rows: sheet.rows, cell, visemeIds, visemeSet: VISEME_SET_ID },
    restrictions: [
      tx("Cada expressão é um job e uma aprovação próprios; mesma quantidade e ordem de visemes em todas", "Each expression is its own job and approval; same viseme count and order in all of them"),
      tx("Estabilidade do rosto medida localmente (fora da boca × repouso; fora do rosto × retrato) e informada como aviso", "Face stability measured locally (outside the mouth × rest; outside the face × portrait) and reported as warnings"),
      tx("Posições de boca não sintetizam voz nem sincronizam com áudio", "Mouth shapes do not synthesize voice nor sync with audio"),
    ],
  });
}

// ---------------------------------------------------------------------------
// Fonte bitmap (páginas de glyphs)
// ---------------------------------------------------------------------------

export const FontPlanInput = z.strictObject({
  operation: z.literal("generate_pixel_font"),
  providerProfileId: Id,
  brief: z.string().trim().max(500).default(""),
  weight: z.enum(["light", "regular", "bold"]).default("regular"),
  /** Altura das maiúsculas em pixels. */
  glyphSize: z.number().int().min(5).max(16).default(8),
  kit: z.enum(["basic", "basic_pt"]).default("basic_pt"),
  /** Texto extra cuja cobertura também é exigida (além dos textos do projeto). */
  extraText: z.string().max(4000).default(""),
  mode: z.enum(["base", "extend"]).default("base"),
  /** Extensão: revisão aprovada da fonte cujos glyphs servem de referência. */
  baseRevisionId: Id.optional(),
  inkColor: HexColor.default("#ffffff"),
  language: Language,
});
export type FontPlanInput = z.input<typeof FontPlanInput>;

/** Cobertura exigida pelo projeto (kit + textos de UI e falas + textos de teste do aceite + texto extra). */
export function projectRequirement(studio: Studio, projectId: string, kit: FontKit, extraText = "") {
  const sources = [...projectTexts(studio, projectId), { source: "test", text: FONT_TEST_STRINGS.join("\n") }, ...(extraText.trim() ? [{ source: "extra", text: extraText }] : [])];
  return requiredCoverage(kit, sources);
}

export function buildFontPlan(studio: Studio, projectId: string, raw: FontPlanInput) {
  const input = FontPlanInput.parse(raw);
  const { styleRevisionId, style, adapter, profile } = context(studio, projectId, input.providerProfileId);
  const required = projectRequirement(studio, projectId, input.kit, input.extraText);
  let capHeight = input.glyphSize;
  let codepoints = required.codepoints;
  let base: { revision: RevisionView; asset: AssetView; payload: FontPayload } | null = null;
  const sources: PlanSource[] = [];
  if (input.mode === "extend") {
    if (!input.baseRevisionId) throw new DomainFailure("validation_failed", tx("A extensão exige a revisão-base aprovada da fonte", "The extension needs the approved base revision of the font"));
    const found = approved(studio, projectId, input.baseRevisionId, "font", ["bitmap"]);
    base = { ...found, payload: FontPayload.parse(found.revision.payload) };
    capHeight = base.payload.nativeGlyphPx;
    codepoints = coverageReport(base.payload, required.codepoints).missing;
    if (!codepoints.length) throw new DomainFailure("validation_failed", tx("A fonte-base já cobre todos os glyphs exigidos: nada a estender", "The base font already covers every required glyph: nothing to extend"));
    // Páginas da base congeladas nas fontes: a referência dos glyphs aprovados sai delas, com hash conferido.
    const pages = [...new Set(base.payload.glyphs.map((g) => g.fileId))];
    pages.forEach((fileId, ordinal) => sources.push({ ordinal, revisionId: base!.revision.id, fileId, sha256: fileSha(base!.revision, fileId), role: "style" }));
  }
  const geometry = glyphGeometry(capHeight);
  const pages = pageCodepoints(codepoints);
  const offered = adapter.capabilities("generate_pixel_font");
  const requiredCaps: Capability[] = ["text_to_image", "image_references"];
  requireCaps(offered, requiredCaps, input.providerProfileId, tx("desenha glyphs pelo gabarito de grade", "draw glyphs from the grid template"));
  requireReferences(adapter, "generate_pixel_font", input.mode === "extend" ? 2 : 1);
  const language = languageOf(style, input.language);
  const key = chooseKeyColor([...style.palette.colors.map((c) => c.hex), input.inkColor]);
  const guide = {
    mode: input.mode,
    cell: geometry.cell,
    columns: PAGE_GRID.columns,
    rows: PAGE_GRID.rows,
    baselineY: geometry.baselineY,
    padLeft: geometry.padLeft,
    capHeight,
    tracking: 1,
    backgroundKey: key,
    inkColor: input.inkColor,
    pages,
    baseRevisionId: base?.revision.id ?? null,
  };
  const compiled = pages
    .map((page, i) => {
      const chars = page.codepoints.map((cp) => String.fromCodePoint(cp));
      const text = compileFontPrompt({ language, brief: input.brief, weight: input.weight, capHeight, columns: guide.columns, rows: guide.rows, cell: geometry.cell, chars, inkColor: input.inkColor, backgroundKey: key, extend: input.mode === "extend" });
      return pages.length > 1 ? `[${i + 1}/${pages.length}] ${text}` : text;
    })
    .join("\n\n");
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_pixel_font",
    styleRevisionId,
    recipeRevisionId: input.mode === "extend" ? "builtin-font-extend-v1" : "builtin-font-sheet-v1",
    providerProfileId: input.providerProfileId,
    prompt: { brief: input.brief, compiled, language },
    sources,
    requiredCapabilities: requiredCaps,
    parts: pages.map((page) => ({
      partKey: page.partKey,
      unit: "glyph_set" as const,
      label: `glyphs ${String.fromCodePoint(page.codepoints[0]!)}…${String.fromCodePoint(page.codepoints.at(-1)!)} (${page.codepoints.length})`,
    })),
    limits: { maxSubmissions: pages.length, costCeiling: null, estimate: adapter.estimate("generate_pixel_font", pages.length) },
    params: { weight: input.weight, glyphSize: capHeight, requiredCodepoints: sortCodepoints(codepoints), guide },
  };
  return finish(studio, plan, profile, {
    routeLabel: input.mode === "extend" ? DIALOGUE_ROUTE_LABELS.fontExtend : DIALOGUE_ROUTE_LABELS.font,
    ...(base ? { targetAssetId: base.asset.id } : {}),
    geometry,
    coverage: { required: required.codepoints.length, requested: codepoints.length, pages: pages.length, ...(base ? { missingInBase: codepoints.length } : {}) },
    restrictions: [
      tx("Glyph ausente na folha é listado e nunca substituído; a extensão desenha só os ausentes", "A glyph missing from the sheet is listed and never substituted; the extension draws only the missing ones"),
      tx("O atlas bitmap com métricas é a autoridade; nenhum TTF é gerado nem anunciado com esta cobertura", "The bitmap atlas with metrics is the authority; no TTF is generated or advertised with this coverage"),
    ],
  });
}

/** Registro no `POST /generation-plans` (ver `plan-builders.ts`). */
export const DIALOGUE_PLAN_BUILDERS = [
  { operation: "generate_portrait", input: PortraitPlanInput, build: (studio: Studio, projectId: string, body: never) => buildPortraitPlan(studio, projectId, body) },
  { operation: "generate_visemes", input: VisemesPlanInput, build: (studio: Studio, projectId: string, body: never) => buildVisemesPlan(studio, projectId, body) },
  { operation: "generate_pixel_font", input: FontPlanInput, build: (studio: Studio, projectId: string, body: never) => buildFontPlan(studio, projectId, body) },
] as const;
