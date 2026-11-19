/**
 * Reprocessa, sem chamada paga, as respostas brutas do ensaio de animação
 * (scripts/animation-real.ts) com o pipeline local atual e grava folhas de
 * contato `*-folha-v2.png` e `results-v2.json` ao lado do relatório.
 *
 *   npx tsx scripts/animation-reprocess.ts [--dir=reports/animacao/2026-11-19]
 *
 * Não publica revisões: só compara o fatiamento/alinhamento local.
 */
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pick } from "@/i18n/locales";
import type { GenerationPlan } from "@/contracts";
import { getRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { processSheet, sheetOf } from "@/server/jobs/handlers/pipelines/animation";
import { pythonWith } from "@/server/jobs/handlers/pipelines/shared";
import { openStudio } from "@/server/studio";
import { slugify } from "@/server/util";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const dir = path.resolve(REPO_ROOT, arg("dir", "reports/animacao/2026-11-19"));
const report = JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")) as { projectId: string; results: { scenario: string; model: string; revisionId: string | null }[] };
const studio = openStudio({ config: loadConfig() });
const env = { blobs: studio.blobs, config: studio.config, jobId: "reprocessa", attemptId: "reprocessa", signal: AbortSignal.timeout(600_000) };
const out = [];
for (const r of report.results) {
  if (!r.revisionId) continue;
  const revision = getRevision(studio.db, report.projectId, r.revisionId);
  const jobId = studio.db.get<{ job_id: string }>("SELECT job_id FROM job_attempts WHERE id = :a", { a: revision.jobAttemptId })!.job_id;
  const plan = (JSON.parse(studio.queue.get(jobId)!.request_json) as { plan: GenerationPlan }).plan;
  const sheet = sheetOf(plan)!;
  const raw = revision.files.find((f) => f.role === "raw")!;
  const work = path.join(studio.config.paths.staging, "animation-reprocess", `${r.scenario}-${slugify(r.model)}`);
  const result = await processSheet(env, plan, raw.sha256, work, sheet.frameIds);
  const frames = (result.processed.details as { frames: { sha256: string }[] }).frames;
  for (const extra of result.extraBlobs ?? []) await studio.blobs.read(extra.blob.sha256);
  const base = plan.sources[0]!;
  const contact = await pythonWith(env, path.join(work, "contact"), "animation_contact_sheet", [base.sha256, ...frames.map((f) => f.sha256)].map((sha256) => ({ role: "layer", sha256 })), {
    version: 1,
    cell: sheet.cell,
    zoom: 4,
    background: null,
    columns: frames.length + 1,
    gap: 8,
  });
  if (contact.status === "error") throw new Error(pick(contact.message, "pt-BR"));
  const tag = `${r.scenario}-${slugify(r.model).replaceAll("_", "-")}`;
  await copyFile(contact.outputs[0]!.absolutePath, path.join(dir, `${tag}-folha-v2.png`));
  const details = (result.processed.details as { sheet: { scale: unknown; frames: { frameId: string; lift: number; shift: number; clippedPixels: number }[] } }).sheet;
  out.push({ scenario: r.scenario, model: r.model, scale: details.scale, frames: details.frames.map((f) => ({ frameId: f.frameId, lift: f.lift, shift: f.shift, clippedPixels: f.clippedPixels })), warnings: result.processed.warnings });
  console.log(`[reprocessa] ${tag}: ${details.frames.map((f) => `${f.frameId}(${f.lift},${f.shift},${f.clippedPixels})`).join(" ")}`);
}
await writeFile(path.join(dir, "results-v2.json"), JSON.stringify({ note: "Mesmas respostas brutas, pipeline local atual (chão por linha; ciclos ancorados no x do pivô). Custo: zero.", results: out }, null, 2));
studio.db.close();
