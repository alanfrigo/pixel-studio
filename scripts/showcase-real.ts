/**
 * Vitrine do README: arte gerada de verdade por IA pelo pipeline do Studio.
 *
 *   npx tsx scripts/showcase-real.ts                 # simulação: rota, estimativa e saldo; nada é enviado
 *   npx tsx scripts/showcase-real.ts --max-usd=1.5 --yes
 *   npx tsx scripts/showcase-real.ts --only=knight,oak --yes   # refaz só alguns casos
 *
 * Cada caso passa pela fila real (plano congelado, adaptador OpenRouter,
 * recuperação da grade de pixels, ajuste ao tamanho lógico). Nada é retocado à
 * mão. Saída em reports/vitrine/<data>/ (results.json + PNGs a 1×); a
 * composição das imagens do README fica em scripts/showcase-compose.py.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAsset, createProject, getRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { JobRunner } from "@/server/jobs/runner";
import { buildPlan } from "@/server/plan-builders";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import { submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso, sleep } from "@/server/util";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MAX_USD = Number(arg("max-usd", "1.5"));
const CONFIRMED = process.argv.includes("--yes");
const ONLY = arg("only", "").split(",").filter(Boolean);
const MODEL = arg("model", "openai/gpt-image-2.6-flare");
const BASE = "https://openrouter.ai/api/v1";
/** Materiais em 64×64 por padrão: em 32×32 a redução apaga a forma das pedras. */
const TEXTURE_SIDE = Number(arg("texture-size", "64"));
const ESTIMATE_PER_IMAGE = 0.08; // conservador: a rota cobra por token (~US$ 0,045 observado)

type Group = "icon" | "character" | "prop" | "texture";
interface Case {
  key: string;
  group: Group;
  size: [number, number];
  brief: string;
}

const CASES: Case[] = [
  // Ícones de item, 32×32
  { key: "potion", group: "icon", size: [32, 32], brief: "red health potion in a round glass flask with a cork stopper and a small highlight" },
  { key: "sword", group: "icon", size: [32, 32], brief: "steel longsword with a golden crossguard and a blue leather grip, pointing up and to the right" },
  { key: "shield", group: "icon", size: [32, 32], brief: "round wooden shield with an iron rim and a central iron boss" },
  { key: "chest", group: "icon", size: [32, 32], brief: "small wooden treasure chest with gold trim and a keyhole, closed" },
  { key: "key", group: "icon", size: [32, 32], brief: "ornate golden key, diagonal" },
  { key: "gem", group: "icon", size: [32, 32], brief: "faceted blue crystal gem with a bright sparkle" },
  { key: "spellbook", group: "icon", size: [32, 32], brief: "purple leather spell book with a glowing golden rune on the cover" },
  { key: "mushroom", group: "icon", size: [32, 32], brief: "red mushroom with white spots and a pale stem" },
  { key: "staff", group: "icon", size: [32, 32], brief: "wooden magic staff topped with a glowing violet orb, diagonal" },
  { key: "helmet", group: "icon", size: [32, 32], brief: "iron knight helmet with a visor slit and a red plume" },
  { key: "coins", group: "icon", size: [32, 32], brief: "small pile of shiny gold coins" },
  { key: "bomb", group: "icon", size: [32, 32], brief: "round black bomb with a lit fuse and a spark" },
  // Personagens, 64×64, vista frontal de jogo
  { key: "knight", group: "character", size: [64, 64], brief: "full body game character sprite of a knight in silver armor with a red cape and a sword, standing, front view facing the viewer" },
  { key: "wizard", group: "character", size: [64, 64], brief: "full body game character sprite of an old wizard in a blue robe and pointed hat holding a wooden staff, standing, front view" },
  { key: "ranger", group: "character", size: [64, 64], brief: "full body game character sprite of a female ranger in a green hooded cloak holding a bow, standing, front view" },
  { key: "slime", group: "character", size: [64, 64], brief: "cute green slime monster with big eyes, game enemy sprite, front view" },
  // Props de cenário, 64×64
  { key: "oak", group: "prop", size: [64, 64], brief: "leafy oak tree with a thick brown trunk, top-down RPG map prop seen at three-quarter angle" },
  { key: "well", group: "prop", size: [64, 64], brief: "stone water well with a small wooden roof and a bucket, RPG map prop at three-quarter angle" },
  { key: "campfire", group: "prop", size: [64, 64], brief: "campfire with burning logs, orange flames and a ring of stones, RPG map prop" },
  // Materiais repetíveis (generate_texture), 64×64 por padrão (generate_texture: validação local de emendas)
  { key: "cobblestone", group: "texture", size: [TEXTURE_SIDE, TEXTURE_SIDE], brief: "mossy grey cobblestone path" },
  { key: "grass", group: "texture", size: [TEXTURE_SIDE, TEXTURE_SIDE], brief: "lush green meadow grass with tiny flowers" },
  { key: "lava", group: "texture", size: [TEXTURE_SIDE, TEXTURE_SIDE], brief: "molten lava with dark cooled crust" },
];
const runs = CASES.filter((c) => ONLY.length === 0 || ONLY.includes(c.key));

function log(msg: string) {
  console.log(`[vitrine] ${msg}`);
}

// ---- 1. Rota, estimativa e saldo (grátis) ----
const found = await new OpenRouterAdapter({ id: "d", baseUrl: BASE, secretRef: null, model: MODEL }, {}).discover(AbortSignal.timeout(30_000));
const ep = found.find((e) => e.providerTag) ?? found[0];
if (!ep) throw new Error(`${MODEL}: sem rota no OpenRouter`);
const maxCost = runs.length * ESTIMATE_PER_IMAGE;
const keyInfo = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
log(`${MODEL} · rota ${ep.providerTag} · alfa ${ep.transparent ? "sim" : "não"} · ${runs.length} imagens · custo máximo estimado US$ ${maxCost.toFixed(2)} (teto US$ ${MAX_USD}) · saldo da chave US$ ${keyInfo.limit_remaining} (uso ${keyInfo.usage})`);
if (maxCost > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (keyInfo.limit_remaining !== null && keyInfo.limit_remaining < maxCost) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

// ---- 2. Projeto e perfil ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const today = iso(studio.clock.now()).slice(0, 10);
const project = createProject(studio.db, studio.clock, { name: `Vitrine do README · ${today}` });
const profileId = "vitrine-flare";
saveProfile(studio.db, studio.clock, {
  id: profileId,
  name: `Vitrine · ${MODEL}`,
  transport: "openrouter_images",
  secretRef: "OPENROUTER_API_KEY",
  model: MODEL,
  config: { maxReferences: ep.maxReferences, transparent: ep.transparent, quality: "medium", aspectRatio: "1:1", ...(ep.providerTag ? { provider: { only: [ep.providerTag], allow_fallbacks: false } } : {}) },
});
log(`projeto "${project.name}" (${project.id})`);

// ---- 3. Execução pela fila real ----
interface Result {
  key: string;
  group: Group;
  size: [number, number];
  brief: string;
  state: string;
  cost: number | null;
  seconds: number;
  error: string | null;
  revisionId: string | null;
  files: Record<string, string>;
  report: unknown;
}
const results: Result[] = [];

async function execute(c: Case): Promise<void> {
  const started = Date.now();
  const asset =
    c.group === "texture"
      ? createAsset(studio.db, studio.clock, { projectId: project.id, family: "texture", kind: "material", name: c.key })
      : createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: c.group === "icon" ? "gear" : "misc", name: c.key });
  const planned =
    c.group === "texture"
      ? await buildPlan(studio, project.id, { operation: "generate_texture", providerProfileId: profileId, materialBrief: c.brief, logicalSize: c.size, repeatAxes: { x: true, y: true }, language: "en" } as never)
      : await buildPlan(studio, project.id, {
          operation: "generate_asset",
          providerProfileId: profileId,
          brief: c.brief,
          language: "en",
          params: { family: "item", kind: c.group === "icon" ? "gear" : "misc", logicalSize: c.size, transparent: true, variants: 1 },
          references: [],
        } as never);
  const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan as never, planDigest: planned.digest, targetAssetId: asset.id } }, `vitrine:${asset.id}`);
  let final = studio.queue.get(job.id)!;
  while (!["succeeded", "failed", "cancelled", "needs_attention"].includes(final.state)) {
    await sleep(500);
    final = studio.queue.get(job.id)!;
  }
  const error = (JSON.parse(final.error_json ?? "null") as { message?: string } | null)?.message ?? null;
  const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
  const revision = result?.revisionIds[0] ? getRevision(studio.db, project.id, result.revisionIds[0]) : null;
  results.push({
    key: c.key,
    group: c.group,
    size: c.size,
    brief: c.brief,
    state: final.state,
    cost: result?.cost?.find((x) => x.unit === "USD")?.amount ?? null,
    seconds: (Date.now() - started) / 1000,
    error,
    revisionId: revision?.id ?? null,
    files: Object.fromEntries((revision?.files ?? []).filter((f) => f.mime === "image/png").map((f) => [f.fileKey, f.sha256])),
    report: revision?.technicalReport ?? null,
  });
  log(`${c.key}: ${final.state} em ${((Date.now() - started) / 1000).toFixed(0)} s${error ? ` · ${error.slice(0, 140)}` : ""}`);
}

const CONCURRENCY = 4;
const queue = [...runs];
const workers = Array.from({ length: CONCURRENCY }, (_, i) => new JobRunner({ ...studio, log: () => undefined }, { workerId: `vitrine-${i}`, heartbeatMs: 10_000 }));
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
    for (let c = queue.shift(); c; c = queue.shift()) await execute(c);
  }),
);
submitting = false;
await pump;

// ---- 4. Arquivos ----
const outDir = path.join(REPO_ROOT, "reports", "vitrine", today);
await mkdir(outDir, { recursive: true });
for (const r of results) {
  for (const [fileKey, sha] of Object.entries(r.files)) {
    await writeFile(path.join(outDir, `${r.key}-${fileKey}.png`), await readFile(studio.blobs.pathFor(sha)));
  }
}
const resultsPath = path.join(outDir, "results.json");
const previous = await readFile(resultsPath, "utf8")
  .then((t) => JSON.parse(t) as { results: Result[]; totalUsd: number })
  .catch(() => ({ results: [] as Result[], totalUsd: 0 }));
const merged = [...previous.results.filter((p) => !results.some((r) => r.key === p.key)), ...results];
const spent = results.reduce((n, r) => n + (r.cost ?? 0), 0);
await writeFile(resultsPath, JSON.stringify({ date: iso(studio.clock.now()), model: MODEL, projectId: project.id, totalUsd: previous.totalUsd + spent, results: merged }, null, 2));
log(`${results.filter((r) => r.state === "succeeded").length}/${results.length} concluídas · custo real desta rodada US$ ${spent.toFixed(4)} · ${path.relative(REPO_ROOT, outDir)}`);
studio.db.close();
