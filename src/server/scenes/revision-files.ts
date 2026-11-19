import { type ManifestEntry, parseRevisionPayload } from "@/contracts";
import { tx } from "@/i18n/locales";
import { entryRefs } from "@/domain/manifest/refs";
import { type BlobRecord, getBlob, type PublishFile, type RevisionView } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";

/** Blob registrado de um arquivo de revisão. */
export function fileBlob(db: Db, sha256: string): BlobRecord {
  const blob = getBlob(db, sha256);
  if (!blob) throw new DomainFailure("internal", tx(`Blob ${sha256} sem registro`, `Blob ${sha256} is not registered`));
  return blob;
}

/**
 * Arquivos da revisão-base que seguem para a nova revisão do mesmo asset: os
 * citados pelo novo payload e os auxiliares pedidos (resposta bruta, guia da
 * planta), sem os que serão substituídos.
 */
export function carryFiles(db: Db, base: RevisionView, family: ManifestEntry["family"], kind: string, payload: unknown, o: { keep?: (fileKey: string) => boolean; skip?: readonly string[] } = {}): PublishFile[] {
  const parsed = parseRevisionPayload(family, kind, payload);
  if (!parsed.success) throw new DomainFailure("validation_failed", tx("Payload derivado não passa no schema", "The derived payload does not match the schema"), { issues: parsed.issues.slice(0, 10) });
  const cited = new Set(entryRefs(parsed.entry).files.map((f) => f.fileId));
  return base.files
    .filter((f) => (cited.has(f.fileKey) || o.keep?.(f.fileKey)) && !o.skip?.includes(f.fileKey))
    .map((f) => ({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: fileBlob(db, f.sha256) }));
}

/** Auxiliares de uma sala que sempre acompanham as revisões derivadas (proveniência). */
export const ROOM_PROVENANCE_FILES = (key: string) => key === "raw" || key === "guide";
