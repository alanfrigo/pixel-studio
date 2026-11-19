import { z } from "zod";
import {
  type BasePayload,
  type ClipPayload,
  Direction,
  DIRECTIONS_8,
  DurationMs,
  Id,
  MotionPayload,
  PLAN_OPERATIONS,
  type PlanOperation,
} from "@/contracts";
import { orientationFor } from "@/domain/animation/directions";
import { BUILTIN_PRESETS } from "@/domain/animation/presets";
import { retimeClip } from "@/domain/animation/timeline";
import { type AssetView, createAsset, getAsset, getProject, getStyleRevision, listRevisions, publishRevision, type RevisionView } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { mustBlob } from "../jobs/handlers/pipelines/shared";
import { listProfiles } from "../providers/registry";
import { jobView, submitJob } from "../services";
import type { Studio } from "../studio";
import { chooseRoute, loadBase, loadClip } from "./base";
import { S3_OPERATIONS } from "./provider-temporal";
import {
  AnimateObjectPlanInput,
  buildAnimateObjectPlan,
  buildCorrectFramePlan,
  buildCreateStatePlan,
  buildEditAnimationPlan,
  buildInterpolatePlan,
  buildTransferOutfitPlan,
  CorrectFramePlanInput,
  CreateStatePlanInput,
  EditAnimationPlanInput,
  InterpolatePlanInput,
  TransferOutfitPlanInput,
} from "./temporal-plans";
import { imageSources, inspectCorrectionMask, stateMatrix, temporalRoutes, temporalTarget } from "./temporal-service";
import { tagsByAsset } from "../library/library";
import {
  AnimatePresetPlanInput,
  AnimateSkeletonPlanInput,
  AnimateTextPlanInput,
  type AnimationPlanResult,
  buildAnimatePresetPlan,
  buildAnimateSkeletonPlan,
  buildAnimateTextPlan,
  buildRotateViewsPlan,
  RotateViewsPlanInput,
} from "./plans";

/**
 * Casos de uso do cartão S1 chamados pelas rotas `/animation`.
 *
 * - `runAnimation`: monta o plano congelado e enfileira o job numa só ação.
 *   A chave de idempotência sai do digest do plano: duplo clique (ou o mesmo
 *   pedido repetido) devolve o mesmo job e não cobra de novo. "Nova variação"
 *   é outra ação, com contador explícito.
 * - `retimeClipRevision`: muda só `durationMs` e publica revisão nova sem
 *   chamar provedor nem gerar pixels.
 * - `saveMotion` e `composeBaseViews`: autoria local, zero chamadas pagas.
 */

export const RunAnimationInput = z.strictObject({
  plan: z.discriminatedUnion("operation", [
    AnimatePresetPlanInput,
    AnimateTextPlanInput,
    AnimateSkeletonPlanInput,
    RotateViewsPlanInput,
    // Cartão S3: estados, objetos, interpolação, edição de trecho, roupa e correção de quadro.
    CreateStatePlanInput,
    AnimateObjectPlanInput,
    InterpolatePlanInput,
    EditAnimationPlanInput,
    TransferOutfitPlanInput,
    CorrectFramePlanInput,
  ]),
  /** Atalho de um clique: exige custo conhecido dentro do teto, ou custo desconhecido explicitamente aceito. */
  oneClick: z.boolean().default(false),
  allowUnknownCost: z.boolean().default(false),
  /** 0 = o pedido em si; n > 0 = nova variação deliberada do mesmo plano. */
  variation: z.number().int().min(0).max(999).default(0),
});
export type RunAnimationInput = z.input<typeof RunAnimationInput>;

export function buildAnimationPlan(studio: Studio, projectId: string, plan: z.infer<typeof RunAnimationInput>["plan"]): AnimationPlanResult {
  switch (plan.operation) {
    case "animate_preset":
      return buildAnimatePresetPlan(studio, projectId, plan);
    case "animate_text":
      return buildAnimateTextPlan(studio, projectId, plan);
    case "animate_skeleton":
      return buildAnimateSkeletonPlan(studio, projectId, plan);
    case "rotate_views":
      return buildRotateViewsPlan(studio, projectId, plan);
    case "create_state":
      return buildCreateStatePlan(studio, projectId, plan);
    case "animate_object":
      return buildAnimateObjectPlan(studio, projectId, plan);
    case "interpolate_frames":
      return buildInterpolatePlan(studio, projectId, plan);
    case "edit_animation":
      return buildEditAnimationPlan(studio, projectId, plan);
    case "transfer_outfit":
      return buildTransferOutfitPlan(studio, projectId, plan);
    case "correct_frame":
      return buildCorrectFramePlan(studio, projectId, plan);
  }
}

/** Clipe alvo por (base, ação, direção): um asset por combinação; cada job publica uma candidata nele. */
export function clipAssetFor(studio: Studio, projectId: string, base: AssetView, action: string, direction: string): AssetView {
  const name = `${base.name} · ${action} · ${direction}`.slice(0, 120);
  const row = studio.db.get<{ id: string }>(
    "SELECT id FROM assets WHERE project_id = :p AND family = 'character' AND kind = 'clip' AND name = :name AND archived_at IS NULL ORDER BY created_at LIMIT 1",
    { p: projectId, name },
  );
  return row ? getAsset(studio.db, projectId, row.id) : createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "clip", name });
}

export function motionAssetFor(studio: Studio, projectId: string, base: AssetView, action: string, direction: string): AssetView {
  const name = `${base.name} · movimento ${action} · ${direction}`.slice(0, 120);
  const row = studio.db.get<{ id: string }>(
    "SELECT id FROM assets WHERE project_id = :p AND family = 'character' AND kind = 'motion' AND name = :name AND archived_at IS NULL ORDER BY created_at LIMIT 1",
    { p: projectId, name },
  );
  return row ? getAsset(studio.db, projectId, row.id) : createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "motion", name });
}

export function runAnimation(studio: Studio, projectId: string, raw: RunAnimationInput) {
  const input = RunAnimationInput.parse(raw);
  const planned = buildAnimationPlan(studio, projectId, input.plan);
  if (input.oneClick) {
    // Sem prévia: o atalho só envia com custo conhecido dentro do teto ou custo desconhecido aceito na configuração.
    if (planned.costCheck.kind === "unknown" && !input.allowUnknownCost) {
      throw new DomainFailure("budget_exceeded", "Custo desconhecido nesta rota: aceite explicitamente o custo desconhecido (1 envio) na configuração do preset antes do clique", {
        needsConfiguration: true,
        reason: "unknown_cost",
        estimate: planned.plan.limits.estimate,
      });
    }
    if (planned.costCheck.kind !== "unknown" && planned.costCheck.withinCeiling !== true) {
      throw new DomainFailure("budget_exceeded", "Configure um teto de custo na mesma unidade da estimativa antes de animar com um clique", {
        needsConfiguration: true,
        reason: "ceiling_missing",
        estimate: planned.plan.limits.estimate,
      });
    }
  }
  // Ponto sem `await`: montar alvo e enfileirar acontecem juntos, sem intercalar com outro clique.
  let target: AssetView;
  if ("baseRevisionId" in input.plan) {
    const base = loadBase(studio.db, projectId, input.plan.baseRevisionId);
    target =
      planned.plan.operation === "rotate_views"
        ? base.asset
        : clipAssetFor(studio, projectId, base.asset, (planned.summary as { action: string }).action, (planned.summary as { direction: string }).direction);
  } else {
    target = temporalTarget(studio, projectId, planned.plan);
  }
  const key = `animation:${planned.digest}:${input.variation}`;
  const { job, created } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: target.id } }, key);
  return { job, created, targetAssetId: target.id, idempotencyKey: key, ...planned };
}

/** Rota HTTP: a correção com máscara confere a máscara antes de enfileirar (máscara vazia = zero envios). */
export async function runAnimationChecked(studio: Studio, projectId: string, raw: RunAnimationInput) {
  const input = RunAnimationInput.parse(raw);
  if (input.plan.operation === "correct_frame") await inspectCorrectionMask(studio, projectId, input.plan.maskUploadId);
  return runAnimation(studio, projectId, input);
}

// ---------------------------------------------------------------------------
// Retime local
// ---------------------------------------------------------------------------

export const RetimeInput = z.strictObject({
  clipRevisionId: Id,
  durationsMs: z.array(DurationMs).min(1).max(256),
  playback: z.enum(["loop", "once", "ping_pong"]).optional(),
});

/** Novas durações = revisão nova do clipe com os MESMOS arquivos; nenhum provedor é chamado. */
export function retimeClipRevision(studio: Studio, projectId: string, raw: z.input<typeof RetimeInput>) {
  const input = RetimeInput.parse(raw);
  const { revision, asset, payload } = loadClip(studio.db, projectId, input.clipRevisionId);
  let next: ClipPayload;
  try {
    next = retimeClip(payload, input.durationsMs);
  } catch (err) {
    throw new DomainFailure("validation_failed", err instanceof Error ? err.message : String(err));
  }
  if (input.playback) next = { ...next, playback: input.playback };
  const before = payload.frames.map((f) => f.durationMs);
  if (before.join(",") === input.durationsMs.join(",") && next.playback === payload.playback) {
    return { revision, unchanged: true };
  }
  const created = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "edit",
    styleRevisionId: revision.styleRevisionId,
    predecessorId: revision.id,
    payload: next,
    files: revision.files.map((f) => ({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: mustBlob(studio.db, f.sha256) })),
    edges: [{ toRevisionId: revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "retime",
      generated: false,
      providerCalls: 0,
      from: before,
      to: input.durationsMs,
      playback: { from: payload.playback, to: next.playback },
      frameIds: next.frames.map((f) => f.frameId),
    },
  });
  return { revision: created, unchanged: false };
}

// ---------------------------------------------------------------------------
// Movimento (editor de esqueleto)
// ---------------------------------------------------------------------------

export const SaveMotionInput = z.strictObject({
  baseRevisionId: Id,
  motion: MotionPayload,
  presetKey: z.string().max(64).nullable().default(null),
});

export function saveMotion(studio: Studio, projectId: string, raw: z.input<typeof SaveMotionInput>) {
  const input = SaveMotionInput.parse(raw);
  const base = loadBase(studio.db, projectId, input.baseRevisionId);
  const [w, h] = base.payload.logicalSize;
  if (input.motion.generationCell[0] !== w || input.motion.generationCell[1] !== h) {
    throw new DomainFailure("validation_failed", `As poses são normalizadas na célula da base (${w}×${h}); o movimento declara ${input.motion.generationCell.join("×")}`);
  }
  const asset = motionAssetFor(studio, projectId, base.asset, input.motion.action, input.motion.direction);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "edit",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload: input.motion,
    files: [],
    edges: [{ toRevisionId: base.revision.id, role: "base", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "motion_editor",
      baseAssetId: base.asset.id,
      baseRevisionId: base.revision.id,
      presetKey: input.presetKey,
      joints: input.motion.skeleton.joints.length,
      poses: input.motion.poses.length,
    },
  });
  return { asset, revision };
}

// ---------------------------------------------------------------------------
// Vistas: escolher por direção e publicar a seleção
// ---------------------------------------------------------------------------

export const ComposeViewsInput = z.strictObject({
  baseAssetId: Id,
  picks: z.array(z.strictObject({ direction: Direction, revisionId: Id })).min(1).max(8),
});

/** Base nova com as vistas escolhidas por direção (de qualquer revisão da base), reaproveitando os blobs. */
export function composeBaseViews(studio: Studio, projectId: string, raw: z.input<typeof ComposeViewsInput>) {
  const input = ComposeViewsInput.parse(raw);
  const asset = getAsset(studio.db, projectId, input.baseAssetId);
  if (asset.family !== "character" || asset.kind !== "base") throw new DomainFailure("validation_failed", "Só bases de personagem compõem vistas");
  const revisions = new Map(listRevisions(studio.db, projectId, asset.id).map((r) => [r.id, r]));
  const anchor = revisions.get(asset.approvedRevisionId ?? "") ?? revisions.get(input.picks[0]!.revisionId);
  if (!anchor) throw new DomainFailure("not_found", "Revisão da base não encontrada");
  const anchorPayload = anchor.payload as BasePayload;
  const views: BasePayload["views"] = [];
  const files: { fileKey: string; role: string; idx: number; blob: ReturnType<typeof mustBlob> }[] = [];
  const seen = new Set<string>();
  for (const pick of [...input.picks].sort((a, b) => DIRECTIONS_8.indexOf(a.direction) - DIRECTIONS_8.indexOf(b.direction))) {
    if (seen.has(pick.direction)) throw new DomainFailure("validation_failed", `Direção ${pick.direction} escolhida duas vezes`);
    seen.add(pick.direction);
    const revision = revisions.get(pick.revisionId);
    if (!revision) throw new DomainFailure("not_found", `A revisão ${pick.revisionId} não pertence a ${asset.name}`);
    if (revision.status === "rejected") throw new DomainFailure("validation_failed", `A vista ${pick.direction} vem de uma revisão reprovada`);
    const payload = revision.payload as BasePayload;
    if (payload.logicalSize.join("x") !== anchorPayload.logicalSize.join("x")) throw new DomainFailure("validation_failed", "Vistas de células diferentes não se combinam");
    const view = payload.views.find((v) => v.direction === pick.direction);
    if (!view) throw new DomainFailure("not_found", `A revisão r${revision.number} não tem a vista ${pick.direction}`);
    const file = revision.files.find((f) => f.fileKey === view.fileId)!;
    // Chaves podem colidir entre revisões: a chave da vista na composição é derivada da direção.
    const fileKey = files.some((f) => f.fileKey === view.fileId) ? `view-${pick.direction.toLowerCase()}` : view.fileId;
    views.push({ ...view, fileId: fileKey });
    files.push({ fileKey, role: "view", idx: files.length, blob: mustBlob(studio.db, file.sha256) });
  }
  const orientation = anchorPayload.orientation ?? [...revisions.values()].map((r) => (r.payload as BasePayload).orientation).find(Boolean);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "composition",
    styleRevisionId: anchor.styleRevisionId,
    predecessorId: anchor.id,
    payload: { ...anchorPayload, views, ...(orientation ? { orientation } : {}) },
    files,
    edges: [...new Set(input.picks.map((p) => p.revisionId))].map((id, i) => ({ toRevisionId: id, role: "source", ordinal: i, runtime: false })),
    technicalReport: { operation: "compose_views", picks: input.picks, providerCalls: 0, mirrored: false },
  });
  return { revision };
}

// ---------------------------------------------------------------------------
// Visão geral para a página de animação
// ---------------------------------------------------------------------------

const ANIMATION_OPS: PlanOperation[] = ["animate_preset", "animate_text", "animate_skeleton", "rotate_views", ...S3_OPERATIONS];

function revisionsOf(studio: Studio, projectId: string, family: "character", kind: string) {
  return studio.db
    .all<{ id: string }>("SELECT id FROM assets WHERE project_id = :p AND family = :f AND kind = :k AND archived_at IS NULL ORDER BY updated_at DESC", { p: projectId, f: family, k: kind })
    .map((row) => {
      const asset = getAsset(studio.db, projectId, row.id);
      return { asset, revisions: listRevisions(studio.db, projectId, asset.id).slice(0, 20) as RevisionView[] };
    });
}

export function animationOverview(studio: Studio, projectId: string) {
  const project = getProject(studio.db, projectId);
  const style = project.activeStyleRevisionId ? getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload : null;
  const projection = style?.camera.projection.kind ?? "top_down";
  const profiles = listProfiles(studio.db).map((p) => {
    let unavailable: string | null = null;
    const routes: Record<string, { strategy: string; label: string } | { unavailable: string }> = {};
    let estimate = null;
    try {
      studio.providers.assertReady(p.id);
      const adapter = studio.providers.adapterFor(p.id);
      estimate = adapter.estimate("animate_preset", 1);
      const tryRoute = (op: PlanOperation, want: Parameters<typeof chooseRoute>[2]) => {
        try {
          const r = chooseRoute(adapter, op, want, p.id);
          return { strategy: r.strategy, label: r.label };
        } catch (err) {
          return { unavailable: err instanceof Error ? err.message : String(err) };
        }
      };
      routes.text = tryRoute("animate_text", { mode: "text" });
      routes.skeleton = tryRoute("animate_skeleton", { mode: "skeleton" });
      routes.rotation = tryRoute("rotate_views", { mode: "rotation", isometric: projection === "isometric" });
      routes.rotationIsometric = tryRoute("rotate_views", { mode: "rotation", isometric: true });
      // Cartão S3: estados, objetos, interpolação, trecho, roupa e correção.
      Object.assign(routes, temporalRoutes({ adapter, profileId: p.id }));
      if (!ANIMATION_OPS.some((op) => adapter.capabilities(op).length > 0)) unavailable = "Perfil sem operações de animação ou vistas";
    } catch (err) {
      unavailable = err instanceof Error ? err.message : String(err);
    }
    return { id: p.id, name: p.name, transport: p.transport, simulated: p.simulated, unavailable, routes, estimate };
  });
  return {
    projectId,
    projection,
    orientation: orientationFor(projection),
    presets: BUILTIN_PRESETS,
    bases: revisionsOf(studio, projectId, "character", "base"),
    clips: revisionsOf(studio, projectId, "character", "clip"),
    motions: revisionsOf(studio, projectId, "character", "motion"),
    // Cartão S3: matriz de estados × direções, referências de roupa e etiquetas.
    states: stateMatrix(studio, projectId),
    imageSources: imageSources(studio, projectId),
    tags: tagsByAsset(studio, projectId),
    profiles,
    operations: PLAN_OPERATIONS.filter((op) => ANIMATION_OPS.includes(op)),
    jobs: studio.queue
      .list(projectId, { active: false })
      .filter((j) => {
        try {
          const op = (JSON.parse(j.request_json) as { plan?: { operation?: string } }).plan?.operation;
          return op !== undefined && ANIMATION_OPS.includes(op as PlanOperation);
        } catch {
          return false;
        }
      })
      .slice(0, 20)
      .map((j) => jobView(studio, j)),
  };
}
