import { fileModality, type Manifest, type ManifestEntry } from "@/contracts";
import { entryRefs } from "@/domain/manifest/refs";
import { validateManifest } from "@/domain/manifest/validate";
import { verifyManifestFiles } from "@/domain/manifest/verify-files";
import { readPngInfo } from "@/lib/media/png";
import type { ZipArchive } from "@/lib/zip";
import { type BlobRecord, createAsset, publishRevision, reviewRevision } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { inspectAudio, inspectFont } from "../media/inspect";
import type { BlobStore } from "../storage/blob-store";
import type { Clock } from "../util";

/**
 * Reabre um pacote portátil v1 num projeto (M1: "Exportar/reabrir ZIP").
 * Valida manifesto e bytes antes de gravar; cria um asset por (assetId, kind)
 * e publica as revisões em ordem de dependência, remapeando os IDs de revisão.
 * Revisões entram como candidatas (origem `import`), sujeitas à revisão do
 * artista, salvo `approve` explícito.
 */

export interface ImportResult {
  revisionMap: Record<string, string>;
  assetIds: string[];
}

const REVISION_KEY = /(RevisionIds?|^revisionId)$/;

function remapRevisionIds(value: unknown, map: Map<string, string>, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => remapRevisionIds(v, map, key));
  if (typeof value === "string" && REVISION_KEY.test(key)) return map.get(value) ?? value;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapRevisionIds(v, map, k)]));
  }
  return value;
}

/** Ordem em que cada revisão vem depois das revisões do pacote que ela cita. */
function importOrder(manifest: Manifest): ManifestEntry[] {
  const byId = new Map(manifest.entries.map((e) => [e.revisionId, e]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: ManifestEntry[] = [];
  const visit = (e: ManifestEntry) => {
    if (done.has(e.revisionId)) return;
    if (visiting.has(e.revisionId)) throw new DomainFailure("validation_failed", `Ciclo de referências em ${e.revisionId}`);
    visiting.add(e.revisionId);
    for (const ref of entryRefs(e).revisions) {
      const target = byId.get(ref.revisionId);
      if (target) visit(target);
    }
    visiting.delete(e.revisionId);
    done.add(e.revisionId);
    out.push(e);
  };
  manifest.entries.forEach(visit);
  return out;
}

function measuredMetadata(mime: string, bytes: Uint8Array): Record<string, unknown> {
  if (mime === "image/png") {
    const info = readPngInfo(bytes);
    return info ? { width: info.width, height: info.height } : {};
  }
  if (mime === "audio/wav") return { ...(inspectAudio(bytes, "wav") ?? {}) };
  if (mime.startsWith("font/")) return { ...(inspectFont(bytes) ?? {}) };
  return {};
}

export interface PreparedImport {
  manifest: Manifest;
  blobsByFileId: Map<string, BlobRecord>;
}

/** Valida manifesto e bytes e grava os blobs (fora de transação). */
export async function preparePortableImport(deps: { blobs: BlobStore }, archive: Pick<ZipArchive, "read" | "has">): Promise<PreparedImport> {
  if (!archive.has("manifest.json")) throw new DomainFailure("validation_failed", "Pacote sem manifest.json na raiz");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(archive.read("manifest.json")));
  } catch {
    throw new DomainFailure("validation_failed", "manifest.json não é JSON válido");
  }
  const validation = validateManifest(raw);
  if (!validation.ok || !validation.manifest) {
    throw new DomainFailure("validation_failed", validation.issues[0]?.message ?? "Manifesto inválido", { issues: validation.issues.slice(0, 20) });
  }
  const manifest = validation.manifest;
  const fileIssues = await verifyManifestFiles(manifest, async (p) => archive.read(p));
  if (fileIssues.length > 0) throw new DomainFailure("validation_failed", fileIssues[0]!.message, { issues: fileIssues });

  const blobsByFileId = new Map<string, BlobRecord>();
  for (const file of manifest.files) {
    const bytes = archive.read(file.path);
    const stored = await deps.blobs.putBytes(bytes);
    blobsByFileId.set(file.fileId, {
      sha256: stored.sha256,
      bytes: stored.bytes,
      mime: file.mime,
      modality: fileModality(file),
      metadata: { ...measuredMetadata(file.mime, bytes), importedPath: file.path },
    });
  }
  return { manifest, blobsByFileId };
}

/** Cria assets e publica revisões numa transação (síncrona; pode ir dentro de `queue.succeed`). */
export function commitPortableImport(
  deps: { db: Db; clock: Clock },
  projectId: string,
  prepared: PreparedImport,
  opts: { approve?: boolean } = {},
): ImportResult {
  const { manifest, blobsByFileId } = prepared;
  return deps.db.transaction(() => {
    const revisionMap = new Map<string, string>();
    const assets = new Map<string, string>();
    for (const entry of importOrder(manifest)) {
      const assetKey = `${entry.assetId}|${entry.kind}`;
      let assetId = assets.get(assetKey);
      if (!assetId) {
        const name = entry.name ?? (manifest.entries.filter((e) => e.assetId === entry.assetId).length > 1 ? `${entry.assetId} (${entry.kind})` : entry.assetId);
        assetId = createAsset(deps.db, deps.clock, { projectId, family: entry.family, kind: entry.kind, name: name.slice(0, 120) }).id;
        assets.set(assetKey, assetId);
      }
      const files = [...new Set(entryRefs(entry).files.map((f) => f.fileId))].map((fileId, idx) => ({
        fileKey: fileId,
        role: "original",
        idx,
        blob: blobsByFileId.get(fileId)!,
      }));
      const revision = publishRevision(deps.db, deps.clock, {
        projectId,
        assetId,
        payload: remapRevisionIds(entry.payload, revisionMap),
        origin: "import",
        styleRevisionId: null,
        files,
        technicalReport: { importedFrom: { projectId: manifest.projectId, revisionId: entry.revisionId, profile: manifest.profile } },
      });
      revisionMap.set(entry.revisionId, revision.id);
      if (opts.approve) {
        reviewRevision(deps.db, deps.clock, {
          projectId,
          assetId,
          revisionId: revision.id,
          decision: "approve",
          reason: "Importado de pacote aprovado",
          expectedActiveRevisionId: deps.db.get<{ a: string | null }>("SELECT approved_revision_id AS a FROM assets WHERE id = :id", { id: assetId })?.a ?? null,
        });
      }
    }
    return { revisionMap: Object.fromEntries(revisionMap), assetIds: [...assets.values()] };
  });
}

export async function importPortablePackage(
  deps: { db: Db; clock: Clock; blobs: BlobStore },
  projectId: string,
  archive: Pick<ZipArchive, "read" | "has">,
  opts: { approve?: boolean } = {},
): Promise<ImportResult> {
  return commitPortableImport(deps, projectId, await preparePortableImport(deps, archive), opts);
}
