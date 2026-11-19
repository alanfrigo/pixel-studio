import { type BasePayload, type Capability, type ClipPayload, type Direction, type MotionPayload, parseRevisionPayload, type PlanOperation, type RigPayload } from "@/contracts";
import { resolveView } from "@/domain/animation/directions";
import { type AssetView, getAsset, getRevision, type RevisionFileView, type RevisionView } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import type { ProviderAdapter } from "../providers/types";
import { slugify } from "../util";

/**
 * Peças comuns do cartão S1: base aprovada e suas vistas, rig e movimento
 * ligados à base e a escolha honesta da rota por capacidade (nunca por marca).
 */

export interface LoadedBase {
  revision: RevisionView;
  asset: AssetView;
  payload: BasePayload;
}

export function loadBase(db: Db, projectId: string, baseRevisionId: string, opts: { approved?: boolean } = {}): LoadedBase {
  const revision = getRevision(db, projectId, baseRevisionId);
  const asset = getAsset(db, projectId, revision.assetId);
  if (asset.family !== "character" || asset.kind !== "base") {
    throw new DomainFailure("validation_failed", `A animação parte de uma base de personagem; ${asset.name} é ${asset.family}/${asset.kind}`);
  }
  if ((opts.approved ?? true) && revision.status !== "approved") {
    throw new DomainFailure("source_not_approved", `A base ${asset.name} r${revision.number} precisa estar aprovada`);
  }
  const parsed = parseRevisionPayload("character", "base", revision.payload);
  if (!parsed.success || parsed.entry.kind !== "base") throw new DomainFailure("internal", "Payload da base não passa no schema");
  return { revision, asset, payload: parsed.entry.payload as BasePayload };
}

/**
 * Arquivo da vista pedida. Vista ausente é lacuna explícita (gere a vista):
 * nunca se usa o espelho da oposta, que trocaria escudo e marcas de lado.
 */
export function viewFile(base: LoadedBase, direction: Direction): { view: BasePayload["views"][number]; file: RevisionFileView; size: [number, number] } {
  const resolution = resolveView(direction, base.payload.views);
  if (resolution.kind !== "view") {
    throw new DomainFailure("coverage_incomplete", `${base.asset.name}: ${resolution.kind === "missing" ? resolution.reason : "espelho não é implícito"}`, {
      missingView: direction,
      available: base.payload.views.map((v) => v.direction),
    });
  }
  const view = base.payload.views.find((v) => v.direction === direction)!;
  const file = base.revision.files.find((f) => f.fileKey === view.fileId);
  const [w, h] = base.payload.logicalSize;
  const { width, height } = (file?.metadata ?? {}) as { width?: number; height?: number };
  if (!file || file.mime !== "image/png") throw new DomainFailure("not_found", `A vista ${direction} não tem arquivo PNG vinculado`);
  // S1 anima vistas guardadas como célula inteira (o que a geração e a composição produzem).
  if (width !== w || height !== h || view.rect[0] !== 0 || view.rect[1] !== 0 || view.rect[2] !== w || view.rect[3] !== h || view.sourceOffset[0] !== 0 || view.sourceOffset[1] !== 0) {
    throw new DomainFailure("validation_failed", `A vista ${direction} está num atlas (${width}×${height}, rect ${view.rect.join(",")}); recorte-a para a célula ${w}×${h} antes de animar`);
  }
  return { view, file, size: [w, h] };
}

/** Rig aprovado feito para esta base, se houver e se a célula e a parte `body` combinam com o clipe gerado. */
export function rigForBase(db: Db, projectId: string, base: LoadedBase): { id: string; payload: RigPayload } | null {
  const rows = db.all<{ id: string; payload_json: string }>(
    `SELECT r.id, r.payload_json FROM assets a JOIN asset_revisions r ON r.id = a.approved_revision_id
     WHERE a.project_id = :p AND a.family = 'character' AND a.kind = 'rig' AND a.archived_at IS NULL`,
    { p: projectId },
  );
  for (const row of rows) {
    const rig = JSON.parse(row.payload_json) as RigPayload;
    const [w, h] = base.payload.logicalSize;
    if (rig.baseRevisionId === base.revision.id && rig.logicalCell[0] === w && rig.logicalCell[1] === h && rig.parts.some((p) => p.partId === "body")) {
      return { id: row.id, payload: rig };
    }
  }
  return null;
}

export function loadMotion(db: Db, projectId: string, motionRevisionId: string, opts: { approved?: boolean } = {}): { revision: RevisionView; payload: MotionPayload } {
  const revision = getRevision(db, projectId, motionRevisionId);
  const asset = getAsset(db, projectId, revision.assetId);
  if (asset.family !== "character" || asset.kind !== "motion") throw new DomainFailure("validation_failed", `${asset.name} não é um movimento`);
  if ((opts.approved ?? true) && revision.status !== "approved") {
    throw new DomainFailure("source_not_approved", `O movimento ${asset.name} r${revision.number} precisa estar aprovado antes de gerar`);
  }
  return { revision, payload: revision.payload as MotionPayload };
}

export function loadClip(db: Db, projectId: string, clipRevisionId: string): { revision: RevisionView; asset: AssetView; payload: ClipPayload } {
  const revision = getRevision(db, projectId, clipRevisionId);
  const asset = getAsset(db, projectId, revision.assetId);
  if (asset.family !== "character" || asset.kind !== "clip") throw new DomainFailure("validation_failed", `${asset.name} não é um clipe`);
  return { revision, asset, payload: revision.payload as ClipPayload };
}

// ---------------------------------------------------------------------------
// Rota honesta por capacidade
// ---------------------------------------------------------------------------

export type AnimationStrategy = "native" | "reference_sheet";

export interface AnimationRoute {
  strategy: AnimationStrategy;
  required: Capability[];
  label: string;
}

export const ROUTE_LABELS = {
  native_text: "Animação por texto nativa do provedor",
  native_skeleton: "Esqueleto enviado como dados (keypoints de cada quadro)",
  native_rotation: "Rotação nativa: arte nova da direção",
  sheet_text: "Folha de quadros por imagem + referência (rota genérica; não é animação nativa)",
  sheet_skeleton: "Guia de poses em imagem + referência (rota genérica; não é esqueleto estruturado)",
  sheet_rotation: "Nova vista desenhada por imagem + referência (rota genérica; não é rotação nativa)",
} as const;

/**
 * Escolhe a rota pela capacidade declarada da operação: nativa quando o
 * perfil oferece a capacidade própria; senão, folha por imagem + referências
 * quando oferece referências; senão, bloqueia antes de cobrar.
 */
export function chooseRoute(
  adapter: ProviderAdapter,
  operation: PlanOperation,
  want: { mode: "text" | "skeleton" | "rotation"; customSkeleton?: boolean; isometric?: boolean; diagonal?: boolean },
  profileId: string,
): AnimationRoute {
  const offered = adapter.capabilities(operation);
  const native: Capability[] =
    want.mode === "text"
      ? ["text_animation"]
      : want.mode === "skeleton"
        ? ["skeleton_keypoints", ...(want.customSkeleton ? (["custom_skeleton"] as const) : [])]
        : [want.diagonal ? "rotation_8" : "rotation_4", ...(want.isometric ? (["isometric_views"] as const) : [])];
  if (native.every((c) => offered.includes(c))) {
    return { strategy: "native", required: native, label: want.mode === "text" ? ROUTE_LABELS.native_text : want.mode === "skeleton" ? ROUTE_LABELS.native_skeleton : ROUTE_LABELS.native_rotation };
  }
  const sheet: Capability[] = ["image_references", ...(want.isometric ? (["isometric_views"] as const) : [])];
  if (sheet.every((c) => offered.includes(c))) {
    return { strategy: "reference_sheet", required: sheet, label: want.mode === "text" ? ROUTE_LABELS.sheet_text : want.mode === "skeleton" ? ROUTE_LABELS.sheet_skeleton : ROUTE_LABELS.sheet_rotation };
  }
  const missing = native.filter((c) => !offered.includes(c));
  throw new DomainFailure(
    "capability_missing",
    want.isometric && offered.includes("image_references")
      ? `O perfil ${profileId} não qualifica vistas isométricas nesta operação; use um perfil que declare isometric_views (rotação nativa com vista isométrica)`
      : `O perfil ${profileId} não oferece ${missing.join(", ")} nem imagem + referências para ${operation}`,
    { missing, offered },
  );
}

/** IDs dos quadros do texto livre: estáveis e locais à revisão do clipe. */
export function textFrameIds(frames: number): string[] {
  return Array.from({ length: frames }, (_, i) => `f${String(i + 1).padStart(2, "0")}`);
}

/** Ação do texto livre (chave do clipe): derivada do próprio texto, deterministicamente. */
export function textActionKey(actionText: string): string {
  return slugify(actionText).slice(0, 40).replace(/_+$/, "") || "acao";
}

