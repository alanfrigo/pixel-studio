import { type AssetFamily, type Manifest, type ManifestEntry, type ManifestFile, parseRevisionPayload } from "@/contracts";
import { entryRefs } from "@/domain/manifest/refs";
import { validateManifest } from "@/domain/manifest/validate";
import { readPngInfo } from "@/lib/media/png";
import { getAsset, getRevision } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { inspectAudio, inspectFont, sniff } from "../media/inspect";
import type { BlobStore } from "../storage/blob-store";
import { slugify } from "../util";
import { EXPORT_PROFILES } from "./profiles";
import { equipmentExportProblems, exportProblemMessage } from "../equipment/export-check";

/**
 * Montagem do pacote portátil v1 a partir de revisões aprovadas (02a §formato
 * portátil, 08 · X1). O fecho segue as arestas runtime; arquivos são medidos
 * pelos bytes; o manifesto passa pelo mesmo validador que um leitor usaria.
 */

export interface ClosureProblem {
  code: "not_found" | "not_approved";
  revisionId: string;
  message: string;
  /** Revisão que exige esta dependência (`null` = selecionada diretamente). */
  requiredBy: string | null;
}

export interface Closure {
  /** Revisões em ordem topológica: dependências antes de quem depende delas. */
  revisionIds: string[];
  added: string[];
  problems: ClosureProblem[];
}

interface ClosureRow {
  id: string;
  status: string;
  number: number;
  asset_name: string;
}

export function resolveClosure(db: Db, projectId: string, selected: string[]): Closure {
  const problems: ClosureProblem[] = [];
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const unique = [...new Set(selected)];

  const visit = (id: string, requiredBy: string | null) => {
    if (state.has(id)) return; // ciclos já são impedidos na publicação; "visiting" aqui só encerra a recursão
    state.set(id, "visiting");
    const row = db.get<ClosureRow>(
      `SELECT r.id, r.status, r.number, a.name AS asset_name FROM asset_revisions r JOIN assets a ON a.id = r.asset_id
       WHERE r.id = :id AND r.project_id = :p`,
      { id, p: projectId },
    );
    if (!row) {
      problems.push({ code: "not_found", revisionId: id, requiredBy, message: `Revisão ${id} não existe neste projeto` });
      state.set(id, "done");
      return;
    }
    if (row.status !== "approved") {
      problems.push({
        code: "not_approved",
        revisionId: id,
        requiredBy,
        message: `${row.asset_name} r${row.number} está ${row.status === "candidate" ? "aguardando revisão" : "reprovada"}; só revisões aprovadas entram no pacote`,
      });
    }
    const deps = db.all<{ to_revision_id: string }>(
      "SELECT to_revision_id FROM revision_edges WHERE from_revision_id = :id AND runtime = 1 ORDER BY role, ordinal",
      { id },
    );
    for (const d of deps) visit(d.to_revision_id, id);
    state.set(id, "done");
    order.push(id);
  };
  for (const id of unique) visit(id, null);
  return { revisionIds: order, added: order.filter((id) => !unique.includes(id)), problems };
}

export interface PackageFile {
  path: string;
  bytes: Uint8Array;
  compress: boolean;
}

export interface ExportReport {
  profile: string;
  profileVersion: number;
  selected: string[];
  addedDependencies: string[];
  entries: number;
  files: number;
  totalBytes: number;
  families: Partial<Record<AssetFamily, number>>;
  supports: string[];
  limitations: string[];
}

const FAMILY_DIRS: Record<AssetFamily, string> = {
  character: "characters",
  item: "items",
  equipment: "equipment",
  vfx: "vfx",
  texture: "textures",
  tileset: "tilesets",
  ui: "ui",
  portrait: "portraits",
  font: "fonts",
  audio: "audio",
  map: "maps",
};

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "audio/wav": "wav",
  "font/ttf": "ttf",
  "font/otf": "otf",
};

/** Substitui todo `fileId` (chave local da revisão) pelo ID do arquivo no pacote. */
function rewriteFileIds(value: unknown, map: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteFileIds(v, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (k === "fileId" && typeof v === "string") {
          const mapped = map.get(v);
          if (!mapped) throw new DomainFailure("internal", `Arquivo ${v} sem vínculo na revisão`);
          return [k, mapped];
        }
        return [k, rewriteFileIds(v, map)];
      }),
    );
  }
  return value;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type MeasuredFile = DistributiveOmit<ManifestFile, "fileId" | "path" | "bytes" | "sha256">;

async function measure(bytes: Uint8Array, path: string): Promise<MeasuredFile> {
  const kind = sniff(bytes);
  if (kind?.mime === "image/png") {
    const info = readPngInfo(bytes)!;
    return { mime: "image/png", width: info.width, height: info.height };
  }
  if (kind?.mime === "audio/wav") {
    const audio = inspectAudio(bytes, "wav");
    if (audio) return { mime: "audio/wav", ...audio };
  }
  if (kind?.modality === "font") {
    const font = inspectFont(bytes);
    if (font) return { mime: kind.mime as "font/ttf" | "font/otf", glyphCount: font.glyphCount };
  }
  throw new DomainFailure("validation_failed", `${path}: formato não suportado pelo perfil portable-v1 (PNG, WAV, TTF/OTF)`);
}

export async function buildPortablePackage(db: Db, blobs: BlobStore, projectId: string, selected: string[]) {
  const closure = resolveClosure(db, projectId, selected);
  if (closure.problems.length > 0) {
    throw new DomainFailure("coverage_incomplete", closure.problems[0]!.message, { problems: closure.problems });
  }
  const equipment = equipmentExportProblems(db, projectId, closure.revisionIds);
  if (equipment.length > 0) throw new DomainFailure("coverage_incomplete", exportProblemMessage(equipment), { problems: equipment });

  const files: ManifestFile[] = [];
  const contents: PackageFile[] = [];
  const bySha = new Map<string, string>();
  const usedPaths = new Set<string>();
  const entries: ManifestEntry[] = [];
  const families: Partial<Record<AssetFamily, number>> = {};

  for (const revisionId of closure.revisionIds) {
    const rev = getRevision(db, projectId, revisionId);
    const asset = getAsset(db, projectId, rev.assetId);
    const parsed = parseRevisionPayload(asset.family, asset.kind, rev.payload);
    if (!parsed.success) throw new DomainFailure("internal", `Payload de ${rev.id} não passa mais no schema`, { issues: parsed.issues });

    const fileMap = new Map<string, string>();
    for (const ref of entryRefs(parsed.entry).files) {
      if (fileMap.has(ref.fileId)) continue;
      const link = rev.files.find((f) => f.fileKey === ref.fileId);
      if (!link) throw new DomainFailure("internal", `Revisão ${rev.id} cita ${ref.fileId} sem arquivo vinculado`);
      const existing = bySha.get(link.sha256);
      if (existing) {
        fileMap.set(ref.fileId, existing);
        continue;
      }
      const bytes = await blobs.read(link.sha256);
      const base = `${slugify(asset.name).replaceAll("_", "-")}-r${rev.number}-${slugify(link.fileKey).replaceAll("_", "-")}`;
      const measured = await measure(bytes, base);
      let fileId = base;
      let path = `${FAMILY_DIRS[asset.family]}/${base}.${EXTENSIONS[measured.mime]}`;
      for (let n = 2; usedPaths.has(path.toLowerCase()); n++) {
        fileId = `${base}-${n}`;
        path = `${FAMILY_DIRS[asset.family]}/${fileId}.${EXTENSIONS[measured.mime]}`;
      }
      usedPaths.add(path.toLowerCase());
      bySha.set(link.sha256, fileId);
      fileMap.set(ref.fileId, fileId);
      files.push({ fileId, path, bytes: bytes.length, sha256: link.sha256, ...measured } as ManifestFile);
      contents.push({ path, bytes, compress: measured.mime.startsWith("font/") });
    }

    const dependencies = db.all<{ revisionId: string; role: string }>(
      `SELECT to_revision_id AS revisionId, role FROM revision_edges WHERE from_revision_id = :id AND runtime = 1 ORDER BY role, ordinal`,
      { id: rev.id },
    );
    entries.push({
      assetId: asset.id,
      revisionId: rev.id,
      family: asset.family,
      kind: asset.kind,
      name: asset.name,
      dependencies,
      payload: rewriteFileIds(parsed.entry.payload, fileMap),
    } as ManifestEntry);
    families[asset.family] = (families[asset.family] ?? 0) + 1;
  }

  const profile = EXPORT_PROFILES["portable-v1"];
  const manifest: Manifest = {
    schemaVersion: 1,
    projectId,
    profile: "portable-v1",
    generator: { name: "pixel-studio", version: "0.1.0" },
    files,
    entries,
  };
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    throw new DomainFailure("internal", "Manifesto gerado não passou na validação do formato v1", { issues: validation.issues.slice(0, 20) });
  }
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const report: ExportReport = {
    profile: profile.id,
    profileVersion: profile.version,
    selected: [...new Set(selected)],
    addedDependencies: closure.added,
    entries: entries.length,
    files: files.length,
    totalBytes: contents.reduce((n, c) => n + c.bytes.length, 0) + manifestBytes.length,
    families,
    supports: profile.supports,
    limitations: profile.limitations,
  };
  return {
    manifest,
    report,
    files: [{ path: "manifest.json", bytes: manifestBytes, compress: true }, ...contents] satisfies PackageFile[],
  };
}
