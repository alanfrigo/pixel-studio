import type { BasePayload, ClipPayload, LoadoutPayload, OverlayPayload, RigPayload } from "@/contracts";
import type { ClipRef, OverlayRef, RevisionStatus, RigRef } from "@/domain/equipment/types";
import { type AssetView, getAsset, getRevision, type RevisionView } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { tx } from "@/i18n/locales";
import { DomainFailure } from "../errors";

/**
 * Leitura do catálogo para o cartão S2: rigs, clipes, peças e conjuntos como
 * referências tipadas para o domínio (`@/domain/equipment`). Só leitura.
 */

interface Row {
  id: string;
  asset_id: string;
  number: number;
  status: RevisionStatus;
  payload_json: string;
  style_revision_id: string | null;
  name: string;
  approved_revision_id: string | null;
}

function rows(db: Db, projectId: string, kind: "rig" | "clip" | "overlay" | "loadout" | "base"): Row[] {
  const family = kind === "overlay" || kind === "loadout" ? "equipment" : "character";
  return db.all<Row>(
    `SELECT r.id, r.asset_id, r.number, r.status, r.payload_json, r.style_revision_id, a.name, a.approved_revision_id
     FROM asset_revisions r JOIN assets a ON a.id = r.asset_id
     WHERE r.project_id = :p AND a.family = :family AND a.kind = :kind AND a.archived_at IS NULL
     ORDER BY a.name, r.number`,
    { p: projectId, family, kind },
  );
}

export interface RigEntry {
  ref: RigRef;
  assetId: string;
  name: string;
  number: number;
  base: { revisionId: string; name: string; payload: BasePayload } | null;
}

/** Rigs ativos (revisão aprovada vigente de cada asset de rig). */
export function listRigs(db: Db, projectId: string): RigEntry[] {
  return rows(db, projectId, "rig")
    .filter((r) => r.id === r.approved_revision_id)
    .map((r) => {
      const payload = JSON.parse(r.payload_json) as RigPayload;
      const baseRow = db.get<{ payload_json: string; name: string }>(
        "SELECT r.payload_json, a.name FROM asset_revisions r JOIN assets a ON a.id = r.asset_id WHERE r.id = :id AND r.project_id = :p",
        { id: payload.baseRevisionId, p: projectId },
      );
      return {
        ref: { revisionId: r.id, payload },
        assetId: r.asset_id,
        name: r.name,
        number: r.number,
        base: baseRow ? { revisionId: payload.baseRevisionId, name: baseRow.name, payload: JSON.parse(baseRow.payload_json) as BasePayload } : null,
      };
    });
}

export function loadRig(db: Db, projectId: string, rigRevisionId: string): RigEntry {
  const rev = getRevision(db, projectId, rigRevisionId);
  const asset = getAsset(db, projectId, rev.assetId);
  if (asset.family !== "character" || asset.kind !== "rig") throw new DomainFailure("validation_failed", tx(`${asset.name} não é um rig de equipamento`, `${asset.name} is not an equipment rig`));
  const payload = rev.payload as RigPayload;
  let base: RigEntry["base"] = null;
  try {
    const b = getRevision(db, projectId, payload.baseRevisionId);
    base = { revisionId: b.id, name: getAsset(db, projectId, b.assetId).name, payload: b.payload as BasePayload };
  } catch {
    base = null;
  }
  return { ref: { revisionId: rev.id, payload }, assetId: asset.id, name: asset.name, number: rev.number, base };
}

/** Todas as revisões de clipe do projeto (qualquer estado), com o flag de ativa. */
export function listClips(db: Db, projectId: string, rigRevisionId?: string): ClipRef[] {
  return rows(db, projectId, "clip")
    .map((r) => ({
      revisionId: r.id,
      assetId: r.asset_id,
      name: r.name,
      number: r.number,
      status: r.status,
      active: r.id === r.approved_revision_id,
      payload: JSON.parse(r.payload_json) as ClipPayload,
    }))
    .filter((c) => !rigRevisionId || c.payload.rigRevisionId === rigRevisionId);
}

export function listOverlays(db: Db, projectId: string): (OverlayRef & { active: boolean })[] {
  return rows(db, projectId, "overlay").map((r) => ({
    revisionId: r.id,
    assetId: r.asset_id,
    name: r.name,
    number: r.number,
    status: r.status,
    styleRevisionId: r.style_revision_id,
    active: r.id === r.approved_revision_id,
    payload: JSON.parse(r.payload_json) as OverlayPayload,
  }));
}

export function loadOverlay(db: Db, projectId: string, overlayRevisionId: string): OverlayRef & { revision: RevisionView; asset: AssetView } {
  const revision = getRevision(db, projectId, overlayRevisionId);
  const asset = getAsset(db, projectId, revision.assetId);
  if (asset.family !== "equipment" || asset.kind !== "overlay") throw new DomainFailure("validation_failed", tx(`${asset.name} não é uma peça (equipment/overlay)`, `${asset.name} is not a piece (equipment/overlay)`));
  return {
    revisionId: revision.id,
    assetId: asset.id,
    name: asset.name,
    number: revision.number,
    status: revision.status,
    styleRevisionId: revision.styleRevisionId,
    payload: revision.payload as OverlayPayload,
    revision,
    asset,
  };
}

export interface LoadoutEntry {
  revisionId: string;
  assetId: string;
  name: string;
  number: number;
  status: RevisionStatus;
  active: boolean;
  payload: LoadoutPayload;
}

export function listLoadouts(db: Db, projectId: string): LoadoutEntry[] {
  return rows(db, projectId, "loadout").map((r) => ({
    revisionId: r.id,
    assetId: r.asset_id,
    name: r.name,
    number: r.number,
    status: r.status,
    active: r.id === r.approved_revision_id,
    payload: JSON.parse(r.payload_json) as LoadoutPayload,
  }));
}

export function loadLoadout(db: Db, projectId: string, loadoutRevisionId: string): LoadoutEntry & { revision: RevisionView; asset: AssetView } {
  const revision = getRevision(db, projectId, loadoutRevisionId);
  const asset = getAsset(db, projectId, revision.assetId);
  if (asset.family !== "equipment" || asset.kind !== "loadout") throw new DomainFailure("validation_failed", tx(`${asset.name} não é um conjunto (equipment/loadout)`, `${asset.name} is not a loadout (equipment/loadout)`));
  return {
    revisionId: revision.id,
    assetId: asset.id,
    name: asset.name,
    number: revision.number,
    status: revision.status,
    active: asset.approvedRevisionId === revision.id,
    payload: revision.payload as LoadoutPayload,
    revision,
    asset,
  };
}

/** ID servível (`GET /media/{fileId}`) do arquivo `fileKey` de uma revisão. */
export function mediaIdOf(db: Db, revisionId: string, fileKey: string): string | null {
  return db.get<{ id: string }>("SELECT id FROM revision_files WHERE revision_id = :r AND file_key = :k", { r: revisionId, k: fileKey })?.id ?? null;
}

/** Blob (sha256) do arquivo `fileKey` de uma revisão. */
export function blobOf(db: Db, revisionId: string, fileKey: string): string {
  const row = db.get<{ sha: string }>("SELECT blob_sha256 AS sha FROM revision_files WHERE revision_id = :r AND file_key = :k", { r: revisionId, k: fileKey });
  if (!row) throw new DomainFailure("internal", tx(`Revisão ${revisionId} sem o arquivo ${fileKey}`, `Revision ${revisionId} has no file ${fileKey}`));
  return row.sha;
}
