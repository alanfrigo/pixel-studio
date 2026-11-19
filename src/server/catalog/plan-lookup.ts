import type { AssetFamily } from "@/contracts";
import { parsePresetRevisionId } from "@/domain/animation/presets";
import { canonicalDigest } from "@/domain/canonical-json";
import type { CatalogFile, CatalogRevision, PlanLookup } from "@/domain/plan/references";
import type { Db } from "../db/connection";

/** Adapta o catálogo SQLite à interface usada por `validatePlanReferences`. */
export function catalogLookup(db: Db): PlanLookup {
  return {
    revision(revisionId) {
      const style = db.get<{ id: string; project_id: string; status: string; payload_digest: string }>(
        "SELECT id, project_id, status, payload_digest FROM style_revisions WHERE id = :id",
        { id: revisionId },
      );
      if (style) {
        return {
          revisionId: style.id,
          projectId: style.project_id,
          family: "style",
          kind: "style",
          status: style.status === "approved" ? "approved" : "candidate",
          files: {},
          payloadDigest: style.payload_digest,
        } satisfies CatalogRevision;
      }
      const rev = db.get<{ id: string; project_id: string; family: AssetFamily; kind: string; status: CatalogRevision["status"]; payload_digest: string }>(
        `SELECT r.id, r.project_id, a.family, a.kind, r.status, r.payload_digest
         FROM asset_revisions r JOIN assets a ON a.id = r.asset_id WHERE r.id = :id`,
        { id: revisionId },
      );
      if (!rev) return presetRevision(db, revisionId);
      const files: Record<string, CatalogFile> = {};
      for (const f of db.all<{ file_key: string; sha256: string; metadata_json: string }>(
        `SELECT f.file_key, f.blob_sha256 AS sha256, b.metadata_json FROM revision_files f
         JOIN blobs b ON b.sha256 = f.blob_sha256 WHERE f.revision_id = :id`,
        { id: revisionId },
      )) {
        const meta = JSON.parse(f.metadata_json) as { width?: number; height?: number };
        files[f.file_key] = { sha256: f.sha256, ...(meta.width ? { width: meta.width, height: meta.height } : {}) };
      }
      return { revisionId: rev.id, projectId: rev.project_id, family: rev.family, kind: rev.kind, status: rev.status, files, payloadDigest: rev.payload_digest };
    },
    upload(fileId) {
      const up = db.get<{ id: string; project_id: string; sha256: string; metadata_json: string | null }>(
        `SELECT u.id, u.project_id, COALESCE(u.normalized_sha256, u.blob_sha256) AS sha256, u.metadata_json
         FROM uploads u WHERE u.id = :id AND u.status = 'ready'`,
        { id: fileId },
      );
      if (!up) return undefined;
      const meta = (up.metadata_json ? JSON.parse(up.metadata_json) : {}) as { width?: number; height?: number };
      return { fileId: up.id, projectId: up.project_id, sha256: up.sha256, ...(meta.width ? { width: meta.width, height: meta.height } : {}) };
    },
  };
}

/**
 * Preset de ação embutido e versionado (cartão S1), instanciado por projeto no
 * ID (`<projeto>:preset:<chave>:v<versão>`): aprovado por definição, com o
 * digest da definição congelada. Projeto inexistente = revisão inexistente.
 */
function presetRevision(db: Db, revisionId: string): CatalogRevision | undefined {
  const parsed = parsePresetRevisionId(revisionId);
  if (!parsed || !db.get<{ id: string }>("SELECT id FROM projects WHERE id = :p", { p: parsed.projectId })) return undefined;
  return { revisionId, projectId: parsed.projectId, family: "preset", kind: parsed.preset.key, status: "approved", files: {}, payloadDigest: canonicalDigest(parsed.preset) };
}
