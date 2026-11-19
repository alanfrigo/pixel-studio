import {
  type AssetFamily,
  type FileModality,
  isKnownKind,
  type ManifestEntry,

  parseRevisionPayload,
  StylePayload,
} from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { entryRefs } from "@/domain/manifest/refs";
import { defaultStyle } from "@/domain/style-presets";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { type Clock, iso, newId, parseJson } from "../util";

/**
 * Catálogo do projeto (02a §modelo lógico e §ciclo de autoria): projetos,
 * revisões de estilo, assets, revisões imutáveis, pareceres e rascunhos.
 * Leitores só veem revisões publicadas; publicar e aprovar são transacionais.
 */

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

export interface BlobRecord {
  sha256: string;
  bytes: number;
  mime: string;
  modality: FileModality;
  metadata: Record<string, unknown>;
}

/**
 * Registra um blob. Metadados são fatos medidos sobre os mesmos bytes: um
 * registro posterior (ex.: dimensões medidas na normalização) é mesclado, não
 * descartado — o mesmo conteúdo pode chegar primeiro como upload e depois
 * como derivado normalizado idêntico.
 */
export function recordBlob(db: Db, clock: Clock, blob: BlobRecord): void {
  db.run(
    `INSERT INTO blobs (sha256, bytes, mime, modality, metadata_json, created_at)
     VALUES (:sha, :bytes, :mime, :modality, :meta, :now)
     ON CONFLICT (sha256) DO UPDATE SET metadata_json = json_patch(blobs.metadata_json, excluded.metadata_json)`,
    { sha: blob.sha256, bytes: blob.bytes, mime: blob.mime, modality: blob.modality, meta: JSON.stringify(blob.metadata), now: iso(clock.now()) },
  );
}

interface BlobRow {
  sha256: string;
  bytes: number;
  mime: string;
  modality: FileModality;
  metadata_json: string;
}

export function getBlob(db: Db, sha256: string): BlobRecord | undefined {
  const row = db.get<BlobRow>("SELECT * FROM blobs WHERE sha256 = :sha", { sha: sha256 });
  return row && { sha256: row.sha256, bytes: row.bytes, mime: row.mime, modality: row.modality, metadata: JSON.parse(row.metadata_json) };
}

// ---------------------------------------------------------------------------
// Projetos e estilo
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  active_style_revision_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectView {
  id: string;
  name: string;
  activeStyleRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

const projectView = (r: ProjectRow): ProjectView => ({
  id: r.id,
  name: r.name,
  activeStyleRevisionId: r.active_style_revision_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createProject(db: Db, clock: Clock, input: { name: string; style?: StylePayload }): ProjectView {
  const style = StylePayload.parse(input.style ?? defaultStyle());
  return db.transaction(() => {
    const id = newId("prj");
    const styleId = newId("sty");
    const now = iso(clock.now());
    db.run("INSERT INTO projects (id, name, active_style_revision_id, created_at, updated_at) VALUES (:id, :name, :style, :now, :now)", {
      id,
      name: input.name,
      style: styleId,
      now,
    });
    db.run(
      `INSERT INTO style_revisions (id, project_id, number, status, payload_json, payload_digest, created_at, approved_at)
       VALUES (:id, :p, 1, 'approved', :payload, :digest, :now, :now)`,
      { id: styleId, p: id, payload: JSON.stringify(style), digest: canonicalDigest(style), now },
    );
    return getProject(db, id);
  });
}

export function listProjects(db: Db): ProjectView[] {
  return db.all<ProjectRow>("SELECT * FROM projects ORDER BY updated_at DESC").map(projectView);
}

export function getProject(db: Db, projectId: string): ProjectView {
  const row = db.get<ProjectRow>("SELECT * FROM projects WHERE id = :id", { id: projectId });
  if (!row) throw new DomainFailure("not_found", "Projeto não encontrado");
  return projectView(row);
}

export interface StyleRevisionView {
  id: string;
  projectId: string;
  number: number;
  status: string;
  payload: StylePayload;
  payloadDigest: string;
  createdAt: string;
}

export function getStyleRevision(db: Db, projectId: string, styleRevisionId: string): StyleRevisionView {
  const row = db.get<{ id: string; project_id: string; number: number; status: string; payload_json: string; payload_digest: string; created_at: string }>(
    "SELECT * FROM style_revisions WHERE id = :id AND project_id = :p",
    { id: styleRevisionId, p: projectId },
  );
  if (!row) throw new DomainFailure("not_found", "Revisão de estilo não encontrada neste projeto");
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    status: row.status,
    payload: JSON.parse(row.payload_json),
    payloadDigest: row.payload_digest,
    createdAt: row.created_at,
  };
}

/**
 * Nova revisão do guia de estilo, aprovada e ativa. Revisões antigas ficam
 * (assets já publicados apontam para elas); a edição concorrente é recusada.
 */
export function publishStyleRevision(db: Db, clock: Clock, projectId: string, input: { payload: unknown; expectedActiveStyleRevisionId: string | null }): StyleRevisionView {
  const style = StylePayload.parse(input.payload);
  return db.transaction(() => {
    const project = getProject(db, projectId);
    if (project.activeStyleRevisionId !== input.expectedActiveStyleRevisionId) {
      throw new DomainFailure("revision_conflict", "O guia de estilo mudou em outra aba; recarregue antes de salvar");
    }
    const digest = canonicalDigest(style);
    if (project.activeStyleRevisionId && getStyleRevision(db, projectId, project.activeStyleRevisionId).payloadDigest === digest) {
      return getStyleRevision(db, projectId, project.activeStyleRevisionId); // nada mudou
    }
    const number = (db.get<{ n: number }>("SELECT COALESCE(MAX(number), 0) AS n FROM style_revisions WHERE project_id = :p", { p: projectId })?.n ?? 0) + 1;
    const id = newId("sty");
    const now = iso(clock.now());
    db.run(
      `INSERT INTO style_revisions (id, project_id, number, status, payload_json, payload_digest, created_at, approved_at)
       VALUES (:id, :p, :n, 'approved', :payload, :digest, :now, :now)`,
      { id, p: projectId, n: number, payload: JSON.stringify(style), digest, now },
    );
    db.run("UPDATE projects SET active_style_revision_id = :id, updated_at = :now WHERE id = :p", { id, p: projectId, now });
    return getStyleRevision(db, projectId, id);
  });
}

// ---------------------------------------------------------------------------
// Assets e revisões
// ---------------------------------------------------------------------------

interface AssetRow {
  id: string;
  project_id: string;
  family: AssetFamily;
  kind: string;
  name: string;
  approved_revision_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetView {
  id: string;
  projectId: string;
  family: AssetFamily;
  kind: string;
  name: string;
  approvedRevisionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const assetView = (r: AssetRow): AssetView => ({
  id: r.id,
  projectId: r.project_id,
  family: r.family,
  kind: r.kind,
  name: r.name,
  approvedRevisionId: r.approved_revision_id,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createAsset(db: Db, clock: Clock, input: { projectId: string; family: AssetFamily; kind: string; name: string }): AssetView {
  if (!isKnownKind(input.family, input.kind)) {
    throw new DomainFailure("validation_failed", `Tipo ${input.kind} não existe na família ${input.family}`);
  }
  return db.transaction(() => {
    getProject(db, input.projectId);
    const id = newId("ast");
    const now = iso(clock.now());
    db.run(
      `INSERT INTO assets (id, project_id, family, kind, name, created_at, updated_at)
       VALUES (:id, :p, :family, :kind, :name, :now, :now)`,
      { id, p: input.projectId, family: input.family, kind: input.kind, name: input.name, now },
    );
    return getAsset(db, input.projectId, id);
  });
}

export function getAsset(db: Db, projectId: string, assetId: string): AssetView {
  const row = db.get<AssetRow>("SELECT * FROM assets WHERE id = :id AND project_id = :p", { id: assetId, p: projectId });
  if (!row) throw new DomainFailure("not_found", "Asset não encontrado neste projeto");
  return assetView(row);
}

export function listAssets(db: Db, projectId: string, filter: { family?: AssetFamily } = {}): AssetView[] {
  return db
    .all<AssetRow>(
      `SELECT * FROM assets WHERE project_id = :p AND (:family IS NULL OR family = :family) AND archived_at IS NULL
       ORDER BY updated_at DESC`,
      { p: projectId, family: filter.family ?? null },
    )
    .map(assetView);
}

interface RevisionRow {
  id: string;
  asset_id: string;
  project_id: string;
  number: number;
  predecessor_id: string | null;
  style_revision_id: string | null;
  status: "candidate" | "approved" | "rejected";
  schema_version: number;
  payload_json: string;
  payload_digest: string;
  origin: string;
  job_attempt_id: string | null;
  technical_report_json: string | null;
  created_at: string;
}

export interface RevisionFileView {
  id: string;
  role: string;
  idx: number;
  fileKey: string;
  sha256: string;
  mime: string;
  bytes: number;
  metadata: Record<string, unknown>;
}

export interface RevisionView {
  id: string;
  assetId: string;
  projectId: string;
  number: number;
  status: RevisionRow["status"];
  predecessorId: string | null;
  styleRevisionId: string | null;
  payload: unknown;
  payloadDigest: string;
  origin: string;
  jobAttemptId: string | null;
  technicalReport: unknown;
  createdAt: string;
  files: RevisionFileView[];
}

function revisionView(db: Db, r: RevisionRow): RevisionView {
  const files = db.all<{ id: string; role: string; idx: number; file_key: string; blob_sha256: string; mime: string; bytes: number; metadata_json: string }>(
    `SELECT f.id, f.role, f.idx, f.file_key, f.blob_sha256, b.mime, b.bytes, b.metadata_json
     FROM revision_files f JOIN blobs b ON b.sha256 = f.blob_sha256 WHERE f.revision_id = :id ORDER BY f.role, f.idx`,
    { id: r.id },
  );
  return {
    id: r.id,
    assetId: r.asset_id,
    projectId: r.project_id,
    number: r.number,
    status: r.status,
    predecessorId: r.predecessor_id,
    styleRevisionId: r.style_revision_id,
    payload: JSON.parse(r.payload_json),
    payloadDigest: r.payload_digest,
    origin: r.origin,
    jobAttemptId: r.job_attempt_id,
    technicalReport: parseJson(r.technical_report_json),
    createdAt: r.created_at,
    files: files.map((f) => ({
      id: f.id,
      role: f.role,
      idx: f.idx,
      fileKey: f.file_key,
      sha256: f.blob_sha256,
      mime: f.mime,
      bytes: f.bytes,
      metadata: JSON.parse(f.metadata_json),
    })),
  };
}

export function listRevisions(db: Db, projectId: string, assetId: string): RevisionView[] {
  getAsset(db, projectId, assetId);
  return db
    .all<RevisionRow>("SELECT * FROM asset_revisions WHERE asset_id = :a ORDER BY number DESC", { a: assetId })
    .map((r) => revisionView(db, r));
}

export function getRevision(db: Db, projectId: string, revisionId: string): RevisionView {
  const row = db.get<RevisionRow>("SELECT * FROM asset_revisions WHERE id = :id AND project_id = :p", { id: revisionId, p: projectId });
  if (!row) throw new DomainFailure("not_found", "Revisão não encontrada neste projeto");
  return revisionView(db, row);
}

export interface PublishFile {
  /** `fileId` citado no payload (ou papel auxiliar, como `raw`). */
  fileKey: string;
  role: string;
  idx: number;
  blob: BlobRecord;
}

export interface PublishRevisionInput {
  projectId: string;
  assetId: string;
  payload: unknown;
  origin: "import" | "generation" | "edit" | "composition" | "local_process";
  styleRevisionId: string | null;
  predecessorId?: string | null;
  jobAttemptId?: string | null;
  technicalReport?: Record<string, unknown> | null;
  files: PublishFile[];
  edges?: { toRevisionId: string; role: string; ordinal: number; runtime: boolean }[];
}

/**
 * Publica uma revisão CANDIDATA imutável. Bytes já devem estar promovidos no
 * armazenamento; aqui só se gravam vínculos, numa transação curta.
 */
export function publishRevision(db: Db, clock: Clock, input: PublishRevisionInput): RevisionView {
  return db.transaction(() => {
    const asset = getAsset(db, input.projectId, input.assetId);
    if (asset.archivedAt) throw new DomainFailure("validation_failed", "Asset arquivado não recebe revisões");
    const parsed = parseRevisionPayload(asset.family, asset.kind, input.payload);
    if (!parsed.success) {
      throw new DomainFailure("validation_failed", "Payload incompatível com o tipo do asset", { issues: parsed.issues.slice(0, 20) });
    }

    // Todo arquivo citado no payload precisa de vínculo; retângulos cabem na imagem.
    const byKey = new Map(input.files.map((f) => [f.fileKey, f]));
    for (const ref of entryRefs(parsed.entry).files) {
      const file = byKey.get(ref.fileId);
      if (!file) throw new DomainFailure("validation_failed", `Payload cita arquivo sem vínculo: ${ref.fileId}`);
      if (file.blob.modality !== ref.modality) {
        throw new DomainFailure("validation_failed", `${ref.fileId} é ${file.blob.modality}; esperado ${ref.modality}`);
      }
      const { width, height } = file.blob.metadata as { width?: number; height?: number };
      if (ref.rect && width && height && (ref.rect[0] + ref.rect[2] > width || ref.rect[1] + ref.rect[3] > height)) {
        throw new DomainFailure("validation_failed", `Retângulo [${ref.rect.join(", ")}] excede ${width}×${height} de ${ref.fileId}`);
      }
    }

    const number = (db.get<{ n: number }>("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM asset_revisions WHERE asset_id = :a", { a: asset.id })?.n ?? 1);
    const id = newId("rev");
    const now = iso(clock.now());
    db.run(
      `INSERT INTO asset_revisions (id, asset_id, project_id, number, predecessor_id, style_revision_id, status, schema_version,
         payload_json, payload_digest, origin, job_attempt_id, technical_report_json, created_at)
       VALUES (:id, :asset, :p, :n, :pred, :style, 'candidate', 1, :payload, :digest, :origin, :attempt, :report, :now)`,
      {
        id,
        asset: asset.id,
        p: input.projectId,
        n: number,
        pred: input.predecessorId ?? asset.approvedRevisionId,
        style: input.styleRevisionId,
        payload: JSON.stringify(parsed.entry.payload),
        digest: canonicalDigest(parsed.entry.payload),
        origin: input.origin,
        attempt: input.jobAttemptId ?? null,
        report: input.technicalReport ? JSON.stringify(input.technicalReport) : null,
        now,
      },
    );
    for (const f of input.files) {
      recordBlob(db, clock, f.blob);
      db.run(
        `INSERT INTO revision_files (id, revision_id, project_id, role, idx, file_key, blob_sha256)
         VALUES (:id, :rev, :p, :role, :idx, :key, :sha)`,
        { id: newId("fil"), rev: id, p: input.projectId, role: f.role, idx: f.idx, key: f.fileKey, sha: f.blob.sha256 },
      );
    }
    for (const e of collectEdges(parsed.entry, input.edges ?? [])) {
      const target = db.get<{ id: string }>("SELECT id FROM asset_revisions WHERE id = :id AND project_id = :p", { id: e.toRevisionId, p: input.projectId });
      if (!target) {
        // Vínculo editorial do payload pode apontar para fora (ex.: pacote reaberto sem a origem): fica só como proveniência.
        if (e.derived && !e.runtime) continue;
        throw new DomainFailure("validation_failed", `Payload cita revisão inexistente neste projeto: ${e.toRevisionId}`, { role: e.role });
      }
      db.run(
        `INSERT INTO revision_edges (from_revision_id, to_revision_id, project_id, role, ordinal, runtime)
         VALUES (:from, :to, :p, :role, :ordinal, :runtime)`,
        { from: id, to: e.toRevisionId, p: input.projectId, role: e.role, ordinal: e.ordinal, runtime: e.runtime ? 1 : 0 },
      );
    }
    db.run("UPDATE assets SET updated_at = :now WHERE id = :id", { now, id: asset.id });
    return getRevision(db, input.projectId, id);
  });
}

/**
 * Arestas da revisão: as derivadas do payload (dependências runtime e vínculos
 * editoriais) mais as editoriais explícitas, deduplicadas por papel e alvo.
 */
function collectEdges(entry: ManifestEntry, explicit: NonNullable<PublishRevisionInput["edges"]>) {
  const byKey = new Map<string, { toRevisionId: string; role: string; runtime: boolean; derived: boolean }>();
  for (const ref of entryRefs(entry).revisions) {
    const key = `${ref.role}|${ref.revisionId}`;
    const prev = byKey.get(key);
    byKey.set(key, { toRevisionId: ref.revisionId, role: ref.role, runtime: (prev?.runtime ?? false) || ref.runtime, derived: true });
  }
  for (const e of explicit) {
    const key = `${e.role}|${e.toRevisionId}`;
    if (!byKey.has(key)) byKey.set(key, { toRevisionId: e.toRevisionId, role: e.role, runtime: e.runtime, derived: false });
  }
  const ordinals = new Map<string, number>();
  return [...byKey.values()].map((e) => {
    const ordinal = ordinals.get(e.role) ?? 0;
    ordinals.set(e.role, ordinal + 1);
    return { ...e, ordinal };
  });
}

// ---------------------------------------------------------------------------
// Pareceres
// ---------------------------------------------------------------------------

export interface ReviewInput {
  projectId: string;
  assetId: string;
  revisionId: string;
  decision: "approve" | "reject" | "promote";
  reason: string | null;
  /** Revisão ativa vista pelo artista; divergência = outra aba mudou o asset. */
  expectedActiveRevisionId: string | null;
}

export interface ReviewResult {
  asset: AssetView;
  revision: RevisionView;
  /** Derivados que citam a revisão ativa anterior e podem precisar de atualização. */
  affectedDependents: { revisionId: string; assetId: string; role: string }[];
}

export function reviewRevision(db: Db, clock: Clock, input: ReviewInput): ReviewResult {
  return db.transaction(() => {
    const asset = getAsset(db, input.projectId, input.assetId);
    const revision = db.get<RevisionRow>("SELECT * FROM asset_revisions WHERE id = :id AND asset_id = :a", { id: input.revisionId, a: asset.id });
    if (!revision) throw new DomainFailure("not_found", "Revisão não pertence a este asset");
    if (asset.approvedRevisionId !== input.expectedActiveRevisionId) {
      throw new DomainFailure("revision_conflict", "A revisão ativa mudou desde que esta tela foi aberta", {
        currentActiveRevisionId: asset.approvedRevisionId,
        expectedActiveRevisionId: input.expectedActiveRevisionId,
      });
    }
    const now = iso(clock.now());
    const previous = asset.approvedRevisionId;

    if (input.decision === "reject") {
      if (revision.id === previous) throw new DomainFailure("validation_failed", "A revisão ativa não pode ser reprovada; promova outra antes");
      if (!input.reason) throw new DomainFailure("validation_failed", "Reprovação exige motivo");
      db.run("UPDATE asset_revisions SET status = 'rejected' WHERE id = :id", { id: revision.id });
    } else {
      if (input.decision === "promote" && revision.status !== "approved") {
        throw new DomainFailure("validation_failed", "Só uma revisão já aprovada pode ser promovida a ativa");
      }
      db.run("UPDATE asset_revisions SET status = 'approved' WHERE id = :id", { id: revision.id });
      db.run("UPDATE assets SET approved_revision_id = :rev, updated_at = :now WHERE id = :id", { rev: revision.id, now, id: asset.id });
    }
    db.run(
      `INSERT INTO reviews (id, asset_id, revision_id, decision, reason, technical_report_json, created_at)
       VALUES (:id, :a, :rev, :d, :reason, :report, :now)`,
      { id: newId("rvw"), a: asset.id, rev: revision.id, d: input.decision, reason: input.reason, report: revision.technical_report_json, now },
    );
    const affectedDependents =
      previous && previous !== revision.id && input.decision !== "reject"
        ? db.all<{ revisionId: string; assetId: string; role: string }>(
            `SELECT e.from_revision_id AS revisionId, r.asset_id AS assetId, e.role FROM revision_edges e
             JOIN asset_revisions r ON r.id = e.from_revision_id WHERE e.to_revision_id = :prev`,
            { prev: previous },
          )
        : [];
    return { asset: getAsset(db, input.projectId, asset.id), revision: getRevision(db, input.projectId, revision.id), affectedDependents };
  });
}

/** Origem de cada revisão do asset: de quais revisões ela depende (referências, peças, derivação). */
export function assetLineage(db: Db, projectId: string, assetId: string) {
  getAsset(db, projectId, assetId);
  const rows = db.all<{ fromId: string; revisionId: string; assetName: string; number: number; role: string; runtime: number }>(
    `SELECT e.from_revision_id AS fromId, e.to_revision_id AS revisionId, a.name AS assetName, t.number, e.role, e.runtime
     FROM revision_edges e
     JOIN asset_revisions f ON f.id = e.from_revision_id
     JOIN asset_revisions t ON t.id = e.to_revision_id
     JOIN assets a ON a.id = t.asset_id
     WHERE f.asset_id = :asset AND e.project_id = :p
     ORDER BY e.from_revision_id, e.ordinal`,
    { asset: assetId, p: projectId },
  );
  const lineage: Record<string, { revisionId: string; assetName: string; number: number; role: string; runtime: boolean }[]> = {};
  for (const r of rows) (lineage[r.fromId] ??= []).push({ revisionId: r.revisionId, assetName: r.assetName, number: r.number, role: r.role, runtime: r.runtime === 1 });
  return lineage;
}

export function revisionDependents(db: Db, projectId: string, revisionId: string) {
  getRevision(db, projectId, revisionId);
  return db.all<{ revisionId: string; assetId: string; role: string; runtime: number }>(
    `SELECT e.from_revision_id AS revisionId, r.asset_id AS assetId, e.role, e.runtime FROM revision_edges e
     JOIN asset_revisions r ON r.id = e.from_revision_id WHERE e.to_revision_id = :id`,
    { id: revisionId },
  );
}

// ---------------------------------------------------------------------------
// Rascunhos versionados (duas abas)
// ---------------------------------------------------------------------------

export function getDraft(db: Db, projectId: string, assetId: string): { version: number; payload: unknown } | null {
  getAsset(db, projectId, assetId);
  const row = db.get<{ version: number; payload_json: string }>("SELECT version, payload_json FROM asset_drafts WHERE asset_id = :a", { a: assetId });
  return row ? { version: row.version, payload: JSON.parse(row.payload_json) } : null;
}

export function saveDraft(db: Db, clock: Clock, input: { projectId: string; assetId: string; expectedVersion: number; payload: unknown }) {
  return db.transaction(() => {
    const current = getDraft(db, input.projectId, input.assetId);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      throw new DomainFailure("revision_conflict", "O rascunho foi alterado em outra aba", { currentVersion, expectedVersion: input.expectedVersion });
    }
    const version = currentVersion + 1;
    db.run(
      `INSERT INTO asset_drafts (asset_id, version, payload_json, updated_at) VALUES (:a, :v, :payload, :now)
       ON CONFLICT (asset_id) DO UPDATE SET version = :v, payload_json = :payload, updated_at = :now`,
      { a: input.assetId, v: version, payload: JSON.stringify(input.payload), now: iso(clock.now()) },
    );
    return { version, payload: input.payload };
  });
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

interface UploadRow {
  id: string;
  project_id: string;
  original_name: string;
  blob_sha256: string;
  normalized_sha256: string | null;
  modality: FileModality;
  status: "pending" | "ready" | "rejected";
  metadata_json: string | null;
  error_json: string | null;
  ingest_job_id: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface UploadView {
  id: string;
  projectId: string;
  originalName: string;
  sha256: string;
  normalizedSha256: string | null;
  modality: FileModality;
  status: UploadRow["status"];
  metadata: Record<string, unknown> | null;
  error: unknown;
  ingestJobId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const uploadView = (r: UploadRow): UploadView => ({
  id: r.id,
  projectId: r.project_id,
  originalName: r.original_name,
  sha256: r.blob_sha256,
  normalizedSha256: r.normalized_sha256,
  modality: r.modality,
  status: r.status,
  metadata: parseJson(r.metadata_json),
  error: parseJson(r.error_json),
  ingestJobId: r.ingest_job_id,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

export function insertUpload(
  db: Db,
  clock: Clock,
  input: { projectId: string; originalName: string; blob: BlobRecord; expiresAt: string | null },
): UploadView {
  return db.transaction(() => {
    getProject(db, input.projectId);
    recordBlob(db, clock, input.blob);
    const id = newId("upl");
    db.run(
      `INSERT INTO uploads (id, project_id, original_name, blob_sha256, modality, status, metadata_json, expires_at, created_at)
       VALUES (:id, :p, :name, :sha, :modality, 'pending', :meta, :exp, :now)`,
      {
        id,
        p: input.projectId,
        name: input.originalName,
        sha: input.blob.sha256,
        modality: input.blob.modality,
        meta: JSON.stringify(input.blob.metadata),
        exp: input.expiresAt,
        now: iso(clock.now()),
      },
    );
    return getUpload(db, input.projectId, id);
  });
}

export function getUpload(db: Db, projectId: string, uploadId: string): UploadView {
  const row = db.get<UploadRow>("SELECT * FROM uploads WHERE id = :id AND project_id = :p", { id: uploadId, p: projectId });
  if (!row) throw new DomainFailure("not_found", "Upload não encontrado neste projeto");
  return uploadView(row);
}

export function listUploads(db: Db, projectId: string): UploadView[] {
  return db.all<UploadRow>("SELECT * FROM uploads WHERE project_id = :p ORDER BY created_at DESC LIMIT 100", { p: projectId }).map(uploadView);
}

export function linkUploadJob(db: Db, uploadId: string, jobId: string): void {
  db.run("UPDATE uploads SET ingest_job_id = :job WHERE id = :id", { job: jobId, id: uploadId });
}

export function markUploadReady(db: Db, clock: Clock, uploadId: string, normalized: BlobRecord | null, metadata: Record<string, unknown>): void {
  if (normalized) recordBlob(db, clock, normalized);
  db.run("UPDATE uploads SET status = 'ready', normalized_sha256 = :n, metadata_json = :m, error_json = NULL WHERE id = :id", {
    n: normalized?.sha256 ?? null,
    m: JSON.stringify(metadata),
    id: uploadId,
  });
}

export function markUploadRejected(db: Db, uploadId: string, error: { code: string; message: string }): void {
  db.run("UPDATE uploads SET status = 'rejected', error_json = :e WHERE id = :id", { e: JSON.stringify(error), id: uploadId });
}

/** Arquivo servível por `GET /media/{fileId}`: vínculo de revisão ou upload do projeto. */
export function resolveMedia(db: Db, projectId: string, fileId: string, variant: "default" | "original"): { sha256: string; mime: string } {
  const file = db.get<{ sha256: string; mime: string }>(
    `SELECT f.blob_sha256 AS sha256, b.mime FROM revision_files f JOIN blobs b ON b.sha256 = f.blob_sha256
     WHERE f.id = :id AND f.project_id = :p`,
    { id: fileId, p: projectId },
  );
  if (file) return file;
  const upload = db.get<{ blob_sha256: string; normalized_sha256: string | null }>(
    "SELECT blob_sha256, normalized_sha256 FROM uploads WHERE id = :id AND project_id = :p",
    { id: fileId, p: projectId },
  );
  if (upload) {
    const sha = variant === "default" && upload.normalized_sha256 ? upload.normalized_sha256 : upload.blob_sha256;
    const blob = getBlob(db, sha);
    if (blob) return { sha256: sha, mime: blob.mime };
  }
  throw new DomainFailure("not_found", "Arquivo não encontrado neste projeto");
}

