import { z } from "zod";
import {
  CostAmount,
  type CostEstimate,
  Direction,
  DurationMs,
  GenerationPlan,
  Id,
  Playback,
  PosInt,
  ProjectionKind,
  type ReferenceSheet,
  Slug,
  type StylePayload,
} from "@/contracts";
import { closestView, DIRECTION_LABEL } from "@/domain/animation/directions";
import { type ActionPreset, findPreset, fitsTextV3, presetRevisionId } from "@/domain/animation/presets";
import { sheetLayout } from "@/domain/animation/timeline";
import { canonicalDigest } from "@/domain/canonical-json";
import { validatePlanReferences } from "@/domain/plan/references";
import { isoWorldToView } from "@/domain/projection";
import { getProject, getStyleRevision } from "../catalog/catalog";
import { catalogLookup } from "../catalog/plan-lookup";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { pixelLabRotateBody, pixelLabSkeletonBody, pixelLabTextAnimationBody } from "../providers/mappings";
import { getProfileRow } from "../providers/registry";
import type { ProviderAdapter } from "../providers/types";
import { chooseKeyColor } from "../services";
import type { Studio } from "../studio";
import { type AnimationRoute, chooseRoute, type LoadedBase, loadBase, loadMotion, textActionKey, textFrameIds, viewFile } from "./base";
import { compileSheetAnimationPrompt, compileSheetViewPrompt } from "./prompts";

/**
 * Construtores de plano do cartão S1, um por modo e um para vistas:
 *
 * - `animate_preset` (um clique): preset versionado → plano congelado, sem prompt novo;
 * - `animate_text` (texto livre);
 * - `animate_skeleton` (poses aprovadas enviadas como dados onde o perfil aceita;
 *   em rota genérica, guia de poses raster identificada como tal);
 * - `rotate_views` (uma vista nova por plano: arte nova, nunca espelho nem bitmap girado).
 *
 * Cada plano tem uma direção: reprovar uma direção não invalida as outras nem
 * dispara lote completo. Tudo que pode bloquear acontece aqui, antes de cobrar.
 */

const Language = z.enum(["pt-BR", "en"]);
const common = {
  providerProfileId: Id,
  baseRevisionId: Id,
  language: Language.optional(),
  /** Teto autorizado para este envio; estimativa conhecida acima dele bloqueia. */
  costCeiling: CostAmount.nullable().optional(),
};

export const AnimatePresetPlanInput = z.strictObject({
  operation: z.literal("animate_preset"),
  ...common,
  direction: Direction,
  presetKey: Slug,
  presetVersion: PosInt.optional(),
  /** Retime configurado antes de gerar (mesma contagem do preset). */
  durationsMs: z.array(DurationMs).min(1).max(16).optional(),
  /** Preset de esqueleto: movimento aprovado explícito; sem ele, o aprovado para (base, ação, direção). */
  motionRevisionId: Id.optional(),
});

export const AnimateTextPlanInput = z.strictObject({
  operation: z.literal("animate_text"),
  ...common,
  direction: Direction,
  actionText: z.string().trim().min(1).max(1000),
  durationsMs: z.array(DurationMs).min(1).max(16),
  playback: Playback,
});

export const AnimateSkeletonPlanInput = z.strictObject({
  operation: z.literal("animate_skeleton"),
  ...common,
  motionRevisionId: Id,
  actionText: z.string().trim().min(1).max(1000),
  /** Aparência (substantivo), não pose: `description` do esqueleto v3. */
  appearance: z.string().trim().min(1).max(300).optional(),
  playback: Playback,
});

export const RotateViewsPlanInput = z.strictObject({
  operation: z.literal("rotate_views"),
  ...common,
  view: Direction,
  asymmetries: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  projection: ProjectionKind.optional(),
});

export type AnimatePresetPlanInput = z.input<typeof AnimatePresetPlanInput>;
export type AnimateTextPlanInput = z.input<typeof AnimateTextPlanInput>;
export type AnimateSkeletonPlanInput = z.input<typeof AnimateSkeletonPlanInput>;
export type RotateViewsPlanInput = z.input<typeof RotateViewsPlanInput>;

export interface AnimationPlanResult {
  plan: GenerationPlan;
  digest: string;
  destination: { profileId: string; name: string; transport: string; simulated: boolean };
  route: { strategy: AnimationRoute["strategy"]; label: string };
  summary: { direction: Direction; action: string; frameIds: string[]; durationsMs: number[]; playback: string } | { view: Direction; sourceView: Direction; projection: string };
  /** Atalho de um clique: o plano é enviável sem formulário? (custo conhecido dentro do teto ou desconhecido autorizado). */
  costCheck: { kind: CostEstimate["kind"]; withinCeiling: boolean | null };
}

interface Env {
  studio: Studio;
  projectId: string;
  styleRevisionId: string;
  style: StylePayload;
  adapter: ProviderAdapter;
  transport: string;
  language: "pt-BR" | "en";
  profileId: string;
}

function env(studio: Studio, projectId: string, profileId: string, language?: "pt-BR" | "en"): Env {
  const project = getProject(studio.db, projectId);
  if (!project.activeStyleRevisionId) throw new DomainFailure("validation_failed", "Projeto sem estilo ativo");
  const style = getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload;
  studio.providers.assertReady(profileId);
  const adapter = studio.providers.adapterFor(profileId);
  const transport = getProfileRow(studio.db, profileId).transport;
  return { studio, projectId, styleRevisionId: project.activeStyleRevisionId, style, adapter, transport, language: language ?? (style.briefLanguage === "en" ? "en" : "pt-BR"), profileId };
}

/** Grade e fundo da folha numa rota genérica: alfa nativo quando a rota tem, senão cor-chave fora da paleta. */
function sheetFor(e: Env, frameIds: string[], cell: [number, number], references: number): ReferenceSheet {
  const alphaReferences = e.adapter.limits?.("generate_asset").alphaReferences;
  const nativeAlpha = e.adapter.capabilities("generate_asset").includes("alpha_output") && (alphaReferences === undefined || alphaReferences === references);
  const max = e.adapter.limits?.("animate_text").maxReferences;
  if (max !== undefined && references > max) {
    throw new DomainFailure("capability_missing", `A rota aceita até ${max} referência(s); este modo envia ${references} (base${references > 1 ? " + guia de poses" : ""})`, { maxReferences: max });
  }
  return { ...sheetLayout(frameIds.length), cell, backgroundKey: nativeAlpha ? null : chooseKeyColor(e.style.palette.colors.map((c) => c.hex)), frameIds };
}

function checkCeiling(estimate: CostEstimate, ceiling: z.infer<typeof CostAmount> | null | undefined): boolean | null {
  if (estimate.kind === "unknown" || !ceiling) return null;
  const amount = estimate.kind === "known" ? estimate.amount : estimate.max;
  if (amount.unit !== ceiling.unit) return null;
  if (amount.amount > ceiling.amount) {
    throw new DomainFailure("budget_exceeded", `Estimativa ${amount.amount} ${amount.unit} excede o teto autorizado de ${ceiling.amount} ${ceiling.unit}; nada foi enviado`, {
      needsConfiguration: true,
      estimate,
      ceiling,
    });
  }
  return true;
}

function finish(e: Env, plan: GenerationPlan, route: AnimationRoute, summary: AnimationPlanResult["summary"], ceiling: z.infer<typeof CostAmount> | null | undefined): AnimationPlanResult {
  const withinCeiling = checkCeiling(plan.limits.estimate, ceiling);
  const parsed = GenerationPlan.safeParse(plan);
  if (!parsed.success) {
    throw new DomainFailure("validation_failed", parsed.error.issues[0]?.message ?? "Plano inválido", {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  const issues = validatePlanReferences(plan, catalogLookup(e.studio.db));
  if (issues.length > 0) {
    throw new DomainFailure(issues[0]!.code === "cross_project_reference" ? "cross_project_reference" : issues[0]!.code === "source_not_approved" ? "source_not_approved" : "validation_failed", issues[0]!.message, { issues });
  }
  const profile = getProfileRow(e.studio.db, e.profileId);
  return {
    plan,
    digest: canonicalDigest(plan),
    destination: { profileId: profile.id, name: profile.name, transport: profile.transport, simulated: profile.transport === "simulated" },
    route: { strategy: route.strategy, label: route.label },
    summary,
    costCheck: { kind: plan.limits.estimate.kind, withinCeiling },
  };
}

function envelope(e: Env, recipe: string, route: AnimationRoute) {
  return {
    planVersion: 1 as const,
    projectId: e.projectId,
    styleRevisionId: e.styleRevisionId,
    recipeRevisionId: `builtin-${recipe}-${route.strategy === "native" ? "native" : "sheet"}-v1`,
    providerProfileId: e.profileId,
    requiredCapabilities: route.required,
  };
}

function limits(e: Env, operation: GenerationPlan["operation"], ceiling: z.infer<typeof CostAmount> | null | undefined) {
  return { maxSubmissions: 1, costCeiling: ceiling ?? null, estimate: e.adapter.estimate(operation, 1) };
}

/** Descrição curta do sujeito para o prompt: nome da base (e aparência informada). */
function subject(base: LoadedBase, appearance?: string): string {
  return appearance?.trim() || base.asset.name;
}

function motionSource(db: Db, projectId: string, motionRevisionId: string, ordinal: number) {
  const motion = loadMotion(db, projectId, motionRevisionId);
  return { motion, source: { ordinal, revisionId: motion.revision.id, fileId: null, sha256: motion.revision.payloadDigest, role: "motion" as const } };
}

/** Movimento aprovado para (base, ação, direção), gravado pelo editor de esqueleto. */
export function approvedMotionFor(db: Db, projectId: string, baseAssetId: string, action: string, direction: Direction): string | null {
  const row = db.get<{ id: string }>(
    `SELECT r.id FROM assets a JOIN asset_revisions r ON r.id = a.approved_revision_id
     WHERE a.project_id = :p AND a.family = 'character' AND a.kind = 'motion' AND a.archived_at IS NULL
       AND json_extract(r.technical_report_json, '$.baseAssetId') = :base
       AND json_extract(r.payload_json, '$.action') = :action AND json_extract(r.payload_json, '$.direction') = :dir
     ORDER BY a.updated_at DESC LIMIT 1`,
    { p: projectId, base: baseAssetId, action, dir: direction },
  );
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Um clique: preset
// ---------------------------------------------------------------------------

export function buildAnimatePresetPlan(studio: Studio, projectId: string, raw: AnimatePresetPlanInput): AnimationPlanResult {
  const input = AnimatePresetPlanInput.parse(raw);
  const preset = findPreset(input.presetKey, input.presetVersion);
  if (!preset) throw new DomainFailure("not_found", `Preset ${input.presetKey}${input.presetVersion ? ` v${input.presetVersion}` : ""} não existe`);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const base = loadBase(studio.db, projectId, input.baseRevisionId);
  const { file, size } = viewFile(base, input.direction);
  const durations = input.durationsMs ?? preset.durationsMs;
  if (durations.length !== preset.frameIds.length) {
    throw new DomainFailure("validation_failed", `O preset ${preset.label} tem ${preset.frameIds.length} quadros; foram informadas ${durations.length} durações`);
  }

  let motionRevisionId: string | null = null;
  let motion: ReturnType<typeof motionSource> | null = null;
  if (preset.strategy === "skeleton") {
    motionRevisionId = input.motionRevisionId ?? approvedMotionFor(studio.db, projectId, base.asset.id, preset.action, input.direction);
    if (!motionRevisionId) {
      // Parâmetro faltante abre a configuração (editor de esqueleto com o preset), sem chamada paga.
      throw new DomainFailure("coverage_incomplete", `O preset ${preset.label} é de esqueleto: aprove um movimento ${preset.action} (${input.direction}) para ${base.asset.name} no editor antes do clique`, {
        needsConfiguration: true,
        reason: "motion_missing",
        presetKey: preset.key,
      });
    }
    motion = motionSource(studio.db, projectId, motionRevisionId, 1);
    if (motion.motion.payload.poses.length !== preset.frameIds.length || motion.motion.payload.direction !== input.direction) {
      throw new DomainFailure("validation_failed", `O movimento aprovado tem ${motion.motion.payload.poses.length} poses (${motion.motion.payload.direction}); o preset pede ${preset.frameIds.length} na direção ${input.direction}`);
    }
  }

  const route = chooseRoute(e.adapter, "animate_preset", { mode: preset.strategy, customSkeleton: motion?.motion.payload.skeleton.kind === "custom" }, e.profileId);
  const sheet = route.strategy === "reference_sheet" ? sheetFor(e, [...preset.frameIds], size, preset.strategy === "skeleton" ? 2 : 1) : undefined;
  if (route.strategy === "native" && e.transport === "pixellab_rest_v2") {
    if (preset.strategy === "text") pixelLabTextAnimationBody({ action: "x", firstFrame: new Uint8Array(), size, frames: preset.frameIds.length });
    else pixelLabSkeletonBody({ description: "x", firstFrame: new Uint8Array(), motion: motion!.motion.payload });
  }
  if (route.strategy === "native" && preset.strategy === "text" && e.transport === "pixellab_rest_v2" && !fitsTextV3(preset.frameIds.length)) {
    throw new DomainFailure("capability_missing", `O preset ${preset.label} tem ${preset.frameIds.length} quadros; o texto v3 exige 4–16 pares`);
  }
  const compiled = compilePresetPrompt(e, preset, base, input.direction, route, sheet);
  const plan: GenerationPlan = {
    ...envelope(e, `animate-preset-${preset.key}`, route),
    operation: "animate_preset",
    prompt: { brief: "", compiled: compiled.text, language: compiled.language },
    sources: [{ ordinal: 0, revisionId: base.revision.id, fileId: file.fileKey, sha256: file.sha256, role: "base" }, ...(motion ? [motion.source] : [])],
    parts: [{ partKey: `strip:${input.direction}`, unit: "strip", label: `${preset.label} · ${DIRECTION_LABEL[input.direction]}` }],
    limits: limits(e, "animate_preset", input.costCeiling),
    params: {
      presetRevisionId: presetRevisionId(projectId, preset),
      baseRevisionId: base.revision.id,
      action: preset.action,
      stance: preset.stance,
      directions: [input.direction],
      mode: preset.strategy,
      durationsMs: durations,
      playback: preset.playback,
      ...(motionRevisionId ? { motionRevisionId } : {}),
      ...(sheet ? { sheet } : {}),
    },
  };
  return finish(e, plan, route, { direction: input.direction, action: preset.action, frameIds: [...preset.frameIds], durationsMs: durations, playback: preset.playback }, input.costCeiling);
}

function compilePresetPrompt(e: Env, preset: ActionPreset, base: LoadedBase, direction: Direction, route: AnimationRoute, sheet: ReferenceSheet | undefined) {
  if (route.strategy === "reference_sheet") {
    return {
      language: e.language,
      text: compileSheetAnimationPrompt({
        lang: e.language,
        subject: subject(base),
        motion: preset.motion[e.language],
        frameIds: [...preset.frameIds],
        columns: sheet!.columns,
        rows: sheet!.rows,
        direction,
        style: e.style,
        backgroundKey: sheet!.backgroundKey,
        poseGuide: preset.strategy === "skeleton",
      }),
    };
  }
  // Nativo: texto v3 recebe a ação; esqueleto v3 recebe a aparência (as poses vão como dados).
  return { language: "en" as const, text: preset.strategy === "skeleton" ? subject(base) : preset.motion.en };
}

// ---------------------------------------------------------------------------
// Texto livre
// ---------------------------------------------------------------------------

export function buildAnimateTextPlan(studio: Studio, projectId: string, raw: AnimateTextPlanInput): AnimationPlanResult {
  const input = AnimateTextPlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const base = loadBase(studio.db, projectId, input.baseRevisionId);
  const { file, size } = viewFile(base, input.direction);
  const frames = input.durationsMs.length;
  const route = chooseRoute(e.adapter, "animate_text", { mode: "text" }, e.profileId);
  const frameIds = textFrameIds(frames);
  const sheet = route.strategy === "reference_sheet" ? sheetFor(e, frameIds, size, 1) : undefined;
  if (route.strategy === "native" && e.transport === "pixellab_rest_v2") pixelLabTextAnimationBody({ action: "x", firstFrame: new Uint8Array(), size, frames });
  const compiled =
    route.strategy === "reference_sheet"
      ? compileSheetAnimationPrompt({ lang: e.language, subject: subject(base), motion: input.actionText, frameIds, columns: sheet!.columns, rows: sheet!.rows, direction: input.direction, style: e.style, backgroundKey: sheet!.backgroundKey, poseGuide: false })
      : input.actionText;
  const plan: GenerationPlan = {
    ...envelope(e, "animate-text", route),
    operation: "animate_text",
    prompt: { brief: input.actionText, compiled, language: e.language },
    sources: [{ ordinal: 0, revisionId: base.revision.id, fileId: file.fileKey, sha256: file.sha256, role: "base" }],
    parts: [{ partKey: `strip:${input.direction}`, unit: "strip", label: `Texto livre · ${DIRECTION_LABEL[input.direction]}` }],
    limits: limits(e, "animate_text", input.costCeiling),
    params: {
      baseRevisionId: base.revision.id,
      actionText: input.actionText,
      direction: input.direction,
      durationsMs: input.durationsMs,
      playback: input.playback,
      startFrame: null,
      endFrame: null,
      ...(sheet ? { sheet } : {}),
    },
  };
  return finish(e, plan, route, { direction: input.direction, action: textActionKey(input.actionText), frameIds, durationsMs: input.durationsMs, playback: input.playback }, input.costCeiling);
}

// ---------------------------------------------------------------------------
// Esqueleto
// ---------------------------------------------------------------------------

export function buildAnimateSkeletonPlan(studio: Studio, projectId: string, raw: AnimateSkeletonPlanInput): AnimationPlanResult {
  const input = AnimateSkeletonPlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const base = loadBase(studio.db, projectId, input.baseRevisionId);
  const motion = motionSource(studio.db, projectId, input.motionRevisionId, 1);
  const m = motion.motion.payload;
  const { file, size } = viewFile(base, m.direction);
  if (m.generationCell[0] !== size[0] || m.generationCell[1] !== size[1]) {
    throw new DomainFailure("validation_failed", `O movimento foi feito para ${m.generationCell.join("×")}; a base tem ${size.join("×")}`);
  }
  const route = chooseRoute(e.adapter, "animate_skeleton", { mode: "skeleton", customSkeleton: m.skeleton.kind === "custom" }, e.profileId);
  const frameIds = m.poses.map((p) => p.poseId);
  const sheet = route.strategy === "reference_sheet" ? sheetFor(e, frameIds, size, 2) : undefined;
  if (route.strategy === "native" && e.transport === "pixellab_rest_v2") pixelLabSkeletonBody({ description: "x", firstFrame: new Uint8Array(), motion: m });
  const compiled =
    route.strategy === "reference_sheet"
      ? compileSheetAnimationPrompt({ lang: e.language, subject: subject(base, input.appearance), motion: input.actionText, frameIds, columns: sheet!.columns, rows: sheet!.rows, direction: m.direction, style: e.style, backgroundKey: sheet!.backgroundKey, poseGuide: true })
      : subject(base, input.appearance);
  const plan: GenerationPlan = {
    ...envelope(e, "animate-skeleton", route),
    operation: "animate_skeleton",
    prompt: { brief: input.actionText, compiled, language: route.strategy === "reference_sheet" ? e.language : "en" },
    sources: [{ ordinal: 0, revisionId: base.revision.id, fileId: file.fileKey, sha256: file.sha256, role: "base" }, motion.source],
    parts: [{ partKey: `strip:${m.direction}`, unit: "strip", label: `Esqueleto · ${m.action} · ${DIRECTION_LABEL[m.direction]}` }],
    limits: limits(e, "animate_skeleton", input.costCeiling),
    params: {
      baseRevisionId: base.revision.id,
      motionRevisionId: motion.motion.revision.id,
      actionText: input.actionText,
      direction: m.direction,
      playback: input.playback,
      ...(sheet ? { sheet } : {}),
    },
  };
  return finish(e, plan, route, { direction: m.direction, action: m.action, frameIds, durationsMs: m.poses.map((p) => p.durationMs), playback: input.playback }, input.costCeiling);
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

export function buildRotateViewsPlan(studio: Studio, projectId: string, raw: RotateViewsPlanInput): AnimationPlanResult {
  const input = RotateViewsPlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const base = loadBase(studio.db, projectId, input.baseRevisionId);
  const approved = base.payload.views.map((v) => v.direction);
  if (approved.includes(input.view)) {
    throw new DomainFailure("validation_failed", `A vista ${input.view} já está aprovada nesta base; vistas aprovadas não são regeradas`);
  }
  const sourceView = closestView(input.view, approved)!;
  const { file, size } = viewFile(base, sourceView);
  const projection = input.projection ?? base.payload.orientation?.projection ?? e.style.camera.projection.kind;
  const isometric = projection === "isometric";
  const route = chooseRoute(e.adapter, "rotate_views", { mode: "rotation", isometric, diagonal: input.view.length === 2 }, e.profileId);
  if (route.strategy === "native" && e.transport === "pixellab_rest_v2") pixelLabRotateBody({ source: new Uint8Array(), size, from: sourceView, to: input.view, projection });
  const sheet = route.strategy === "reference_sheet" ? sheetFor(e, ["view"], size, 1) : undefined;
  const compiled =
    route.strategy === "reference_sheet"
      ? compileSheetViewPrompt({ lang: e.language, subject: subject(base), from: sourceView, to: input.view, asymmetries: input.asymmetries, isometric, style: e.style, backgroundKey: sheet!.backgroundKey })
      : `${subject(base)}; ${input.asymmetries.join("; ")}`.replace(/; $/, "");
  const plan: GenerationPlan = {
    ...envelope(e, "rotate-views", route),
    operation: "rotate_views",
    prompt: { brief: input.asymmetries.join("; "), compiled, language: e.language },
    sources: [{ ordinal: 0, revisionId: base.revision.id, fileId: file.fileKey, sha256: file.sha256, role: "identity" }],
    parts: [{ partKey: `view:${input.view}`, unit: "view", label: `Vista ${DIRECTION_LABEL[input.view]}` }],
    limits: limits(e, "rotate_views", input.costCeiling),
    params: {
      identityRevisionId: base.revision.id,
      requestedViews: [input.view],
      approvedViews: approved,
      asymmetries: input.asymmetries,
      projection,
      worldToView: isometric ? isoWorldToView() : null,
      sourceView,
      ...(sheet ? { sheet } : {}),
    },
  };
  return finish(e, plan, route, { view: input.view, sourceView, projection }, input.costCeiling);
}

export const ANIMATION_PLAN_BUILDERS = [
  { operation: "animate_preset", input: AnimatePresetPlanInput, build: buildAnimatePresetPlan },
  { operation: "animate_text", input: AnimateTextPlanInput, build: buildAnimateTextPlan },
  { operation: "animate_skeleton", input: AnimateSkeletonPlanInput, build: buildAnimateSkeletonPlan },
  { operation: "rotate_views", input: RotateViewsPlanInput, build: buildRotateViewsPlan },
] as const;
