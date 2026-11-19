/**
 * Reprocessa, sem chamada paga, as respostas brutas do ensaio S3
 * (scripts/states-real.ts) com o pipeline local atual e grava folhas de
 * contato `*-folha-v2.png` e `results-v2.json` ao lado do relatório.
 *
 *   npx tsx scripts/states-reprocess.ts [--dir=reports/animacao/2026-11-19-s3]
 *
 * Não publica revisões: só compara casamento/escala/assentamento locais.
 */
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerationPlan } from "@/contracts";
import { getRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { PIPELINES } from "@/server/jobs/handlers/pipelines";
import { pythonWith } from "@/server/jobs/handlers/pipelines/shared";
import { openStudio } from "@/server/studio";
import { slugify } from "@/server/util";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const dir = path.resolve(REPO_ROOT, arg("dir", "reports/animacao/2026-11-19-s3"));
type Results = { projectId: string; results: { scenario: string; model: string; revisionId: string | null }[] };
const report = JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")) as Results;
// Retomadas (`--resume`) entram junto, no mesmo projeto.
for (const name of (await readdir(dir)).filter((n) => n.startsWith("results-retomada-")).sort()) report.results.push(...(JSON.parse(await readFile(path.join(dir, name), "utf8")) as Results).results);
const studio = openStudio({ config: loadConfig() });
const env = { blobs: studio.blobs, config: studio.config, jobId: "reprocessa", attemptId: "reprocessa", signal: AbortSignal.timeout(600_000) };
const out = [];
for (const r of report.results) {
  if (!r.revisionId || r.scenario === "bau-fechado") continue;
  const revision = getRevision(studio.db, report.projectId, r.revisionId);
  const jobId = studio.db.get<{ job_id: string }>("SELECT job_id FROM job_attempts WHERE id = :a", { a: revision.jobAttemptId })!.job_id;
  const plan = (JSON.parse(studio.queue.get(jobId)!.request_json) as { plan: GenerationPlan }).plan;
  const raw = revision.files.find((f) => f.role === "raw")!;
  const work = path.join(studio.config.paths.staging, "states-reprocess", `${r.scenario}-${slugify(r.model)}`);
  const result = await PIPELINES[plan.operation]!.process(env, plan, raw.sha256, work);
  const details = result.processed.details as { frames?: { frameId: string; sha256: string }[]; sheet?: { scale: unknown; frames: unknown[] } };
  const sources = plan.sources.filter((s) => s.role !== "edit_mask").map((s) => s.sha256);
  let shas: string[];
  if (plan.operation === "correct_frame") shas = [result.processed.candidateSha256!, result.processed.normalizedSha256];
  else if (plan.operation === "interpolate_frames") shas = [sources[0]!, ...details.frames!.map((f) => f.sha256), sources[1]!];
  else shas = [sources[0]!, ...details.frames!.map((f) => f.sha256)];
  const cell = (plan.params as { logicalSize: [number, number] }).logicalSize;
  const contact = await pythonWith(env, path.join(work, "contact"), "animation_contact_sheet", shas.map((sha256) => ({ role: "layer", sha256 })), { version: 1, cell, zoom: 4, background: null, columns: shas.length, gap: 8 });
  if (contact.status === "error") throw new Error(contact.message);
  const tag = `${r.scenario}-${slugify(r.model).replaceAll("_", "-")}`;
  await copyFile(contact.outputs[0]!.absolutePath, path.join(dir, `${tag}-folha-v2.png`));
  out.push({ scenario: r.scenario, model: r.model, scale: details.sheet?.scale ?? null, composite: result.processed.composite ?? null, warnings: result.processed.warnings });
  console.log(`[reprocessa] ${tag}: escala ${JSON.stringify(details.sheet?.scale ?? null)} · ${result.processed.warnings.length} alerta(s)`);
}
await writeFile(path.join(dir, "results-v2.json"), JSON.stringify({ note: "Mesmas respostas brutas, pipeline local atual (escala comum pela largura do objeto). Custo: zero.", results: out }, null, 2));
studio.db.close();
