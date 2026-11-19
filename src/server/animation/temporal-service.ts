import { type LocalizedText, type TextValue, tx } from "@/i18n/locales";
import { z } from "zod";
import { type AssetFamily, type BasePayload, Direction, DIRECTIONS_8, type GenerationPlan, GridPoint, Id, PLAN_OPERATIONS, type PlanOperation } from "@/contracts";
import { type AssetView, createAsset, getAsset, getRevision, listRevisions, publishRevision, type RevisionView } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { mustBlob } from "../jobs/handlers/pipelines/shared";
import { runLocal } from "../library/local";
import { ImageRef, resolveLocalInput } from "../services";
import type { Studio } from "../studio";
import { failureText, loadBase } from "./base";
import { S3_OPERATIONS } from "./provider-temporal";
import { chooseTemporalRoute, findStateAsset, identityOf, stateAssetName, subjectOf, TEMPORAL_PLAN_BUILDERS, TEMPORAL_ROUTE_LABELS } from "./temporal-plans";
import type { Env } from "./plans";

/**
 * Casos de uso do cartão S3 fora do plano: alvo de cada operação, aprovação
 * parcial por vista (lacunas explícitas), objeto a partir de uma imagem e a
 * matriz de estados × direções exibida na página de animação.
 */

function namedAsset(studio: Studio, projectId: string, family: AssetFamily, kind: string, name: string): AssetView {
  const row = studio.db.get<{ id: string }>("SELECT id FROM assets WHERE project_id = :p AND family = :f AND kind = :k AND name = :n AND archived_at IS NULL ORDER BY created_at LIMIT 1", {
    p: projectId,
    f: family,
    k: kind,
    n: name.slice(0, 120),
  });
  return row ? getAsset(studio.db, projectId, row.id) : createAsset(studio.db, studio.clock, { projectId, family, kind, name: name.slice(0, 120) });
}

function assetOf(studio: Studio, projectId: string, revisionId: string): AssetView {
  return getAsset(studio.db, projectId, getRevision(studio.db, projectId, revisionId).assetId);
}

/** Asset que recebe a candidata de cada operação S3 (estado e roupa têm asset próprio; edições publicam no próprio clipe). */
export function temporalTarget(studio: Studio, projectId: string, plan: GenerationPlan): AssetView {
  switch (plan.operation) {
    case "create_state": {
      const identity = getAsset(studio.db, projectId, plan.params.identityAssetId);
      return findStateAsset(studio.db, projectId, identity, plan.params.stateKey) ?? createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "base", name: stateAssetName(identity, plan.params.stateKey) });
    }
    case "animate_object": {
      const object = assetOf(studio, projectId, plan.params.objectRevisionId);
      return namedAsset(studio, projectId, "character", "clip", `${object.name} · ${plan.params.action} · ${plan.params.direction}`);
    }
    case "interpolate_frames": {
      const t = plan.params.target;
      if (t.kind === "insert") return assetOf(studio, projectId, t.clipRevisionId);
      const start = plan.params.start;
      if (start.kind !== "view") throw new DomainFailure("internal", tx("Clipe novo de transição parte de vistas", "A new transition clip starts from views"));
      const identity = identityOf(studio.db, projectId, loadBase(studio.db, projectId, start.baseRevisionId, { approved: false }));
      return namedAsset(studio, projectId, "character", "clip", `${identity.asset.name} · ${t.action} · ${t.direction}`);
    }
    case "edit_animation":
    case "correct_frame":
      return assetOf(studio, projectId, plan.params.clipRevisionId);
    case "transfer_outfit": {
      const clip = assetOf(studio, projectId, plan.params.clipRevisionId);
      return namedAsset(studio, projectId, "character", "clip", `${clip.name} · ${plan.params.stateKey}`);
    }
    default:
      throw new DomainFailure("internal", tx(`Operação ${plan.operation} não é do cartão S3`, `Operation ${plan.operation} is not part of card S3`));
  }
}

/** Correção com máscara: máscara vazia bloqueia antes de enfileirar (zero envios), como no inpainting E1. */
export async function inspectCorrectionMask(studio: Studio, projectId: string, maskUploadId: string | null | undefined) {
  if (!maskUploadId) return null;
  const { getUpload } = await import("../catalog/catalog");
  const upload = getUpload(studio.db, projectId, maskUploadId);
  const sha = upload.normalizedSha256 ?? upload.sha256;
  const { report } = await runLocal(studio, "inspect_mask", [{ role: "source", sha256: sha }, { role: "editMask", sha256: sha }], { version: 1, maskConvention: "white_edits_black_preserves" });
  if (report.emptyMask) throw new DomainFailure("validation_failed", tx("Máscara vazia: nenhuma região a corrigir. Nada foi enviado.", "Empty mask: no region to correct. Nothing was sent."), { emptyMask: true });
  return report;
}

// ---------------------------------------------------------------------------
// Aprovação parcial por vista
// ---------------------------------------------------------------------------

export const SelectViewsInput = z.strictObject({
  /** Revisão candidata (estado, objeto ou base) com as vistas a escolher. */
  revisionId: Id,
  keep: z.array(Direction).min(1).max(8),
  /** Reprovadas: ficam fora da revisão e registradas como lacunas com motivo. */
  reject: z.array(z.strictObject({ direction: Direction, reason: z.string().trim().min(1).max(300) })).max(8).default([]),
});

/**
 * Publica uma revisão com SÓ as vistas escolhidas (mesmos blobs e chaves). As
 * reprovadas viram lacunas explícitas no relatório; aprovar segue o fluxo de
 * revisão existente. Reprovar uma direção não invalida as outras nem dispara
 * geração: a lacuna se preenche com um plano só daquela direção.
 */
export function selectViews(studio: Studio, projectId: string, raw: z.input<typeof SelectViewsInput>) {
  const input = SelectViewsInput.parse(raw);
  const revision = getRevision(studio.db, projectId, input.revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "character" || asset.kind !== "base") throw new DomainFailure("validation_failed", tx("A escolha por vista vale para bases, objetos e estados (character/base)", "Per-view selection applies to bases, objects and states (character/base)"));
  if (revision.status === "rejected") throw new DomainFailure("validation_failed", tx("A revisão já foi reprovada", "The revision was already rejected"));
  const payload = revision.payload as BasePayload;
  const keep = DIRECTIONS_8.filter((d) => input.keep.includes(d));
  for (const d of keep) if (!payload.views.some((v) => v.direction === d)) throw new DomainFailure("not_found", tx(`A revisão r${revision.number} não tem a vista ${d}`, `Revision r${revision.number} has no ${d} view`));
  const overlap = input.reject.filter((r) => keep.includes(r.direction));
  if (overlap.length) throw new DomainFailure("validation_failed", tx(`Direção marcada como mantida e reprovada: ${overlap.map((r) => r.direction).join(", ")}`, `Direction marked as both kept and rejected: ${overlap.map((r) => r.direction).join(", ")}`));
  const views = payload.views.filter((v) => keep.includes(v.direction));
  const files = views.map((v, i) => {
    const file = revision.files.find((f) => f.fileKey === v.fileId)!;
    return { fileKey: file.fileKey, role: file.role, idx: i, blob: mustBlob(studio.db, file.sha256) };
  });
  const dropped = payload.views.filter((v) => !keep.includes(v.direction)).map((v) => v.direction);
  const previous = (revision.technicalReport as { gaps?: { direction: string; reason: TextValue }[] } | null)?.gaps ?? [];
  const gaps = [
    ...previous.filter((g) => !keep.includes(g.direction as Direction) && !dropped.includes(g.direction as Direction)),
    ...dropped.map((direction) => ({ direction, reason: input.reject.find((r) => r.direction === direction)?.reason ?? tx("não escolhida", "not chosen") })),
  ];
  const next = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "composition",
    styleRevisionId: revision.styleRevisionId,
    predecessorId: revision.id,
    payload: { ...payload, views },
    files,
    edges: [{ toRevisionId: revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "select_views",
      providerCalls: 0,
      generated: false,
      kept: keep,
      rejected: input.reject,
      gaps,
      fromRevision: revision.id,
      stateKey: payload.state,
    },
  });
  return { revision: next, gaps };
}

// ---------------------------------------------------------------------------
// Objeto a partir de uma imagem (identidade sem rig humanoide)
// ---------------------------------------------------------------------------

export const CreateObjectInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  image: ImageRef,
  direction: Direction.default("S"),
  /** Apoio no chão; padrão: base do conteúdo, no centro do pé. */
  groundOrigin: GridPoint.optional(),
  state: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/).max(64).default("default"),
});

export async function createObjectFromImage(studio: Studio, projectId: string, raw: z.input<typeof CreateObjectInput>) {
  const input = CreateObjectInput.parse(raw);
  const sha =
    input.image.from === "upload"
      ? resolveLocalInput(studio, projectId, { kind: "upload", uploadId: input.image.uploadId })
      : input.image.from === "revision"
        ? resolveLocalInput(studio, projectId, { kind: "revision", revisionId: input.image.revisionId, fileKey: input.image.fileKey })
        : resolveLocalInput(studio, projectId, { kind: "job_output", jobId: input.image.jobId, outputIndex: input.image.outputIndex });
  const blob = mustBlob(studio.db, sha);
  const { width, height } = blob.metadata as { width?: number; height?: number };
  if (blob.mime !== "image/png" || !width || !height) throw new DomainFailure("validation_failed", tx("A imagem do objeto precisa ser PNG com dimensões medidas", "The object image must be a PNG with measured dimensions"));
  const { report } = await runLocal(studio, "compose_frames", [{ role: "layer", sha256: sha }], {
    version: 1,
    cell: [width, height],
    frames: [{ key: "view", layers: [{ input: 0, rect: [0, 0, width, height], offset: [0, 0] }] }],
    sheet: null,
    emitFrames: false,
  });
  const box = (report.frames as { contentBox: [number, number, number, number] | null }[])[0]?.contentBox;
  if (!box) throw new DomainFailure("validation_failed", tx("A imagem está vazia (toda transparente)", "The image is empty (fully transparent)"));
  const groundOrigin = input.groundOrigin ?? ([Math.round(box[0] + box[2] / 2), box[1] + box[3]] as [number, number]);
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "base", name: input.name });
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "import",
    styleRevisionId: null,
    payload: {
      logicalSize: [width, height],
      groundOrigin,
      state: input.state,
      predecessorRevisionId: null,
      subject: "object",
      views: [{ direction: input.direction, fileId: `view-${input.direction.toLowerCase()}`, rect: [0, 0, width, height], sourceOffset: [0, 0] }],
    } satisfies BasePayload,
    files: [{ fileKey: `view-${input.direction.toLowerCase()}`, role: "view", idx: 0, blob }],
    technicalReport: { operation: "create_object", from: input.image, contentBox: box, providerCalls: 0 },
  });
  return { asset, revision };
}

// ---------------------------------------------------------------------------
// Visão geral: objetos, matriz de estados e rotas S3 por perfil
// ---------------------------------------------------------------------------

export interface StateMatrixRow {
  identityAssetId: string;
  identityName: string;
  subject: "character" | "object";
  identityRevisionId: string;
  directions: Direction[];
  states: {
    assetId: string;
    name: string;
    stateKey: string;
    approvedRevisionId: string | null;
    approvedViews: Direction[];
    gaps: { direction: string; reason: TextValue }[];
    revisions: { id: string; number: number; status: string; views: Direction[]; operation: string | null }[];
  }[];
}

export function stateMatrix(studio: Studio, projectId: string): StateMatrixRow[] {
  const rows = new Map<string, StateMatrixRow>();
  const bases = studio.db.all<{ id: string }>("SELECT id FROM assets WHERE project_id = :p AND family = 'character' AND kind = 'base' AND archived_at IS NULL ORDER BY created_at", { p: projectId });
  for (const { id } of bases) {
    const asset = getAsset(studio.db, projectId, id);
    const revisions = listRevisions(studio.db, projectId, id) as RevisionView[];
    const anchor = revisions.find((r) => r.id === asset.approvedRevisionId) ?? revisions[0];
    if (!anchor) continue;
    let base;
    try {
      base = loadBase(studio.db, projectId, anchor.id, { approved: false });
    } catch {
      continue;
    }
    const identity = identityOf(studio.db, projectId, base);
    const key = identity.asset.id;
    if (!rows.has(key)) {
      const identityApproved = identity.asset.approvedRevisionId ? loadBase(studio.db, projectId, identity.asset.approvedRevisionId, { approved: false }) : identity;
      rows.set(key, {
        identityAssetId: identity.asset.id,
        identityName: identity.asset.name,
        subject: subjectOf(identityApproved),
        identityRevisionId: identityApproved.revision.id,
        directions: identityApproved.payload.views.map((v) => v.direction),
        states: [],
      });
    }
    if (identity.asset.id === asset.id) continue;
    const approved = asset.approvedRevisionId ? (revisions.find((r) => r.id === asset.approvedRevisionId)!.payload as BasePayload) : null;
    const report = revisions.find((r) => r.id === asset.approvedRevisionId)?.technicalReport as { gaps?: { direction: string; reason: TextValue }[] } | null;
    rows.get(key)!.states.push({
      assetId: asset.id,
      name: asset.name,
      stateKey: base.payload.state,
      approvedRevisionId: asset.approvedRevisionId,
      approvedViews: approved?.views.map((v) => v.direction) ?? [],
      gaps: report?.gaps ?? [],
      revisions: revisions.slice(0, 12).map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        views: (r.payload as BasePayload).views.map((v) => v.direction),
        operation: (r.technicalReport as { operation?: string } | null)?.operation ?? null,
      })),
    });
  }
  return [...rows.values()];
}

/** Rotas S3 de um perfil, pelo que ele realmente faz (ou o motivo da indisponibilidade). */
export function temporalRoutes(e: Pick<Env, "adapter" | "profileId">): Record<string, { strategy: string; label: LocalizedText } | { unavailable: TextValue }> {
  const tryRoute = (op: PlanOperation, native: Parameters<typeof chooseTemporalRoute>[2], sheet: LocalizedText) => {
    try {
      const r = chooseTemporalRoute(e, op, native, sheet);
      return { strategy: r.strategy, label: r.label };
    } catch (err) {
      return { unavailable: failureText(err) };
    }
  };
  const offered = (op: PlanOperation) => e.adapter.capabilities(op);
  return {
    state: tryRoute("create_state", null, TEMPORAL_ROUTE_LABELS.state_sheet),
    objectAnimation: tryRoute("animate_object", null, TEMPORAL_ROUTE_LABELS.object_sheet),
    interpolation: tryRoute("interpolate_frames", { required: ["frame_interpolation"], label: TEMPORAL_ROUTE_LABELS.interpolate_native }, TEMPORAL_ROUTE_LABELS.interpolate_sheet),
    edit: tryRoute("edit_animation", { required: ["animation_edit"], label: TEMPORAL_ROUTE_LABELS.edit_native }, TEMPORAL_ROUTE_LABELS.edit_sheet),
    outfit: tryRoute("transfer_outfit", { required: ["outfit_transfer"], label: TEMPORAL_ROUTE_LABELS.outfit_native }, TEMPORAL_ROUTE_LABELS.outfit_sheet),
    correctNative: offered("correct_frame").includes("native_mask") ? { strategy: "native", label: TEMPORAL_ROUTE_LABELS.correct_native } : { unavailable: tx("Perfil sem máscara nativa", "Provider profile has no native mask") },
    correctCandidate: offered("correct_frame").includes("image_edit") ? { strategy: "reference_sheet", label: TEMPORAL_ROUTE_LABELS.correct_candidate } : { unavailable: tx("Perfil sem edição a partir do quadro", "Provider profile cannot edit from the frame") },
  };
}

/** Imagens aprovadas que podem servir de referência de roupa (item, peça, base vestida). */
export function imageSources(studio: Studio, projectId: string) {
  return studio.db
    .all<{ id: string }>(
      `SELECT a.id FROM assets a WHERE a.project_id = :p AND a.archived_at IS NULL AND a.approved_revision_id IS NOT NULL
       AND a.family IN ('item', 'equipment', 'character') ORDER BY a.updated_at DESC LIMIT 60`,
      { p: projectId },
    )
    .map(({ id }) => {
      const asset = getAsset(studio.db, projectId, id);
      const revision = getRevision(studio.db, projectId, asset.approvedRevisionId!);
      return {
        assetId: asset.id,
        name: asset.name,
        family: asset.family,
        kind: asset.kind,
        revisionId: revision.id,
        files: revision.files.filter((f) => f.mime === "image/png" && f.role !== "raw").map((f) => ({ fileKey: f.fileKey, fileId: f.id, width: (f.metadata as { width?: number }).width ?? null, height: (f.metadata as { height?: number }).height ?? null })),
      };
    })
    .filter((s) => s.files.length > 0);
}

export const TEMPORAL_PLAN_OPERATIONS = PLAN_OPERATIONS.filter((op) => S3_OPERATIONS.includes(op));

/**
 * Construtores de plano S3 para `POST /generation-plans` (prévia sem custo).
 * A correção com máscara confere a máscara antes: vazia bloqueia sem envio.
 */
export const TEMPORAL_PREVIEW_BUILDERS = TEMPORAL_PLAN_BUILDERS.map((b) => ({
  operation: b.operation as string,
  input: b.input as z.ZodType<{ operation: string }>,
  async build(studio: Studio, projectId: string, body: never) {
    if (b.operation === "correct_frame") await inspectCorrectionMask(studio, projectId, (body as { maskUploadId?: string | null }).maskUploadId);
    return { ...(b.build as (s: Studio, p: string, i: unknown) => ReturnType<typeof b.build>)(studio, projectId, body) };
  },
}));
