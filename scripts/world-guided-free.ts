/**
 * Complemento do ensaio do T1: tileset guiado em MODO LIVRE (sem faixa travada)
 * sobre o mesmo gabarito aprovado da rodada anterior, para comparar com o
 * modo de borda travada (06 §verificações de emenda: os dois modos).
 *
 *   npx tsx scripts/world-guided-free.ts [--max-usd=0.2] [--yes]
 *
 * Sem --yes: só reverifica (localmente, sem custo) o atlas guiado com faixa
 * travada da rodada anterior e estima a chamada. Uma chamada paga (flare).
 */
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { JobRunner } from "@/server/jobs/runner";
import { buildPlan } from "@/server/plan-builders";
import { submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { checkTilesetRevision } from "@/server/world/tilesets";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MAX_USD = Number(arg("max-usd", "0.2"));
const CONFIRMED = process.argv.includes("--yes");
const DAY = arg("day", new Date().toLocaleDateString("sv-SE"));
const ESTIMATE = 0.1; // flare cobra por token; teto conservador por imagem
const log = (m: string) => console.log(`[mundo-livre] ${m}`);

const outDir = path.join(REPO_ROOT, "reports", "mundo", DAY);
const results = JSON.parse(await readFile(path.join(outDir, "results.json"), "utf8")) as {
  projectId: string;
  tileset: { template: { revisionId: string }; guided?: { revisionId: string }; free?: unknown; lockedRecheck?: unknown };
  textures: { key: string }[];
  costs: { label: string; usd: number | null }[];
  totalUsd: number;
};
runMigrations();
const studio = openStudio({ config: loadConfig() });
const projectId = results.projectId;

// ---- Reverificação gratuita do modo travado com a métrica de moldura ----
if (results.tileset.guided) {
  const recheck = await checkTilesetRevision(studio, projectId, results.tileset.guided.revisionId);
  const locked = (recheck.report as { locked?: { maxFrameRatio: number; frameFlagged: string[]; passed: boolean } }).locked;
  results.tileset.lockedRecheck = { locked, warnings: recheck.warnings, flagged: (recheck.report as { flagged: unknown[] }).flagged.length };
  log(`faixa travada (4 px): faixa igual ao gabarito ${locked?.passed} · moldura máx ${locked?.maxFrameRatio} · ${locked?.frameFlagged.length ?? 0} tile(s) com moldura visível`);
}

const key = ((await (await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
log(`1 chamada (flare, modo livre) · custo máximo estimado US$ ${ESTIMATE} (teto US$ ${MAX_USD}) · saldo da chave US$ ${key.limit_remaining} (uso ${key.usage})`);
if (ESTIMATE > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (key.limit_remaining !== null && key.limit_remaining < ESTIMATE) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  log("simulação: nada foi enviado (reverificação local gravada). Rode com --yes para executar.");
  process.exit(0);
}

// ---- Geração guiada em modo livre (faixa 0) ----
const template = getRevision(studio.db, projectId, results.tileset.template.revisionId);
const materials = studio.db
  .all<{ id: string }>(
    `SELECT r.id FROM asset_revisions r JOIN assets a ON a.id = r.asset_id
     WHERE r.project_id = :p AND a.family = 'texture' AND a.name IN ('Grama curta', 'Água rasa') AND r.status = 'approved' ORDER BY a.name DESC`,
    { p: projectId },
  )
  .map((r) => r.id);
const planned = await buildPlan(studio, projectId, {
  operation: "generate_tileset",
  providerProfileId: "mundo-flare",
  guideRevisionId: template.id,
  instruction: "grama de clareira com tufos e flores pequenas; água rasa com reflexos; margem com areia úmida fina entre as duas",
  lockedBandPx: 0,
  materialRevisionIds: materials,
} as never);
const worker = new JobRunner({ ...studio, log: () => undefined }, { workerId: "world-free", heartbeatMs: 10_000 });
const started = Date.now();
const { job } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: template.assetId } }, `world-free:${DAY}`);
while (await worker.runOnce()) {
  /* processa */
}
const final = studio.queue.get(job.id)!;
const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
const usd = result?.cost?.find((c) => c.unit === "USD")?.amount ?? null;
log(`modo livre: ${final.state} em ${((Date.now() - started) / 1000).toFixed(0)} s · US$ ${usd ?? "?"}${final.error_json ? ` · ${final.error_json}` : ""}`);
if (result) {
  const rev = getRevision(studio.db, projectId, result.revisionIds[0]!);
  const f = (k: string) => rev.files.find((x) => x.fileKey === k)?.sha256;
  for (const [k, name] of [
    ["atlas", "tileset-livre-atlas.png"],
    ["check-sample-zoom", "tileset-livre-amostra.png"],
    ["check-pairs", "tileset-livre-pares.png"],
  ] as const) {
    if (f(k)) await copyFile(studio.blobs.pathFor(f(k)!), path.join(outDir, name));
  }
  results.tileset.free = { revisionId: rev.id, report: rev.technicalReport };
}
results.costs.push({ label: "tileset guiado (modo livre)", usd });
results.totalUsd = results.costs.reduce((n, c) => n + (c.usd ?? 0), 0);
await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
log(`custo desta execução US$ ${usd ?? "?"} · total da rodada US$ ${results.totalUsd.toFixed(4)}`);
studio.db.close();
