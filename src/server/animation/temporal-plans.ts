import { type LocalizedText, tx } from "@/i18n/locales";
import { z } from "zod";
import {
  type Capability,
  CostAmount,
  Direction,
  DIRECTIONS_8,
  DurationMs,
  type FrameLayout,
  type GenerationPlan,
  Id,
  KeyframeRef,
  type PlanOperation,
  type PlanSource,
  Playback,
  type ReferenceSheet,
  Slug,
} from "@/contracts";
import { DIRECTION_LABEL } from "@/domain/animation/directions";
import { BUILTIN_PRESETS } from "@/domain/animation/presets";
import { adjacent, frameLayouts, intermediateFrameIds } from "@/domain/animation/temporal";
import { sheetLayout } from "@/domain/animation/timeline";
import { type AssetView, getAsset, getRevision, getUpload, type RevisionView } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { chooseKeyColor } from "../services";
import type { Studio } from "../studio";
import { slugify } from "../util";
import { type AnimationRoute, type LoadedBase, loadBase, loadClip, rigForBase, textFrameIds, viewFile } from "./base";
import { type AnimationPlanResult, type Env, env, finish, limits } from "./plans";
import { compileCorrectionPrompt, compileEditPrompt, compileInterpolationPrompt, compileObjectAnimationPrompt, compileOutfitPrompt, compileStatePrompt } from "./temporal-prompts";

/**
 * Construtores de plano do cartão S3. Tudo que pode bloquear (capacidade,
 * limite da rota, fonte não aprovada, vista inexistente) acontece aqui, antes
 * de cobrar. Cada plano tem uma parte; a rota é escolhida pela capacidade do
 * perfil, nunca pela marca:
 *
 * - nativa quando o perfil oferece a capacidade própria da operação
 *   (interpolação, edição de trecho, roupa, máscara nativa na correção);
 * - senão, folha por imagem + referências, identificada como rota genérica
 *   (estado e animação de objeto só existem assim);
 * - senão, bloqueio com o requisito faltante.
 */

const Language = z.enum(["pt-BR", "en"]);
const commonT = {
  providerProfileId: Id,
  language: Language.optional(),
  costCeiling: CostAmount.nullable().optional(),
};

export const TEMPORAL_ROUTE_LABELS = {
  state_sheet: tx("Estado redesenhado por imagem + referência (rota genérica; não é estado nativo)", "State redrawn via image + reference (generic route; not a native state)"),
  object_sheet: tx("Folha de quadros do objeto por imagem + referência (rota genérica; não é animação nativa)", "Object frame sheet via image + reference (generic route; not native animation)"),
  interpolate_native: tx("Interpolação nativa do provedor: devolve só os intermediários", "Provider's native interpolation: returns only the in-betweens"),
  interpolate_sheet: tx("Intermediários desenhados por imagem + referências (rota genérica; não é interpolação nativa)", "In-betweens drawn via image + references (generic route; not native interpolation)"),
  edit_native: tx("Edição de trecho nativa do provedor (quadros inteiros, sem máscara)", "Provider's native segment edit (whole frames, no mask)"),
  edit_sheet: tx("Trecho redesenhado por imagem + referência (rota genérica; não é edição nativa)", "Segment redrawn via image + reference (generic route; not a native edit)"),
  outfit_native: tx("Transferência de roupa nativa do provedor: clipe vestido, não overlay modular", "Provider's native outfit transfer: dressed clip, not a modular overlay"),
  outfit_sheet: tx("Clipe vestido por imagem + referências (rota genérica): candidato achatado, não overlay modular", "Dressed clip via image + references (generic route): flattened candidate, not a modular overlay"),
  correct_native: tx("Correção com máscara nativa do provedor no quadro", "Frame correction with the provider's native mask"),
  correct_candidate: tx("Candidato editado + recorte local; sem condicionamento nativo por máscara", "Edited candidate + local crop; no native mask conditioning"),
} as const satisfies Record<string, LocalizedText>;

// ---------------------------------------------------------------------------
// Peças comuns
// ---------------------------------------------------------------------------

/**
 * Rota pela capacidade: nativa (quando a operação tem uma), senão folha por
 * imagem + referências, senão bloqueio antes de cobrar.
 */
export function chooseTemporalRoute(e: Pick<Env, "adapter" | "profileId">, operation: PlanOperation, native: { required: Capability[]; label: LocalizedText } | null, sheet: LocalizedText): AnimationRoute {
  const offered = e.adapter.capabilities(operation);
  if (native && native.required.every((c) => offered.includes(c))) return { strategy: "native", required: native.required, label: native.label };
  if (offered.includes("image_references")) return { strategy: "reference_sheet", required: ["image_references"], label: sheet };
  const nativeMissing = native?.required.filter((c) => !offered.includes(c)) ?? [];
  throw new DomainFailure("capability_missing", tx(`O perfil ${e.profileId} não oferece ${nativeMissing.length ? `${nativeMissing.join(", ")} nem ` : ""}imagem + referências para ${operation}`, `Provider profile ${e.profileId} offers ${nativeMissing.length ? `neither ${nativeMissing.join(", ")} nor ` : "no "}image + references for ${operation}`), {
    missing: [...nativeMissing, "image_references"],
    offered,
  });
}

/** Folha da rota genérica: grade, célula, fundo (alfa nativo ou cor-chave fora da paleta) e IDs na ordem. */
function temporalSheet(e: Env, operation: PlanOperation, frameIds: string[], cell: [number, number], references: number): ReferenceSheet {
  const lim = e.adapter.limits?.(operation);
  if (lim?.maxReferences !== undefined && references > lim.maxReferences) {
    throw new DomainFailure("capability_missing", tx(`A rota aceita até ${lim.maxReferences} referência(s); esta operação envia ${references}`, `The route accepts up to ${lim.maxReferences} reference(s); this operation sends ${references}`), { maxReferences: lim.maxReferences });
  }
  const nativeAlpha = e.adapter.capabilities("generate_asset").includes("alpha_output") && (lim?.alphaReferences === undefined || lim.alphaReferences === references);
  return { ...sheetLayout(frameIds.length), cell, backgroundKey: nativeAlpha ? null : chooseKeyColor(e.style.palette.colors.map((c) => c.hex)), frameIds };
}

function envelopeT(e: Env, recipe: string, route: AnimationRoute) {
  return {
    planVersion: 1 as const,
    projectId: e.projectId,
    styleRevisionId: e.styleRevisionId,
    recipeRevisionId: `builtin-${recipe}-${route.strategy === "native" ? "native" : "sheet"}-v1`,
    providerProfileId: e.profileId,
    requiredCapabilities: route.required,
  };
}

export function subjectOf(base: LoadedBase): "character" | "object" {
  return base.payload.subject ?? "character";
}

function approvedClip(db: Db, projectId: string, clipRevisionId: string) {
  const clip = loadClip(db, projectId, clipRevisionId);
  if (clip.revision.status !== "approved") throw new DomainFailure("source_not_approved", tx(`O clipe ${clip.asset.name} r${clip.revision.number} precisa estar aprovado`, `Clip ${clip.asset.name} r${clip.revision.number} must be approved`));
  return clip;
}

/** Cada arquivo distinto das camadas vira UMA fonte (atlas compartilhado não duplica a fonte). */
function fileSources(revision: RevisionView, fileIds: string[], role: PlanSource["role"], firstOrdinal: number): PlanSource[] {
  return fileIds.map((fileId, i) => {
    const file = revision.files.find((f) => f.fileKey === fileId);
    if (!file || file.mime !== "image/png") throw new DomainFailure("not_found", tx(`A revisão r${revision.number} não tem o arquivo ${fileId}`, `Revision r${revision.number} has no file ${fileId}`));
    return { ordinal: firstOrdinal + i, revisionId: revision.id, fileId, sha256: file.sha256, role };
  });
}

function orderedFrameIds(clip: ReturnType<typeof loadClip>, frameIds: string[]): string[] {
  const order = clip.payload.frames.map((f) => f.frameId);
  const unique = [...new Set(frameIds)];
  for (const id of unique) if (!order.includes(id)) throw new DomainFailure("not_found", tx(`O quadro ${id} não existe em ${clip.asset.name} r${clip.revision.number}`, `Frame ${id} does not exist in ${clip.asset.name} r${clip.revision.number}`));
  return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Identidade de origem de um estado: sobe pelos predecessores até a base sem predecessor. */
export function identityOf(db: Db, projectId: string, base: LoadedBase): LoadedBase {
  let current = base;
  const seen = new Set<string>([base.revision.id]);
  while (current.payload.predecessorRevisionId && !seen.has(current.payload.predecessorRevisionId)) {
    seen.add(current.payload.predecessorRevisionId);
    try {
      current = loadBase(db, projectId, current.payload.predecessorRevisionId, { approved: false });
    } catch {
      break;
    }
  }
  return current;
}

export function stateAssetName(identity: AssetView, stateKey: string): string {
  return `${identity.name} · estado ${stateKey}`.slice(0, 120);
}

export function findStateAsset(db: Db, projectId: string, identity: AssetView, stateKey: string): AssetView | null {
  const row = db.get<{ id: string }>("SELECT id FROM assets WHERE project_id = :p AND family = 'character' AND kind = 'base' AND name = :n AND archived_at IS NULL ORDER BY created_at LIMIT 1", {
    p: projectId,
    n: stateAssetName(identity, stateKey),
  });
  return row ? getAsset(db, projectId, row.id) : null;
}

function viewKey(direction: Direction): string {
  return `view-${direction.toLowerCase()}`;
}

function sortDirections(directions: Direction[]): Direction[] {
  return [...new Set(directions)].sort((a, b) => DIRECTIONS_8.indexOf(a) - DIRECTIONS_8.indexOf(b));
}

// ---------------------------------------------------------------------------
// Estado de personagem/objeto
// ---------------------------------------------------------------------------

export const CreateStatePlanInput = z.strictObject({
  operation: z.literal("create_state"),
  ...commonT,
  /** Revisão aprovada de onde o estado parte: a base ou outro estado. */
  sourceRevisionId: Id,
  stateKey: Slug,
  description: z.string().trim().min(1).max(1000),
  directions: z.array(Direction).min(1).max(8),
});
export type CreateStatePlanInput = z.input<typeof CreateStatePlanInput>;

/** Posturas de empunhadura conhecidas: um estado visual nunca é uma postura. */
function knownStances(db: Db, projectId: string, base: LoadedBase): string[] {
  const rig = rigForBase(db, projectId, base);
  return [...new Set([...(rig?.payload.stances ?? []), ...BUILTIN_PRESETS.map((p) => p.stance).filter((s): s is string => Boolean(s))])];
}

export function buildCreateStatePlan(studio: Studio, projectId: string, raw: CreateStatePlanInput): AnimationPlanResult {
  const input = CreateStatePlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const source = loadBase(studio.db, projectId, input.sourceRevisionId);
  const subject = subjectOf(source);
  if (input.stateKey === source.payload.state) {
    throw new DomainFailure("validation_failed", tx(`A fonte já está no estado ${input.stateKey}: um estado novo muda a arte, não só o nome`, `The source is already in state ${input.stateKey}: a new state changes the art, not just the name`));
  }
  if (knownStances(studio.db, projectId, source).includes(input.stateKey)) {
    throw new DomainFailure("validation_failed", tx(`${input.stateKey} é uma postura de empunhadura, não um estado visual (ferido, congelado, aberto)`, `${input.stateKey} is a grip stance, not a visual state (hurt, frozen, open)`));
  }
  const directions = sortDirections(input.directions);
  // Sem herdar cobertura inexistente: cada direção pedida precisa de vista aprovada na fonte.
  const views = directions.map((d) => ({ direction: d, ...viewFile(source, d) }));
  const identity = identityOf(studio.db, projectId, source);
  const stateAsset = findStateAsset(studio.db, projectId, identity.asset, input.stateKey);
  const existing = stateAsset?.approvedRevisionId ? loadBase(studio.db, projectId, stateAsset.approvedRevisionId) : null;
  if (existing) {
    if (existing.payload.state !== input.stateKey) throw new DomainFailure("validation_failed", tx(`O asset ${stateAsset!.name} guarda o estado ${existing.payload.state}`, `Asset ${stateAsset!.name} holds state ${existing.payload.state}`));
    const overlap = directions.filter((d) => existing.payload.views.some((v) => v.direction === d));
    if (overlap.length > 0) throw new DomainFailure("validation_failed", tx(`As vistas ${overlap.join(", ")} do estado ${input.stateKey} já estão aprovadas; vistas aprovadas não são regeradas`, `Views ${overlap.join(", ")} of state ${input.stateKey} are already approved; approved views are not regenerated`));
  }
  const route = chooseTemporalRoute(e, "create_state", null, TEMPORAL_ROUTE_LABELS.state_sheet);
  const cell = source.payload.logicalSize;
  const sheet = temporalSheet(e, "create_state", directions.map(viewKey), cell, 1);
  const isSourceState = Boolean(source.payload.predecessorRevisionId);
  const compiled = compileStatePrompt({ lang: e.language, subject: identity.asset.name, isObject: subject === "object", directions, columns: sheet.columns, rows: sheet.rows, change: input.description, stateKey: input.stateKey, style: e.style, backgroundKey: sheet.backgroundKey });
  const plan: GenerationPlan = {
    ...envelopeT(e, "create-state", route),
    operation: "create_state",
    prompt: { brief: input.description, compiled, language: e.language },
    sources: views.map((v, i) => ({ ordinal: i, revisionId: source.revision.id, fileId: v.file.fileKey, sha256: v.file.sha256, role: "source" as const })),
    parts: [{ partKey: `state:${input.stateKey}`, unit: "state", label: `Estado ${input.stateKey} · ${directions.join(", ")}` }],
    limits: limits(e, "create_state", input.costCeiling),
    params: {
      identityAssetId: identity.asset.id,
      baseRevisionId: isSourceState ? identity.revision.id : source.revision.id,
      predecessorStateRevisionId: isSourceState ? source.revision.id : null,
      stateKey: input.stateKey,
      description: input.description,
      directions,
      subject,
      logicalSize: cell,
      existingStateRevisionId: existing?.revision.id ?? null,
      sheet,
    },
  };
  return finish(e, plan, route, { stateKey: input.stateKey, subject, directions, sourceRevisionId: source.revision.id, identityAssetId: identity.asset.id, fillsGap: Boolean(existing) }, input.costCeiling);
}

// ---------------------------------------------------------------------------
// Animação de objeto
// ---------------------------------------------------------------------------

export const AnimateObjectPlanInput = z.strictObject({
  operation: z.literal("animate_object"),
  ...commonT,
  objectRevisionId: Id,
  direction: Direction,
  action: Slug,
  description: z.string().trim().min(1).max(1000),
  /** Durações dos quadros gerados (sem o de referência). */
  durationsMs: z.array(DurationMs).min(1).max(40),
  playback: Playback,
  /** Padrão: mantém a vista como quadro 0 em ações únicas; ciclos não repetem a referência. */
  keepFirstFrame: z.boolean().optional(),
  firstFrameMs: DurationMs.optional(),
  endFrame: z.strictObject({ revisionId: Id, direction: Direction }).optional(),
});
export type AnimateObjectPlanInput = z.input<typeof AnimateObjectPlanInput>;

function loadObject(db: Db, projectId: string, revisionId: string): LoadedBase {
  const object = loadBase(db, projectId, revisionId);
  if (subjectOf(object) !== "object") {
    throw new DomainFailure("validation_failed", tx(`${object.asset.name} é um personagem; a animação de objeto parte de um objeto (sem rig humanoide). Para personagens use um clique, texto ou esqueleto`, `${object.asset.name} is a character; object animation starts from an object (no humanoid rig). For characters use one-click, text or skeleton`));
  }
  return object;
}

export function buildAnimateObjectPlan(studio: Studio, projectId: string, raw: AnimateObjectPlanInput): AnimationPlanResult {
  const input = AnimateObjectPlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const object = loadObject(studio.db, projectId, input.objectRevisionId);
  const { file, size } = viewFile(object, input.direction);
  let end: { revision: RevisionView; file: { fileKey: string; sha256: string } } | null = null;
  if (input.endFrame) {
    if (input.endFrame.direction !== input.direction) throw new DomainFailure("validation_failed", tx("O quadro final usa a mesma direção da animação", "The end frame uses the same direction as the animation"));
    const target = loadObject(studio.db, projectId, input.endFrame.revisionId);
    if (target.payload.logicalSize.join("x") !== size.join("x") || target.payload.groundOrigin.join(",") !== object.payload.groundOrigin.join(",")) {
      throw new DomainFailure("validation_failed", tx("Início e fim precisam da mesma célula e do mesmo pivô", "Start and end need the same cell and the same pivot"));
    }
    end = { revision: target.revision, file: viewFile(target, input.direction).file };
  }
  const keepFirstFrame = input.keepFirstFrame ?? input.playback !== "loop";
  const route = chooseTemporalRoute(e, "animate_object", null, TEMPORAL_ROUTE_LABELS.object_sheet);
  const generatedIds = textFrameIds(input.durationsMs.length);
  const sheet = temporalSheet(e, "animate_object", generatedIds, size, end ? 2 : 1);
  const compiled = compileObjectAnimationPrompt({ lang: e.language, subject: object.asset.name, motion: input.description, frames: generatedIds.length, columns: sheet.columns, rows: sheet.rows, direction: input.direction, endFrame: Boolean(end), style: e.style, backgroundKey: sheet.backgroundKey });
  const sources: PlanSource[] = [{ ordinal: 0, revisionId: object.revision.id, fileId: file.fileKey, sha256: file.sha256, role: "source" }];
  if (end) sources.push({ ordinal: 1, revisionId: end.revision.id, fileId: end.file.fileKey, sha256: end.file.sha256, role: "last_frame" });
  const plan: GenerationPlan = {
    ...envelopeT(e, "animate-object", route),
    operation: "animate_object",
    prompt: { brief: input.description, compiled, language: e.language },
    sources,
    parts: [{ partKey: `strip:${input.direction}`, unit: "strip", label: `${input.action} · ${DIRECTION_LABEL[input.direction]}` }],
    limits: limits(e, "animate_object", input.costCeiling),
    params: {
      objectRevisionId: object.revision.id,
      action: input.action,
      state: object.payload.state,
      description: input.description,
      direction: input.direction,
      durationsMs: input.durationsMs,
      playback: input.playback,
      keepFirstFrame,
      firstFrameMs: keepFirstFrame ? (input.firstFrameMs ?? input.durationsMs[0]!) : null,
      endFrame: input.endFrame ?? null,
      logicalSize: size,
      sheet,
    },
  };
  const frameIds = [...(keepFirstFrame ? ["ref"] : []), ...generatedIds];
  return finish(
    e,
    plan,
    route,
    {
      direction: input.direction,
      action: input.action,
      state: object.payload.state,
      frameIds,
      expectedFrames: frameIds.length,
      keepFirstFrame,
      keepFirstFrameNote: keepFirstFrame
        ? tx("A vista aprovada fica como quadro 0 (ref): o resultado tem um quadro a mais que os gerados", "The approved view stays as frame 0 (ref): the result has one more frame than was generated")
        : tx("Só os quadros gerados entram: a referência não é repetida no ciclo", "Only the generated frames go in: the reference is not repeated in the cycle"),
      durationsMs: [...(keepFirstFrame ? [plan.params.firstFrameMs as number] : []), ...input.durationsMs],
      playback: input.playback,
      objectAssetId: object.asset.id,
    },
    input.costCeiling,
  );
}

// ---------------------------------------------------------------------------
// Interpolação entre dois keyframes
// ---------------------------------------------------------------------------

export const InterpolatePlanInput = z.strictObject({
  operation: z.literal("interpolate_frames"),
  ...commonT,
  start: KeyframeRef,
  end: KeyframeRef,
  action: z.string().trim().min(1).max(500),
  /** Rota genérica: intermediários pedidos. A rota nativa decide a contagem. */
  count: z.number().int().min(1).max(14).optional(),
  /** Duração total dos intermediários, distribuída em ms inteiros. */
  transitionMs: DurationMs,
  /** Entre duas vistas: clipe novo com os extremos uma vez só. */
  newClip: z.strictObject({ action: Slug, startMs: DurationMs, endMs: DurationMs, playback: Playback }).optional(),
});
export type InterpolatePlanInput = z.input<typeof InterpolatePlanInput>;

export function buildInterpolatePlan(studio: Studio, projectId: string, raw: InterpolatePlanInput): AnimationPlanResult {
  const input = InterpolatePlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const { start, end } = input;
  let sources: PlanSource[];
  let layouts: FrameLayout[];
  let cell: [number, number];
  let pivot: [number, number];
  let target: Extract<GenerationPlan, { operation: "interpolate_frames" }>["params"]["target"];
  let existingIds: string[] = [];
  let subject = "o sujeito";
  let names: [string, string];
  if (start.kind === "clip_frame" && end.kind === "clip_frame") {
    if (start.clipRevisionId !== end.clipRevisionId) throw new DomainFailure("validation_failed", tx("Os dois keyframes de um clipe vêm da mesma revisão de clipe (mesma célula e pivô)", "Both keyframes of a clip come from the same clip revision (same cell and pivot)"));
    const clip = approvedClip(studio.db, projectId, start.clipRevisionId);
    if (start.frameId === end.frameId) throw new DomainFailure("validation_failed", tx("Escolha dois quadros diferentes", "Pick two different frames"));
    if (!adjacent(clip.payload, start.frameId, end.frameId)) {
      throw new DomainFailure("validation_failed", tx(`${end.frameId} precisa vir logo depois de ${start.frameId} no clipe: os intermediários entram entre os dois, sem duplicar nenhum extremo`, `${end.frameId} must come right after ${start.frameId} in the clip: the in-betweens go between the two, without duplicating either end`));
    }
    const { layouts: l, files } = frameLayouts(clip.payload, [start.frameId, end.frameId], 0);
    layouts = l;
    sources = fileSources(clip.revision, files, "source", 0);
    cell = clip.payload.logicalSize;
    pivot = clip.payload.pivot;
    existingIds = clip.payload.frames.map((f) => f.frameId);
    target = { kind: "insert", clipRevisionId: clip.revision.id, afterFrameId: start.frameId, beforeFrameId: end.frameId };
    subject = clip.asset.name;
    names = [start.frameId, end.frameId];
  } else if (start.kind === "view" && end.kind === "view") {
    if (start.direction !== end.direction) throw new DomainFailure("validation_failed", tx("Os dois keyframes usam a mesma direção", "Both keyframes use the same direction"));
    const a = loadBase(studio.db, projectId, start.baseRevisionId);
    const b = loadBase(studio.db, projectId, end.baseRevisionId);
    if (a.revision.id === b.revision.id) throw new DomainFailure("validation_failed", tx("Escolha duas vistas diferentes (ex.: dois estados)", "Pick two different views (e.g. two states)"));
    if (a.payload.logicalSize.join("x") !== b.payload.logicalSize.join("x") || a.payload.groundOrigin.join(",") !== b.payload.groundOrigin.join(",")) {
      throw new DomainFailure("validation_failed", tx(`Os keyframes precisam da mesma célula e do mesmo pivô (${a.payload.logicalSize.join("×")} @ ${a.payload.groundOrigin.join(",")} × ${b.payload.logicalSize.join("×")} @ ${b.payload.groundOrigin.join(",")})`, `Keyframes need the same cell and the same pivot (${a.payload.logicalSize.join("×")} @ ${a.payload.groundOrigin.join(",")} × ${b.payload.logicalSize.join("×")} @ ${b.payload.groundOrigin.join(",")})`));
    }
    const fa = viewFile(a, start.direction).file;
    const fb = viewFile(b, end.direction).file;
    sources = [
      { ordinal: 0, revisionId: a.revision.id, fileId: fa.fileKey, sha256: fa.sha256, role: "first_frame" },
      { ordinal: 1, revisionId: b.revision.id, fileId: fb.fileKey, sha256: fb.sha256, role: "last_frame" },
    ];
    cell = a.payload.logicalSize;
    pivot = a.payload.groundOrigin;
    const full = (source: number, id: string): FrameLayout => ({ frameId: id, layers: [{ source, rect: [0, 0, cell[0], cell[1]], offset: [0, 0] }] });
    layouts = [full(0, "start"), full(1, "end")];
    const action = input.newClip?.action ?? (slugify(input.action).slice(0, 40).replace(/_+$/, "") || "transicao");
    target = { kind: "new_clip", action, state: a.payload.state, direction: start.direction, startMs: input.newClip?.startMs ?? 150, endMs: input.newClip?.endMs ?? 250, playback: input.newClip?.playback ?? "once" };
    existingIds = ["start", "end"];
    subject = identityOf(studio.db, projectId, a).asset.name;
    names = ["start", "end"];
  } else {
    throw new DomainFailure("validation_failed", tx("Os dois keyframes são do mesmo tipo: dois quadros vizinhos de um clipe ou duas vistas (estados) na mesma direção", "Both keyframes must be the same kind: two neighboring frames of a clip or two views (states) in the same direction"));
  }
  const route = chooseTemporalRoute(e, "interpolate_frames", { required: ["frame_interpolation"], label: TEMPORAL_ROUTE_LABELS.interpolate_native }, TEMPORAL_ROUTE_LABELS.interpolate_sheet);
  const count = route.strategy === "native" ? null : (input.count ?? 2);
  const ids = count ? intermediateFrameIds(existingIds, names[0], names[1], count) : [];
  const sheet = count ? temporalSheet(e, "interpolate_frames", ids, cell, 2) : undefined;
  const compiled = sheet ? compileInterpolationPrompt({ lang: e.language, subject, transition: input.action, count: count!, columns: sheet.columns, rows: sheet.rows, style: e.style, backgroundKey: sheet.backgroundKey }) : input.action;
  const plan: GenerationPlan = {
    ...envelopeT(e, "interpolate", route),
    operation: "interpolate_frames",
    prompt: { brief: input.action, compiled, language: e.language },
    sources,
    parts: [{ partKey: `segment:${names[0]}-${names[1]}`.slice(0, 120), unit: "segment", label: `Intermediários ${names[0]} → ${names[1]}` }],
    limits: limits(e, "interpolate_frames", input.costCeiling),
    params: { start, end, action: input.action, target, count, transitionMs: input.transitionMs, logicalSize: cell, pivot, frames: layouts, ...(sheet ? { sheet } : {}) },
  };
  return finish(
    e,
    plan,
    route,
    {
      target: target.kind,
      count: count ?? "definida pela rota nativa",
      intermediateIds: ids,
      transitionMs: input.transitionMs,
      endpoints: names,
      note: tx("Os extremos ficam como estão (mesmo hash) e não se repetem; os intermediários recebem IDs novos e tempos explícitos", "The ends stay as they are (same hash) and are not repeated; the in-betweens get new IDs and explicit timings"),
    },
    input.costCeiling,
  );
}

// ---------------------------------------------------------------------------
// Edição de trecho
// ---------------------------------------------------------------------------

export const EditAnimationPlanInput = z.strictObject({
  operation: z.literal("edit_animation"),
  ...commonT,
  clipRevisionId: Id,
  frameIds: z.array(Id).min(1).max(16),
  description: z.string().trim().min(1).max(2000),
});
export type EditAnimationPlanInput = z.input<typeof EditAnimationPlanInput>;

export function buildEditAnimationPlan(studio: Studio, projectId: string, raw: EditAnimationPlanInput): AnimationPlanResult {
  const input = EditAnimationPlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const clip = approvedClip(studio.db, projectId, input.clipRevisionId);
  const frameIds = orderedFrameIds(clip, input.frameIds);
  const protectedIds = clip.payload.frames.map((f) => f.frameId).filter((id) => !frameIds.includes(id));
  const { layouts, files } = frameLayouts(clip.payload, frameIds, 0);
  const cell = clip.payload.logicalSize;
  const route = chooseTemporalRoute(e, "edit_animation", { required: ["animation_edit"], label: TEMPORAL_ROUTE_LABELS.edit_native }, TEMPORAL_ROUTE_LABELS.edit_sheet);
  const sheet = route.strategy === "reference_sheet" ? temporalSheet(e, "edit_animation", frameIds, cell, 1) : undefined;
  const compiled = sheet ? compileEditPrompt({ lang: e.language, subject: clip.asset.name, change: input.description, frameIds, columns: sheet.columns, rows: sheet.rows, style: e.style, backgroundKey: sheet.backgroundKey }) : input.description;
  const plan: GenerationPlan = {
    ...envelopeT(e, "edit-animation", route),
    operation: "edit_animation",
    prompt: { brief: input.description, compiled, language: e.language },
    sources: fileSources(clip.revision, files, "source", 0),
    parts: [{ partKey: `segment:${frameIds[0]}-${frameIds.at(-1)}`.slice(0, 120), unit: "segment", label: `Trecho ${frameIds.join(", ")}`.slice(0, 120) }],
    limits: limits(e, "edit_animation", input.costCeiling),
    params: { clipRevisionId: clip.revision.id, frameIds, description: input.description, logicalSize: cell, frames: layouts, ...(sheet ? { sheet } : {}) },
  };
  return finish(e, plan, route, { clipAssetId: clip.asset.id, frameIds, protectedFrameIds: protectedIds, note: tx("Só o trecho vira candidato; os demais quadros ficam pelo hash", "Only the segment becomes a candidate; the other frames are kept by hash") }, input.costCeiling);
}

// ---------------------------------------------------------------------------
// Transferir roupa (clipe candidato vestido)
// ---------------------------------------------------------------------------

export const TransferOutfitPlanInput = z.strictObject({
  operation: z.literal("transfer_outfit"),
  ...commonT,
  clipRevisionId: Id,
  frameIds: z.array(Id).min(1).max(16).optional(),
  outfitRevisionId: Id,
  outfitFileKey: z.string().min(1).max(128),
  stateKey: Slug.optional(),
  instructions: z.string().trim().max(2000).optional(),
});
export type TransferOutfitPlanInput = z.input<typeof TransferOutfitPlanInput>;

export function buildTransferOutfitPlan(studio: Studio, projectId: string, raw: TransferOutfitPlanInput): AnimationPlanResult {
  const input = TransferOutfitPlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const clip = approvedClip(studio.db, projectId, input.clipRevisionId);
  const frameIds = orderedFrameIds(clip, input.frameIds ?? clip.payload.frames.map((f) => f.frameId));
  const outfit = getRevision(studio.db, projectId, input.outfitRevisionId);
  if (outfit.status !== "approved") throw new DomainFailure("source_not_approved", tx(`A referência da roupa r${outfit.number} precisa estar aprovada`, `The outfit reference r${outfit.number} must be approved`));
  const outfitFile = outfit.files.find((f) => f.fileKey === input.outfitFileKey);
  if (!outfitFile || outfitFile.mime !== "image/png") throw new DomainFailure("not_found", tx(`A revisão da roupa não tem a imagem ${input.outfitFileKey}`, `The outfit revision has no image ${input.outfitFileKey}`));
  const outfitAsset = getAsset(studio.db, projectId, outfit.assetId);
  const stateKey = input.stateKey ?? `outfit_${slugify(outfitAsset.name).slice(0, 50) || "roupa"}`;
  if (!stateKey.startsWith("outfit_")) throw new DomainFailure("validation_failed", tx("O estado do clipe vestido começa por outfit_", "The dressed clip state starts with outfit_"));
  const cell = clip.payload.logicalSize;
  const { layouts, files } = frameLayouts(clip.payload, frameIds, 0);
  const sources = fileSources(clip.revision, files, "source", 0);
  sources.push({ ordinal: sources.length, revisionId: outfit.id, fileId: outfitFile.fileKey, sha256: outfitFile.sha256, role: "equipment" });
  const route = chooseTemporalRoute(e, "transfer_outfit", { required: ["outfit_transfer"], label: TEMPORAL_ROUTE_LABELS.outfit_native }, TEMPORAL_ROUTE_LABELS.outfit_sheet);
  const sheet = route.strategy === "reference_sheet" ? temporalSheet(e, "transfer_outfit", frameIds, cell, 2) : undefined;
  const compiled = sheet
    ? compileOutfitPrompt({ lang: e.language, subject: clip.asset.name, frames: frameIds.length, columns: sheet.columns, rows: sheet.rows, instructions: input.instructions ?? null, style: e.style, backgroundKey: sheet.backgroundKey })
    : (input.instructions ?? "");
  const plan: GenerationPlan = {
    ...envelopeT(e, "transfer-outfit", route),
    operation: "transfer_outfit",
    prompt: { brief: input.instructions ?? "", compiled, language: e.language },
    sources,
    parts: [{ partKey: `strip:${stateKey}`.slice(0, 120), unit: "strip", label: `Clipe vestido · ${outfitAsset.name}`.slice(0, 120) }],
    limits: limits(e, "transfer_outfit", input.costCeiling),
    params: { clipRevisionId: clip.revision.id, frameIds, outfit: { revisionId: outfit.id, fileId: outfitFile.fileKey }, stateKey, instructions: input.instructions ?? null, logicalSize: cell, frames: layouts, ...(sheet ? { sheet } : {}) },
  };
  return finish(
    e,
    plan,
    route,
    {
      clipAssetId: clip.asset.id,
      stateKey,
      frameIds,
      outfitAssetId: outfitAsset.id,
      note: tx(
        "Publica um clipe candidato vestido (mesmos quadros e célula). Não é overlay modular e não substitui a base limpa; a cobertura modular é extraída depois, pelo fluxo de equipamentos",
        "Publishes a dressed candidate clip (same frames and cell). It is not a modular overlay and does not replace the clean base; modular coverage is extracted later, in the equipment flow",
      ),
    },
    input.costCeiling,
  );
}

// ---------------------------------------------------------------------------
// Corrigir um quadro/região
// ---------------------------------------------------------------------------

export const CorrectFramePlanInput = z.strictObject({
  operation: z.literal("correct_frame"),
  ...commonT,
  clipRevisionId: Id,
  frameId: Id,
  partId: Slug.optional(),
  /** Máscara binária (upload do projeto, 255 edita / 0 protege) na célula do clipe; ausente = o quadro inteiro. */
  maskUploadId: Id.nullable().optional(),
  instruction: z.string().trim().min(1).max(1000),
  mode: z.enum(["native-mask", "candidate-composite"]),
  /** Vizinhos de contexto; padrão: anterior e seguinte. */
  contextFrameIds: z.array(Id).max(2).optional(),
});
export type CorrectFramePlanInput = z.input<typeof CorrectFramePlanInput>;

/** Cor de marcação da guia: fora da paleta E diferente da cor-chave do fundo. */
export function correctionMarkColor(e: Pick<Env, "style">, backgroundKey: string | null): string {
  const palette = e.style.palette.colors.map((c) => c.hex);
  return chooseKeyColor(backgroundKey ? [...palette, backgroundKey] : palette);
}

export function buildCorrectFramePlan(studio: Studio, projectId: string, raw: CorrectFramePlanInput): AnimationPlanResult {
  const input = CorrectFramePlanInput.parse(raw);
  const e = env(studio, projectId, input.providerProfileId, input.language);
  const clip = approvedClip(studio.db, projectId, input.clipRevisionId);
  const order = clip.payload.frames.map((f) => f.frameId);
  const index = order.indexOf(input.frameId);
  if (index < 0) throw new DomainFailure("not_found", tx(`O quadro ${input.frameId} não existe em ${clip.asset.name} r${clip.revision.number}`, `Frame ${input.frameId} does not exist in ${clip.asset.name} r${clip.revision.number}`));
  const frame = clip.payload.frames[index]!;
  const partId = input.partId ?? (frame.layers.length === 1 ? frame.layers[0]!.partId : "body");
  if (!frame.layers.some((l) => l.partId === partId)) throw new DomainFailure("not_found", tx(`O quadro ${input.frameId} não tem a camada ${partId}`, `Frame ${input.frameId} has no layer ${partId}`));
  const neighbors = input.contextFrameIds ?? [order[index - 1], order[index + 1] ?? (clip.payload.playback === "loop" ? order[0] : undefined)].filter((id): id is string => Boolean(id) && id !== input.frameId);
  const context = orderedFrameIds(clip, neighbors).filter((id) => id !== input.frameId).slice(0, 2);
  const cell = clip.payload.logicalSize;
  const offered = e.adapter.capabilities("correct_frame");
  const required: Capability[] = input.mode === "native-mask" ? ["native_mask"] : ["image_edit"];
  if (!required.every((c) => offered.includes(c))) {
    throw new DomainFailure(
      "capability_missing",
      input.mode === "native-mask"
        ? tx(
            `O perfil ${e.profileId} não recebe máscara nativa${offered.includes("image_edit") ? '; ele aceita "candidato editado + recorte local", que é outro modo e precisa ser escolhido explicitamente' : ""}`,
            `Provider profile ${e.profileId} does not accept a native mask${offered.includes("image_edit") ? '; it accepts "edited candidate + local crop", which is a different mode and must be chosen explicitly' : ""}`,
          )
        : tx(
            `O perfil ${e.profileId} não edita a partir do quadro de origem (precisa aceitar o quadro e a guia como referências)`,
            `Provider profile ${e.profileId} cannot edit from the source frame (it must accept the frame and the guide as references)`,
          ),
      { missing: required.filter((c) => !offered.includes(c)), offered },
    );
  }
  const route: AnimationRoute = { strategy: input.mode === "native-mask" ? "native" : "reference_sheet", required, label: input.mode === "native-mask" ? TEMPORAL_ROUTE_LABELS.correct_native : TEMPORAL_ROUTE_LABELS.correct_candidate };
  // Alvo (só a camada corrigida) e vizinhos completos, cada arquivo distinto uma vez.
  const target = frameLayouts(clip.payload, [input.frameId], 0, partId);
  const ctx = frameLayouts(clip.payload, context, 0);
  const files = [...target.files, ...ctx.files.filter((f) => !target.files.includes(f))];
  const remap = (l: FrameLayout, own: string[]): FrameLayout => ({ ...l, layers: l.layers.map((x) => ({ ...x, source: files.indexOf(own[x.source]!) })) });
  const layouts = [remap(target.layouts[0]!, target.files), ...ctx.layouts.map((l) => remap(l, ctx.files))];
  const sources = fileSources(clip.revision, files, "source", 0);
  let maskUpload: ReturnType<typeof getUpload> | null = null;
  if (input.maskUploadId) {
    maskUpload = getUpload(studio.db, projectId, input.maskUploadId);
    if (maskUpload.status !== "ready" || maskUpload.modality !== "raster") throw new DomainFailure("validation_failed", tx("A máscara precisa ser uma imagem já importada", "The mask must be an already imported image"));
    const { width, height } = (maskUpload.metadata ?? {}) as { width?: number; height?: number };
    if (width !== cell[0] || height !== cell[1]) throw new DomainFailure("validation_failed", tx(`A máscara tem ${width}×${height}; a célula do clipe é ${cell.join("×")}`, `The mask is ${width}×${height}; the clip cell is ${cell.join("×")}`));
    sources.push({ ordinal: sources.length, revisionId: clip.revision.id, fileId: maskUpload.id, sha256: maskUpload.normalizedSha256 ?? maskUpload.sha256, role: "edit_mask" });
  }
  const sheet = route.strategy === "reference_sheet" ? temporalSheet(e, "correct_frame", [input.frameId], cell, 2 + context.length) : undefined;
  const fullMask = !maskUpload;
  const compiled =
    input.mode === "native-mask"
      ? `${input.instruction}. Pixel art coerente com o restante do quadro.`
      : compileCorrectionPrompt({ lang: e.language, instruction: input.instruction, markColor: correctionMarkColor(e, sheet?.backgroundKey ?? null), fullMask, neighbors: context.length, style: e.style, backgroundKey: sheet?.backgroundKey ?? null });
  const plan: GenerationPlan = {
    ...envelopeT(e, "correct-frame", route),
    operation: "correct_frame",
    prompt: { brief: input.instruction, compiled, language: e.language },
    sources,
    parts: [{ partKey: `image:${input.frameId}`.slice(0, 120), unit: "image", label: `Quadro ${input.frameId} · ${partId}${fullMask ? " (quadro inteiro)" : " (região)"}`.slice(0, 120) }],
    limits: limits(e, "correct_frame", input.costCeiling),
    params: {
      clipRevisionId: clip.revision.id,
      frameId: input.frameId,
      partId,
      contextFrameIds: context,
      editMaskFileId: maskUpload?.id ?? null,
      maskConvention: "white_edits_black_preserves",
      mode: input.mode,
      instruction: input.instruction,
      logicalSize: cell,
      frames: layouts,
      ...(sheet ? { sheet } : {}),
    },
  };
  return finish(
    e,
    plan,
    route,
    {
      clipAssetId: clip.asset.id,
      frameId: input.frameId,
      partId,
      contextFrameIds: context,
      mask: maskUpload ? tx("região marcada", "marked region") : tx("quadro inteiro (sem máscara)", "whole frame (no mask)"),
      modeLabel: route.label,
      note: tx("Só o quadro alvo muda; os demais quadros ficam com os mesmos hashes e o RGBA protegido é restaurado byte a byte", "Only the target frame changes; the other frames keep the same hashes and the protected RGBA is restored byte for byte"),
    },
    input.costCeiling,
  );
}

export const TEMPORAL_PLAN_BUILDERS = [
  { operation: "create_state", input: CreateStatePlanInput, build: buildCreateStatePlan },
  { operation: "animate_object", input: AnimateObjectPlanInput, build: buildAnimateObjectPlan },
  { operation: "interpolate_frames", input: InterpolatePlanInput, build: buildInterpolatePlan },
  { operation: "edit_animation", input: EditAnimationPlanInput, build: buildEditAnimationPlan },
  { operation: "transfer_outfit", input: TransferOutfitPlanInput, build: buildTransferOutfitPlan },
  { operation: "correct_frame", input: CorrectFramePlanInput, build: buildCorrectFramePlan },
] as const;
