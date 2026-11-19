/**
 * Avaliação de modelos e prompts para ícones de item (03 §3 · ensaio A1).
 *
 *   npx tsx scripts/evaluate-models.ts [--size=32] [--max-usd=4] [--models=a,b] [--yes]
 *
 * Matriz modelos × tarefas × idioma do prompt, executada pelo pipeline real
 * (fila, worker, normalização, grade, cor-chave, ajuste). Sem --yes, só estima.
 * Resultados em reports/avaliacao/<data>/ (results.json + imagens); o
 * julgamento artístico final é do artista, no projeto criado.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildClareira } from "@/fixtures/clareira";
import { createAsset, createProject, getRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { importPortablePackage } from "@/server/export/import";
import { JobRunner } from "@/server/jobs/runner";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import { buildGenerationPlan, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso, sleep, slugify } from "@/server/util";
import { readZip, writeZip } from "@/lib/zip";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const SIZE = Number(arg("size", "32"));
const MAX_USD = Number(arg("max-usd", "4"));
const CONFIRMED = process.argv.includes("--yes");
const CONCURRENCY = Number(arg("concurrency", "4"));
/** Rodadas seguintes vão para outra pasta, ex.: --label=rodada2. */
const LABEL = arg("label", "");
/** Só estes casos, no formato modelo|tarefa|idioma separados por vírgula. */
const CASES = arg("cases", "")
  .split(",")
  .filter(Boolean);
const BASE = "https://openrouter.ai/api/v1";

interface ModelSpec {
  model: string;
  resolution?: "512" | "768" | "1K" | "1.5K" | "2K";
  quality?: "low" | "medium" | "high";
  /** Sobrepõe o alfa do catálogo (ex.: Seedream 5.0 Flash só faz alfa com uma referência). */
  transparent?: boolean | "single_reference";
  /** Estimativa conservadora por imagem quando o catálogo cobra por token. */
  tokenEstimateUsd?: number;
}

const DEFAULT_MODELS: ModelSpec[] = [
  { model: "bytedance-seed/seedream-4.5", resolution: "2K" },
  { model: "bytedance-seed/seedream-5-5", resolution: "1K" },
  { model: "bytedance-seed/seedream-5-0-flash", resolution: "1K", transparent: "single_reference" },
  { model: "openai/gpt-image-2.6-flare", quality: "medium", tokenEstimateUsd: 0.1 },
  { model: "openai/gpt-image-1-mini", quality: "medium", tokenEstimateUsd: 0.05 },
  { model: "google/gemini-3.1-flash-image", resolution: "1K", tokenEstimateUsd: 0.1 },
  { model: "black-forest-labs/flux-3-image-klein", resolution: "1K" },
  { model: "qwen/qwen-image-2.1-turbo", resolution: "1K" },
  { model: "microsoft/mai-image-2.7-flash", tokenEstimateUsd: 0.05 },
];
const selected = arg("models", "");
const MODELS = selected ? DEFAULT_MODELS.filter((m) => selected.split(",").includes(m.model)) : DEFAULT_MODELS;

type Lang = "pt-BR" | "en";
interface TaskSpec {
  key: string;
  label: string;
  brief: Record<Lang, string>;
  refs: { ref: "potion" | "warrior"; role: "identity" | "palette"; instruction: Record<Lang, string> }[];
  languages: Lang[];
}
const TASKS: TaskSpec[] = [
  {
    key: "texto",
    label: "Poção só por texto",
    brief: { "pt-BR": "poção verde em frasco de vidro arredondado com rolha de cortiça", en: "green potion in a round glass flask with a cork stopper" },
    refs: [],
    languages: ["en", "pt-BR"],
  },
  {
    key: "uma-ref",
    label: "Variação com uma referência",
    brief: { "pt-BR": "a mesma poção da imagem 1, agora com líquido azul", en: "the same potion as image 1, now with blue liquid" },
    refs: [{ ref: "potion", role: "identity", instruction: { "pt-BR": "frasco e formato da poção", en: "flask and potion shape" } }],
    languages: ["en", "pt-BR"],
  },
  {
    key: "duas-refs",
    label: "Duas referências ordenadas",
    brief: { "pt-BR": "a poção da imagem 1 com o líquido na cor da túnica do guerreiro da imagem 2", en: "the potion from image 1 with liquid in the color of the warrior's tunic from image 2" },
    refs: [
      { ref: "potion", role: "identity", instruction: { "pt-BR": "frasco e formato da poção", en: "flask and potion shape" } },
      { ref: "warrior", role: "palette", instruction: { "pt-BR": "azul da túnica", en: "tunic blue" } },
    ],
    languages: ["en"],
  },
  {
    key: "espada",
    label: "Espada só por texto",
    brief: { "pt-BR": "espada curta de aço com punho de couro marrom, na diagonal", en: "short steel sword with a brown leather grip, diagonal" },
    refs: [],
    languages: ["en"],
  },
];

function log(msg: string) {
  console.log(`[avaliação] ${msg}`);
}

// ---- 1. Descoberta gratuita e estimativa ----
interface Route {
  spec: ModelSpec;
  tag: string | null;
  maxReferences: number;
  transparent: boolean | "single_reference";
  priceImage: number | null;
  priceRef: number;
}
const routes: Route[] = [];
for (const spec of MODELS) {
  const found = await new OpenRouterAdapter({ id: "d", baseUrl: BASE, secretRef: null, model: spec.model }, {}).discover(AbortSignal.timeout(30_000));
  const ep = found.find((e) => e.providerTag) ?? found[0];
  if (!ep) {
    log(`${spec.model}: sem rota; ignorado`);
    continue;
  }
  const pricing = ep.pricing as { billable: string; unit: string; cost_usd: number; variant?: string }[];
  const images = pricing.filter((p) => p.billable === "output_image" && p.unit === "image" && !/4k|high/i.test(p.variant ?? ""));
  routes.push({
    spec,
    tag: ep.providerTag,
    maxReferences: ep.maxReferences,
    transparent: spec.transparent ?? ep.transparent,
    priceImage: images.length ? Math.max(...images.map((p) => p.cost_usd)) : null,
    priceRef: pricing.find((p) => p.billable === "input_image" && p.unit === "image")?.cost_usd ?? 0,
  });
}
interface Run {
  route: Route;
  task: TaskSpec;
  language: Lang;
}
const runs: Run[] = routes
  .flatMap((route) => TASKS.flatMap((task) => task.languages.map((language) => ({ route, task, language }))))
  .filter((r) => CASES.length === 0 || CASES.includes(`${r.route.spec.model}|${r.task.key}|${r.language}`));
const estimate = (r: Run) => (r.route.priceImage ?? r.route.spec.tokenEstimateUsd ?? 0.15) + r.route.priceRef * r.task.refs.length;
const maxCost = runs.reduce((n, r) => n + estimate(r), 0);
for (const r of routes) {
  log(`${r.spec.model} · rota ${r.tag} · refs ≤ ${r.maxReferences} · alfa ${r.transparent === "single_reference" ? "só com 1 referência" : r.transparent ? "sim" : "não"} · ${r.priceImage !== null ? `US$ ${r.priceImage}/imagem` : `por token (estimativa US$ ${r.spec.tokenEstimateUsd ?? 0.15})`}`);
}
const keyInfo = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
log(`${runs.length} imagens · custo máximo estimado US$ ${maxCost.toFixed(2)} (teto US$ ${MAX_USD}) · saldo da chave US$ ${keyInfo.limit_remaining} (uso ${keyInfo.usage})`);
if (maxCost > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (keyInfo.limit_remaining !== null && keyInfo.limit_remaining < maxCost) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

// ---- 2. Projeto e perfis ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const today = iso(studio.clock.now()).slice(0, 10);
const project = createProject(studio.db, studio.clock, { name: `Avaliação de modelos · ícones ${SIZE}px · ${today}${LABEL ? ` · ${LABEL}` : ""}` });
const fixture = buildClareira();
const { revisionMap } = await importPortablePackage(studio, project.id, readZip(writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })))), {
  approve: true,
});
const REFS = { potion: { revisionId: revisionMap["potion-v1"]!, fileKey: "potion-sheet" }, warrior: { revisionId: revisionMap["warrior-base-v1"]!, fileKey: "warrior-base-s" } };

function profileFor(route: Route, resolution = route.spec.resolution) {
  const id = `eval-${slugify(route.spec.model).replaceAll("_", "-")}`.slice(0, 64);
  saveProfile(studio.db, studio.clock, {
    id,
    name: `Avaliação · ${route.spec.model}`,
    transport: "openrouter_images",
    secretRef: "OPENROUTER_API_KEY",
    model: route.spec.model,
    config: {
      maxReferences: route.maxReferences,
      transparent: route.transparent,
      ...(route.tag ? { provider: { only: [route.tag], allow_fallbacks: false } } : {}),
      ...(resolution ? { resolution } : {}),
      ...(route.spec.quality ? { quality: route.spec.quality } : {}),
      aspectRatio: "1:1",
      ...(route.priceImage !== null ? { pricePerImageUsd: route.priceImage } : {}),
    },
  });
  return id;
}
const profiles = new Map(routes.map((r) => [r.spec.model, profileFor(r)]));
log(`projeto "${project.name}" (${project.id}) · ${routes.length} perfis`);

// ---- 3. Execução (fila real, 4 em paralelo) ----
interface Result {
  projectId: string;
  model: string;
  task: string;
  language: Lang;
  state: string;
  seconds: number;
  cost: number | null;
  error: string | null;
  revisionId: string | null;
  rawSha: string | null;
  imageSha: string | null;
  report: Record<string, unknown> | null;
  retriedAt2K: boolean;
}
const results: Result[] = [];

async function execute(run: Run, retry = false): Promise<void> {
  const profileId = profiles.get(run.route.spec.model)!;
  const asset = createAsset(studio.db, studio.clock, {
    projectId: project.id,
    family: "item",
    kind: "consumable",
    name: `${run.task.key} · ${run.language} · ${run.route.spec.model}`.slice(0, 120),
  });
  const planned = buildGenerationPlan(studio, project.id, {
    operation: "generate_asset",
    providerProfileId: profileId,
    brief: run.task.brief[run.language],
    language: run.language,
    params: { family: "item", kind: "consumable", logicalSize: [SIZE, SIZE], transparent: true, variants: 1 },
    references: run.task.refs.map((r) => ({ ...REFS[r.ref], role: r.role, instruction: r.instruction[run.language] })),
  });
  const started = Date.now();
  const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: asset.id } }, `eval:${asset.id}`);
  let final = studio.queue.get(job.id)!;
  while (!["succeeded", "failed", "cancelled", "needs_attention"].includes(final.state)) {
    await sleep(500);
    final = studio.queue.get(job.id)!;
  }
  const error = JSON.parse(final.error_json ?? "null") as { message?: string } | null;
  if (final.state === "failed" && !retry && /output pixels/i.test(error?.message ?? "") && run.route.spec.resolution !== "2K") {
    // Recusa de validação não é cobrada: tenta de novo na resolução maior.
    log(`${run.route.spec.model}: ${error?.message?.slice(0, 120)} → nova tentativa em 2K`);
    profileFor(run.route, "2K");
    return execute(run, true);
  }
  const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
  const revision = result?.revisionIds[0] ? getRevision(studio.db, project.id, result.revisionIds[0]) : null;
  results.push({
    projectId: project.id,
    model: run.route.spec.model,
    task: run.task.key,
    language: run.language,
    state: final.state,
    seconds: (Date.now() - started) / 1000,
    cost: result?.cost?.find((c) => c.unit === "USD")?.amount ?? null,
    error: error?.message ?? null,
    revisionId: revision?.id ?? null,
    rawSha: revision?.files.find((f) => f.fileKey === "raw")?.sha256 ?? null,
    imageSha: revision?.files.find((f) => f.fileKey === "image")?.sha256 ?? null,
    report: (revision?.technicalReport as Record<string, unknown>) ?? null,
    retriedAt2K: retry,
  });
  log(`${run.route.spec.model} · ${run.task.key} · ${run.language}: ${final.state} em ${((Date.now() - started) / 1000).toFixed(0)} s${error?.message ? ` · ${error.message.slice(0, 100)}` : ""}`);
}

const queue = [...runs];
const workers = Array.from({ length: CONCURRENCY }, (_, i) => new JobRunner({ ...studio, log: () => undefined }, { workerId: `avaliacao-${i}`, heartbeatMs: 10_000 }));
let submitting = true;
const pump = Promise.all(
  workers.map(async (w) => {
    while (submitting || studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running') AND project_id = :p", { p: project.id })!.n > 0) {
      if (!(await w.runOnce())) await sleep(300);
    }
  }),
);
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let run = queue.shift(); run; run = queue.shift()) await execute(run);
  }),
);
submitting = false;
await pump;

// ---- 4. Resultados ----
const outDir = path.join(REPO_ROOT, "reports", "avaliacao", `${today}-icones-${SIZE}px${LABEL ? `-${LABEL}` : ""}`);
await mkdir(path.join(outDir, "img"), { recursive: true });
for (const r of results) {
  const base = `${r.task}-${r.language}-${slugify(r.model).replaceAll("_", "-")}`;
  if (r.rawSha) await writeFile(path.join(outDir, "img", `${base}-bruta.png`), await readFile(studio.blobs.pathFor(r.rawSha)));
  if (r.imageSha) await writeFile(path.join(outDir, "img", `${base}-final.png`), await readFile(studio.blobs.pathFor(r.imageSha)));
}
const total = results.reduce((n, r) => n + (r.cost ?? 0), 0);
await writeFile(path.join(outDir, "results.json"), JSON.stringify({ date: iso(studio.clock.now()), size: SIZE, projectId: project.id, totalUsd: total, results }, null, 2));
log(`${results.filter((r) => r.state === "succeeded").length}/${results.length} concluídas · custo real US$ ${total.toFixed(4)} · ${path.relative(REPO_ROOT, outDir)}`);
studio.db.close();
