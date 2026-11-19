/**
 * Reprocessa localmente (sem custo) as imagens brutas de uma avaliação com o
 * pipeline atual, para comparar mudanças de normalização sem gerar de novo.
 *
 *   npx tsx scripts/reprocess-eval.ts reports/avaliacao/<pasta>
 *
 * Grava img/<caso>-final-v2.png e results-v2.json ao lado do original.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GenerationPlan } from "@/contracts";
import { getRevision, getStyleRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { processProviderImage } from "@/server/jobs/handlers/generation";
import { openStudio } from "@/server/studio";
import { slugify } from "@/server/util";

loadDotEnv();
const dir = path.resolve(REPO_ROOT, process.argv[2] ?? "");
const data = JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")) as {
  projectId: string;
  results: { projectId?: string; model: string; task: string; language: string; state: string; revisionId: string | null; rawSha: string | null; report: unknown }[];
};
const studio = openStudio({ config: loadConfig() });
const work = await mkdtemp(path.join(os.tmpdir(), "reprocess-"));
const out = [];
for (const r of data.results) {
  if (!r.revisionId || !r.rawSha) {
    out.push(r);
    continue;
  }
  const projectId = r.projectId ?? data.projectId;
  const revision = getRevision(studio.db, projectId, r.revisionId);
  const job = studio.db.get<{ request_json: string }>(
    "SELECT request_json FROM jobs WHERE project_id = :p AND kind = 'generation' AND json_extract(request_json, '$.targetAssetId') = :a",
    { p: projectId, a: revision.assetId },
  );
  const plan = (JSON.parse(job!.request_json) as { plan: GenerationPlan }).plan;
  const base = `${r.task}-${r.language}-${slugify(r.model).replaceAll("_", "-")}`;
  try {
    const { palette } = getStyleRevision(studio.db, projectId, plan.styleRevisionId).payload;
    const { processed, stored } = await processProviderImage(
      { blobs: studio.blobs, config: studio.config, jobId: "job_reprocess", attemptId: "att_reprocess", signal: AbortSignal.timeout(120_000) },
      plan,
      r.rawSha,
      path.join(work, base),
      palette,
    );
    await writeFile(path.join(dir, "img", `${base}-final-v2.png`), await readFile(studio.blobs.pathFor(stored.sha256)));
    out.push({ ...r, reportV2: { steps: processed.steps, warnings: processed.warnings } });
    const fit = (processed.steps ?? []).find((s) => s.operation === "fit_logical") as { method?: string; contentRect?: number[]; alphaBinarized?: number } | undefined;
    const grid = (processed.steps ?? []).find((s) => s.operation === "unzoom") as { cell?: number[]; grid?: number[] } | undefined;
    console.log(`${base}: célula ${grid?.cell?.[0] ?? "—"} · ${fit?.method ?? "—"} · conteúdo ${fit?.contentRect?.slice(2).join("×") ?? "—"} · avisos ${processed.warnings.length}`);
  } catch (err) {
    console.log(`${base}: ERRO ${err instanceof Error ? err.message : String(err)}`);
    out.push({ ...r, reportV2: { error: String(err) } });
  }
}
await writeFile(path.join(dir, "results-v2.json"), JSON.stringify({ ...data, results: out }, null, 2));
await rm(work, { recursive: true, force: true });
studio.db.close();
