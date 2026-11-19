import { type LocalizedText, tx } from "@/i18n/locales";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Id, parseRevisionPayload } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { validateManifest } from "@/domain/manifest/validate";
import { sha256Hex, verifyManifestFiles } from "@/domain/manifest/verify-files";
import { readZip, writeZip } from "@/lib/zip";
import { getAsset, getProject, getRevision } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import type { HandlerContext } from "../jobs/context";
import type { JobQueue, JobRow } from "../jobs/queue";
import { type Clock, iso, newId, parseJson, slugify } from "../util";
import { buildPortablePackage, type ExportReport, resolveClosure } from "./package";
import { equipmentExportProblems, exportProblemMessage } from "../equipment/export-check";
import { EXPORT_PROFILES, ExportProfileId } from "./profiles";
import type { ExportTarget } from "./target";
import { asepriteTarget, gifTarget } from "./targets/animation";
import { godotTarget } from "./targets/godot";
import { tiledTarget } from "./targets/tiled";
import { unityTarget } from "./targets/unity";

const TARGETS: Record<Exclude<ExportProfileId, "portable-v1">, ExportTarget> = {
  "tiled-v1": tiledTarget,
  "godot-v1": godotTarget,
  "unity-v1": unityTarget,
  "aseprite-v1": asepriteTarget,
  "gif-v1": gifTarget,
};

/**
 * Exportações (02a §rotas · Exportar): o pedido congela a seleção por ID de
 * revisão, valida o fecho e enfileira; o worker monta o ZIP em staging, relê
 * e valida o pacote, promove para `exports/<id>/` e só então marca pronto.
 */

export const ExportRequest = z.strictObject({ exportId: Id });

export const CreateExportInput = z.strictObject({
  revisionIds: z.array(Id).min(1).max(500),
  profile: ExportProfileId.default("portable-v1"),
});

interface ExportRow {
  id: string;
  project_id: string;
  profile: string;
  profile_version: number;
  state: "pending" | "ready" | "failed";
  job_id: string | null;
  selection_json: string;
  closure_json: string | null;
  zip_sha256: string | null;
  file_name: string | null;
  bytes: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface ExportView {
  id: string;
  projectId: string;
  profile: string;
  /** Estado efetivo: um job encerrado sem sucesso torna a exportação `failed`. */
  state: "pending" | "ready" | "failed";
  jobId: string | null;
  revisionIds: string[];
  report: ExportReport | null;
  zipSha256: string | null;
  fileName: string | null;
  bytes: number | null;
  error: unknown;
  createdAt: string;
  finishedAt: string | null;
}

function exportView(db: Db, row: ExportRow): ExportView {
  const job = row.job_id ? db.get<JobRow>("SELECT * FROM jobs WHERE id = :id", { id: row.job_id }) : undefined;
  const failed = row.state === "pending" && (job?.state === "failed" || job?.state === "cancelled");
  return {
    id: row.id,
    projectId: row.project_id,
    profile: row.profile,
    state: failed ? "failed" : row.state,
    jobId: row.job_id,
    revisionIds: (JSON.parse(row.selection_json) as { revisionIds: string[] }).revisionIds,
    report: parseJson<ExportReport>(row.closure_json),
    zipSha256: row.zip_sha256,
    fileName: row.file_name,
    bytes: row.bytes,
    error: failed || job?.state === "queued" ? parseJson(job?.error_json) : null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function getExport(db: Db, projectId: string, exportId: string): ExportView {
  const row = db.get<ExportRow>("SELECT * FROM exports WHERE id = :id AND project_id = :p", { id: exportId, p: projectId });
  if (!row) throw new DomainFailure("not_found", tx("Exportação não encontrada neste projeto", "Export not found in this project"));
  return exportView(db, row);
}

export function listExports(db: Db, projectId: string): ExportView[] {
  return db.all<ExportRow>("SELECT * FROM exports WHERE project_id = :p ORDER BY created_at DESC LIMIT 50", { p: projectId }).map((r) => exportView(db, r));
}

/** Valida o fecho (sem custo) e enfileira. A mesma seleção devolve a mesma exportação. */
export function requestExport(
  deps: { db: Db; clock: Clock; queue: JobQueue },
  projectId: string,
  input: z.infer<typeof CreateExportInput>,
  idempotencyKey?: string,
): { export: ExportView; created: boolean } {
  getProject(deps.db, projectId);
  const revisionIds = [...new Set(input.revisionIds)].sort();
  const closure = resolveClosure(deps.db, projectId, revisionIds);
  if (closure.problems.length > 0) {
    throw new DomainFailure("coverage_incomplete", tx("A seleção tem revisões que não podem ser exportadas", "The selection has revisions that cannot be exported"), { problems: closure.problems });
  }
  if (input.profile !== "portable-v1") {
    const profile = EXPORT_PROFILES[input.profile];
    const target = TARGETS[input.profile];
    const problems: { revisionId: string; message: LocalizedText }[] = [];
    for (const revisionId of revisionIds) {
      const revision = getRevision(deps.db, projectId, revisionId);
      const asset = getAsset(deps.db, projectId, revision.assetId);
      const entry = parseRevisionPayload(asset.family, asset.kind, revision.payload);
      const reason = !profile.kinds[asset.family]?.includes(asset.kind)
        ? tx("tipo não suportado pelo formato", "asset type not supported by the format")
        : entry.success ? target.problem({ ...entry.entry, revisionId, assetId: asset.id, name: asset.name }) : tx("revisão inválida", "invalid revision");
      if (reason) problems.push({ revisionId, message: tx(`${asset.name} r${revision.number}: ${reason["pt-BR"]}`, `${asset.name} r${revision.number}: ${reason.en}`) });
    }
    if (problems.length) {
      throw new DomainFailure("coverage_incomplete", tx("Parte da seleção não é compatível com o formato escolhido", "Part of the selection is not supported by the chosen format"), { problems });
    }
  }
  // S2: conjuntos equipados só saem completos (ou como subconjunto explícito).
  const equipment = equipmentExportProblems(deps.db, projectId, closure.revisionIds);
  if (equipment.length > 0) throw new DomainFailure("coverage_incomplete", exportProblemMessage(equipment), { problems: equipment });
  const key = idempotencyKey ?? `export:${input.profile}:${canonicalDigest(revisionIds)}`;
  return deps.db.transaction(() => {
    const exportId = newId("exp");
    const { job, created } = deps.queue.enqueue({
      projectId,
      kind: "export",
      request: { selection: revisionIds, profile: input.profile },
      idempotencyKey: key,
      apply: (jobId) =>
        deps.db.run(
          `INSERT INTO exports (id, project_id, profile, profile_version, state, job_id, selection_json, created_at)
           VALUES (:id, :p, :profile, :version, 'pending', :job, :selection, :now)`,
          {
            id: exportId,
            p: projectId,
            profile: input.profile,
            version: EXPORT_PROFILES[input.profile].version,
            job: jobId,
            selection: JSON.stringify({ revisionIds }),
            now: iso(deps.clock.now()),
          },
        ),
    });
    const row = deps.db.get<ExportRow>("SELECT * FROM exports WHERE job_id = :job", { job: job.id });
    if (!row) throw new DomainFailure("internal", tx("Exportação sem registro para o job", "Export has no record for the job"));
    return { export: exportView(deps.db, row), created };
  });
}

/** Caminho absoluto do ZIP promovido. */
export function exportFilePath(exportsDir: string, view: Pick<ExportView, "id" | "fileName">): string {
  if (!view.fileName) throw new DomainFailure("not_found", tx("Pacote ainda não está pronto", "Package is not ready yet"));
  return path.join(exportsDir, view.id, view.fileName);
}

const ExportJobRequest = z.strictObject({ selection: z.array(Id).min(1), profile: ExportProfileId });

/** Executor do job `export`. */
export async function exportHandler(ctx: HandlerContext): Promise<void> {
  const request = ExportJobRequest.parse(JSON.parse(ctx.job.request_json));
  const row = ctx.db.get<ExportRow>("SELECT * FROM exports WHERE job_id = :job", { job: ctx.job.id });
  if (!row) throw new DomainFailure("internal", tx("Job de exportação sem registro de exportação", "Export job has no export record"));
  const project = getProject(ctx.db, ctx.job.project_id);

  ctx.queue.setStage(ctx.attempt, "prepare");
  const pkg = await buildPortablePackage(ctx.db, ctx.blobs, ctx.job.project_id, request.selection);
  ctx.checkpoint();

  ctx.queue.setStage(ctx.attempt, "process");
  const profile = EXPORT_PROFILES[request.profile];
  const artifacts = request.profile === "portable-v1" ? [] : await TARGETS[request.profile].build({
    manifest: pkg.manifest,
    sourceFiles: pkg.files,
    selected: new Set(request.selection),
    projectName: project.name,
    workDir: ctx.workDir,
    python: ctx.config.python,
    signal: ctx.signal,
    timeoutMs: ctx.config.pythonTimeoutMs,
  });
  if (request.profile !== "portable-v1" && artifacts.length === 0) {
    throw new DomainFailure("internal", tx("O formato não produziu arquivos de destino", "The format produced no destination files"));
  }
  ctx.checkpoint();
  const zip = writeZip(artifacts.length ? [...pkg.files, ...artifacts] : pkg.files);
  // Relê o pacote como um consumidor faria antes de promovê-lo.
  const archive = readZip(zip);
  const reread = validateManifest(JSON.parse(new TextDecoder().decode(archive.read("manifest.json"))));
  if (!reread.ok || !reread.manifest) throw new DomainFailure("internal", tx("Pacote relido não passou na validação", "Reread package did not pass validation"), { issues: reread.issues.slice(0, 10) });
  const fileIssues = await verifyManifestFiles(reread.manifest, async (p) => archive.read(p));
  if (fileIssues.length > 0) throw new DomainFailure("internal", tx("Arquivos do pacote relido divergem do manifesto", "Files in the reread package do not match the manifest"), { issues: fileIssues });
  for (const artifact of artifacts) archive.read(artifact.path);
  const report: ExportReport = artifacts.length ? {
    ...pkg.report,
    profile: profile.id,
    profileVersion: profile.version,
    files: pkg.report.files + artifacts.length,
    totalBytes: pkg.report.totalBytes + artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0),
    supports: profile.supports,
    limitations: profile.limitations,
  } : pkg.report;
  const zipSha256 = sha256Hex(zip);

  ctx.queue.setStage(ctx.attempt, "publish");
  await ctx.blobs.ensureSpace(zip.length);
  const format = request.profile === "portable-v1" ? "" : `-${request.profile}`;
  const fileName = `${slugify(project.name).replaceAll("_", "-")}${format}-${row.id.slice(4, 12)}.zip`;
  const dir = path.join(ctx.config.paths.exports, row.id);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${fileName}.tmp`);
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(zip);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path.join(dir, fileName));

  try {
    ctx.queue.succeed(ctx.attempt, () => {
      ctx.db.run(
        `UPDATE exports SET state = 'ready', zip_sha256 = :sha, file_name = :name, bytes = :bytes, closure_json = :report, finished_at = :now
         WHERE id = :id`,
        { sha: zipSha256, name: fileName, bytes: zip.length, report: JSON.stringify(report), now: iso(ctx.clock.now()), id: row.id },
      );
      for (const entry of pkg.manifest.entries) {
        ctx.db.run("INSERT OR IGNORE INTO export_entries (export_id, revision_id) VALUES (:e, :r)", { e: row.id, r: entry.revisionId });
      }
      return { exportId: row.id, zipSha256, bytes: zip.length, entries: pkg.report.entries };
    });
  } catch (err) {
    // Tentativa sem posse: o arquivo promovido não é publicado; a próxima tentativa o regrava.
    await rm(path.join(dir, fileName), { force: true });
    throw err;
  }
}
