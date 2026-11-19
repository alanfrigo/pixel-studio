/**
 * Ensaio real do cartão T1 (mundo): material repetível, tileset guiado,
 * losangos + prop alto e mapa 12×8, pelo OpenRouter (rota genérica de imagem).
 *
 *   npx tsx scripts/world-real.ts [--max-usd=1] [--yes]
 *
 * Sem --yes só descobre rotas (grátis), estima e confere o saldo da chave.
 * Chamadas pagas (6): 3 materiais no gpt-image-1-mini, pedra também no
 * gpt-image-2.6-flare, uma árvore (receita de ícone, alfa nativo) e o tileset
 * guiado pelo gabarito no flare. O resto é local. Resultados em
 * reports/mundo/<data>/ (results.json + imagens; o RELATÓRIO é escrito à parte).
 * Só a rota genérica (imagem + referências) é ensaiada: tileset nativo
 * exige um provedor que declare essa capacidade.
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CornerTilesetPayload, type TexturePayload, TilemapPayload } from "@/contracts";
import { asCornerMap, moveObject, paintCornerVertex } from "@/domain/world/map";
import { createAsset, createProject, getAsset, getRevision, reviewRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { exportFilePath, getExport, requestExport } from "@/server/export/exports";
import { JobRunner } from "@/server/jobs/runner";
import { buildPlan } from "@/server/plan-builders";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import { ingestUpload, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso } from "@/server/util";
import { copyTilemap, createTilemap, openTilemap, publishMapObject, publishTilemap } from "@/server/world/maps";
import { buildTilesetTemplate } from "@/server/world/tilesets";
import { publishTexture } from "@/server/world/textures";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MAX_USD = Number(arg("max-usd", "1"));
const CONFIRMED = process.argv.includes("--yes");
const BASE = "https://openrouter.ai/api/v1";
const MINI = "openai/gpt-image-1-mini";
const FLARE = "openai/gpt-image-2.6-flare";
/** Teto por imagem quando o catálogo cobra por token (conservador). */
const TOKEN_ESTIMATE: Record<string, number> = { [MINI]: 0.05, [FLARE]: 0.1 };
const PYTHON = path.join(REPO_ROOT, "python", ".venv", "bin", "python");
const READER = path.join(REPO_ROOT, "consumers", "portable_reader", "read_portable.py");
const log = (m: string) => console.log(`[mundo] ${m}`);

const MATERIALS = [
  { key: "grama", name: "Grama curta", model: MINI, brief: "grama curta e densa de clareira, tufos pequenos, verde médio com alguns pontos mais escuros" },
  { key: "agua", name: "Água rasa", model: MINI, brief: "água rasa de lago, azul com pequenas ondulações e reflexos claros" },
  { key: "pedra-mini", name: "Pedra úmida (mini)", model: MINI, brief: "chão de pedra úmida, lajes irregulares com musgo verde escuro entre as juntas" },
  { key: "pedra-flare", name: "Pedra úmida (flare)", model: FLARE, brief: "chão de pedra úmida, lajes irregulares com musgo verde escuro entre as juntas" },
];
const CALLS: { model: string; label: string }[] = [
  ...MATERIALS.map((m) => ({ model: m.model, label: `material ${m.key}` })),
  { model: MINI, label: "árvore (prop)" },
  { model: FLARE, label: "tileset guiado" },
];

// ---- 1. Descoberta gratuita, estimativa e saldo ----
const routes: Record<string, { tag: string | null; maxReferences: number; price: number | null }> = {};
for (const model of [MINI, FLARE]) {
  const found = await new OpenRouterAdapter({ id: "d", baseUrl: BASE, secretRef: null, model }, {}).discover(AbortSignal.timeout(30_000));
  const ep = found.find((e) => e.providerTag) ?? found[0];
  if (!ep) throw new Error(`${model}: sem rota no catálogo`);
  const pricing = ep.pricing as { billable: string; unit: string; cost_usd: number }[];
  const perImage = pricing.filter((p) => p.billable === "output_image" && p.unit === "image").map((p) => p.cost_usd);
  routes[model] = { tag: ep.providerTag, maxReferences: ep.maxReferences, price: perImage.length ? Math.max(...perImage) : null };
  log(`${model} · rota ${ep.providerTag} · refs ≤ ${ep.maxReferences} · ${routes[model].price !== null ? `US$ ${routes[model].price}/imagem` : "por token"}`);
}
if (routes[FLARE]!.maxReferences < 3) throw new Error("O tileset guiado precisa de 3 referências (gabarito + 2 materiais)");
const maxCost = CALLS.reduce((n, c) => n + (routes[c.model]!.price ?? TOKEN_ESTIMATE[c.model]!), 0);
const key = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
log(`${CALLS.length} chamadas (${CALLS.map((c) => c.label).join(", ")}) · custo máximo estimado US$ ${maxCost.toFixed(3)} (teto US$ ${MAX_USD}) · saldo da chave US$ ${key.limit_remaining} (uso ${key.usage})`);
if (maxCost > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (key.limit_remaining !== null && key.limit_remaining < maxCost) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

// ---- 2. Projeto dedicado no diretório de dados padrão ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const today = new Date().toLocaleDateString("sv-SE"); // data local (AAAA-MM-DD)
const project = createProject(studio.db, studio.clock, { name: `Mundo real · ${today}` });
const worker = new JobRunner({ ...studio, log: () => undefined }, { workerId: "world-real", heartbeatMs: 10_000 });
const drain = async () => {
  while (await worker.runOnce()) {
    /* processa ingestões e gerações pendentes */
  }
};
const outDir = path.join(REPO_ROOT, "reports", "mundo", today);
await mkdir(outDir, { recursive: true });
const blobPath = (sha: string) => studio.blobs.pathFor(sha);
const save = (sha: string, name: string) => copyFile(blobPath(sha), path.join(outDir, name));
const approve = (assetId: string, revisionId: string) =>
  reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId, revisionId, decision: "approve", reason: null, expectedActiveRevisionId: getAsset(studio.db, project.id, assetId).approvedRevisionId });
const profileFor = (model: string) => {
  const id = model === MINI ? "mundo-mini" : "mundo-flare";
  const r = routes[model]!;
  saveProfile(studio.db, studio.clock, {
    id,
    name: `Mundo · ${model}`,
    transport: "openrouter_images",
    secretRef: "OPENROUTER_API_KEY",
    model,
    config: { maxReferences: r.maxReferences, transparent: true, quality: "medium", ...(r.tag ? { provider: { only: [r.tag], allow_fallbacks: false } } : {}), ...(r.price !== null ? { pricePerImageUsd: r.price } : {}) },
  });
  return id;
};
const profiles: Record<string, string> = { [MINI]: profileFor(MINI), [FLARE]: profileFor(FLARE) };
const results: Record<string, unknown> = { date: iso(studio.clock.now()), projectId: project.id, routes };
const costs: { label: string; model: string; usd: number | null; seconds: number; state: string; error: string | null }[] = [];

async function run(label: string, model: string, planned: { plan: unknown; digest: string }, targetAssetId: string) {
  const started = Date.now();
  const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan as never, planDigest: planned.digest, targetAssetId } }, `world-real:${label}:${today}`);
  await drain();
  const final = studio.queue.get(job.id)!;
  const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
  const error = (JSON.parse(final.error_json ?? "null") as { message?: string } | null)?.message ?? null;
  const usd = result?.cost?.find((c) => c.unit === "USD")?.amount ?? null;
  costs.push({ label, model, usd, seconds: (Date.now() - started) / 1000, state: final.state, error });
  log(`${label} · ${model}: ${final.state} em ${((Date.now() - started) / 1000).toFixed(0)} s · US$ ${usd ?? "?"}${error ? ` · ${error}` : ""}`);
  return result?.revisionIds[0] ?? null;
}

// ---- 3. Materiais ----
const textures: Record<string, { assetId: string; revisionId: string }> = {};
const textureResults = [];
for (const m of MATERIALS) {
  const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "texture", kind: "material", name: m.name });
  const planned = await buildPlan(studio, project.id, {
    operation: "generate_texture",
    providerProfileId: profiles[m.model]!,
    materialBrief: m.brief,
    logicalSize: [32, 32],
    repeatAxes: { x: true, y: true },
  } as never);
  const revisionId = await run(`material ${m.key}`, m.model, planned, asset.id);
  if (!revisionId) continue;
  const rev = getRevision(studio.db, project.id, revisionId);
  const payload = rev.payload as TexturePayload;
  const tr = rev.technicalReport as { verdict: string; receivedSize: number[]; seams: Record<string, unknown>; warnings: string[] };
  const file = (k: string) => rev.files.find((f) => f.fileKey === k)!.sha256;
  await save(file("texture"), `material-${m.key}.png`);
  await save(file("mosaic-lines"), `material-${m.key}-mosaico.png`);
  await save(file("raw"), `material-${m.key}-bruta.png`);
  approve(asset.id, revisionId); // o "artista" do ensaio aprova como material (repetível ou amostra)
  textures[m.key] = { assetId: asset.id, revisionId };
  textureResults.push({ key: m.key, model: m.model, prompt: planned.plan.prompt.compiled, repeatAxes: payload.repeatAxes, verdict: tr.verdict, receivedSize: tr.receivedSize, seams: tr.seams, warnings: tr.warnings });
}
results.textures = textureResults;

// Amostra com borda discrepante deliberada sobre a pedra real: precisa ser destacada, não aprovada.
const stone = textures["pedra-flare"] ?? textures["pedra-mini"];
if (stone) {
  const work = await mkdtemp(path.join(os.tmpdir(), "mundo-"));
  const src = blobPath(getRevision(studio.db, project.id, stone.revisionId).files.find((f) => f.fileKey === "texture")!.sha256);
  const broken = path.join(work, "pedra-borda.png");
  execFileSync(PYTHON, ["-I", "-c", "import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGBA')\nfor y in range(im.height):\n  r,g,b,a=im.getpixel((im.width-1,y)); im.putpixel((im.width-1,y),(r//4,g//4,b//4,a))\nim.save(sys.argv[2])", src, broken]);
  const { upload } = await ingestUpload(studio, project.id, { name: "pedra-borda-discrepante.png", bytes: new Uint8Array(await readFile(broken)) });
  await drain();
  const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "texture", kind: "material", name: "Pedra com borda discrepante (teste)" });
  const res = await publishTexture(studio, project.id, asset.id, { image: { from: "upload", uploadId: upload.id }, material: "pedra com borda discrepante deliberada", axes: { x: true, y: true } });
  await save(res.revision.files.find((f) => f.fileKey === "mosaic-lines")!.sha256, "material-pedra-borda-discrepante-mosaico.png");
  results.discrepant = { repeatAxes: (res.revision.payload as TexturePayload).repeatAxes, verdict: res.verdict, x: res.report.x, y: res.report.y };
  log(`borda discrepante: ${res.verdict}`);
  await rm(work, { recursive: true, force: true });
}

// ---- 4. Tileset por cantos: gabarito local + geração guiada ----
let guidedRevisionId: string | null = null;
let tilesetAssetId: string | null = null;
let templateRevisionId: string | null = null;
if (textures.grama && textures.agua) {
  const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "tileset", kind: "corner", name: "Grama ↔ água (real)" });
  tilesetAssetId = asset.id;
  const tpl = await buildTilesetTemplate(studio, project.id, asset.id, {
    kind: "corner",
    materialA: textures.grama.revisionId,
    materialB: textures.agua.revisionId,
    terrains: [
      { terrainId: "grass", name: "Grama", color: "#469632" },
      { terrainId: "water", name: "Água", color: "#3264c8" },
    ],
    diagonals: { mask5: "separate", mask10: "connected" },
  });
  templateRevisionId = tpl.revision.id;
  const f = (rev: { files: { fileKey: string; sha256: string }[] }, k: string) => rev.files.find((x) => x.fileKey === k)?.sha256;
  await save(f(tpl.revision, "atlas")!, "tileset-gabarito-atlas.png");
  if (f(tpl.revision, "check-sample-zoom")) await save(f(tpl.revision, "check-sample-zoom")!, "tileset-gabarito-amostra.png");
  approve(asset.id, tpl.revision.id);
  const planned = await buildPlan(studio, project.id, {
    operation: "generate_tileset",
    providerProfileId: profiles[FLARE]!,
    guideRevisionId: tpl.revision.id,
    instruction: "grama de clareira com tufos e flores pequenas; água rasa com reflexos; margem com areia úmida fina entre as duas",
    lockedBandPx: 4,
    materialRevisionIds: [textures.grama.revisionId, textures.agua.revisionId],
  } as never);
  guidedRevisionId = await run("tileset guiado", FLARE, planned, asset.id);
  results.tileset = { template: { revisionId: tpl.revision.id, check: tpl.check.report, warnings: tpl.check.warnings }, guidedPrompt: planned.plan.prompt.compiled };
  if (guidedRevisionId) {
    const g = getRevision(studio.db, project.id, guidedRevisionId);
    await save(f(g, "atlas")!, "tileset-guiado-atlas.png");
    await save(f(g, "guided-candidate")!, "tileset-guiado-candidato.png");
    await save(f(g, "raw")!, "tileset-guiado-bruta.png");
    for (const [k, n] of [["check-sample-zoom", "amostra"], ["check-pairs", "pares"]] as const) if (f(g, k)) await save(f(g, k)!, `tileset-guiado-${n}.png`);
    (results.tileset as Record<string, unknown>).guided = { revisionId: guidedRevisionId, report: g.technicalReport };
  }
}

// ---- 5. Árvore (receita de ícone com alfa) → objeto top-down e prop isométrico ----
const treeItem = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "misc", name: "Árvore alta" });
const treePlan = await buildPlan(studio, project.id, {
  operation: "generate_asset",
  providerProfileId: profiles[MINI]!,
  brief: "árvore alta de copa redonda e cheia, tronco marrom visível embaixo, vista de cima em três-quartos, inteira no quadro",
  params: { family: "item", kind: "misc", logicalSize: [32, 48], transparent: true, variants: 1 },
} as never);
const treeRevisionId = await run("árvore (prop)", MINI, treePlan, treeItem.id);
let mapResult: Record<string, unknown> | null = null;
if (treeRevisionId) {
  const tree = getRevision(studio.db, project.id, treeRevisionId);
  approve(treeItem.id, treeRevisionId);
  await save(tree.files.find((f) => f.fileKey === "image")!.sha256, "arvore.png");
  // Apoio: base visual medida localmente no prop (o iso_check confere de novo).
  let support: [number, number] = [16, 48];
  // Chão do isométrico: a grama se ela passou como material; senão a pedra (relatado).
  const floorKey = textureResults.find((t) => t.key === "grama" && t.repeatAxes.x && t.repeatAxes.y) ? "grama" : "pedra-mini";
  if (textures[floorKey]) {
    const isoAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "tileset", kind: "isometric", name: "Clareira iso" });
    const isoTpl = await buildTilesetTemplate(studio, project.id, isoAsset.id, {
      kind: "isometric",
      floor: textures[floorKey]!.revisionId,
      prop: { image: { from: "revision", revisionId: treeRevisionId, fileKey: "image" }, name: "Árvore alta", occluderRect: [0, 0, 32, 30] },
    });
    const propPiece = (isoTpl.revision.payload as { pieces: { kind: string; supportPoint: [number, number] }[] }).pieces.find((p) => p.kind === "prop");
    if (propPiece) support = propPiece.supportPoint;
    const z = isoTpl.revision.files.find((f) => f.fileKey === "check-patch-zoom");
    if (z) await save(z.sha256, "iso-retalho.png");
    await save(isoTpl.revision.files.find((f) => f.fileKey === "atlas")!.sha256, "iso-atlas.png");
    results.iso = { floor: floorKey, check: isoTpl.check.report, warnings: isoTpl.check.warnings, support };
  }

  // ---- 6. Mapa 12×8: lago, árvore, portas; mover, repintar, reabrir, exportar ----
  const tilesetRev = guidedRevisionId ?? templateRevisionId;
  if (tilesetRev && tilesetAssetId) {
    if (guidedRevisionId) approve(tilesetAssetId, guidedRevisionId);
    const objAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "object", name: "Árvore" });
    const obj = publishMapObject(studio, project.id, objAsset.id, {
      image: { from: "revision", revisionId: treeRevisionId, fileKey: "image" },
      supportPoint: support,
      // Colisão revisada: só o tronco (6×6 acima do apoio), dentro da imagem.
      collision: [[Math.min(26, Math.max(0, support[0] - 3)), Math.min(42, Math.max(0, support[1] - 6)), 6, 6]],
      occlusionAboveY: Math.max(0, support[1] - 10),
    });
    approve(objAsset.id, obj.id);
    const ts = getRevision(studio.db, project.id, tilesetRev).payload as CornerTilesetPayload;
    const { asset: mapAsset, draft } = createTilemap(studio, project.id, { name: "Clareira 12×8 (real)", tilesetRevisionId: tilesetRev });
    let map = asCornerMap(TilemapPayload.parse(draft.payload));
    for (let vy = 2; vy <= 5; vy++) for (let vx = 5; vx <= 8; vx++) if (!(vx === 8 && vy === 2)) map = paintCornerVertex(map, ts, vx, vy, 1).map;
    map = paintCornerVertex(map, ts, 6, 4, 0).map; // ilha
    const first = publishTilemap(studio, project.id, mapAsset.id, {
      payload: {
        ...map,
        objects: [{ objectId: "arvore-1", objectRevisionId: obj.id, pieceKey: null, cell: [2, 2], offsetPx: [0, 0], label: "Árvore" }],
        regions: [{ regionId: "clareira", name: "Clareira", kind: "area", rect: [0, 0, 5, 8] }],
        entrances: [
          { entranceId: "porta-oeste", name: "Oeste", cell: [0, 6], side: "W" },
          { entranceId: "porta-leste", name: "Leste", cell: [11, 1], side: "E" },
        ],
        passages: [{ from: "porta-oeste", to: "porta-leste" }],
      },
    });
    const reopened = openTilemap(studio, project.id, mapAsset.id, { revisionId: first.revision.id });
    const second = paintCornerVertex(asCornerMap(moveObject(reopened.payload, "arvore-1", [9, 6], [0, 0])), ts, 2, 6, 1).map;
    const republished = publishTilemap(studio, project.id, mapAsset.id, { payload: second });
    approve(mapAsset.id, republished.revision.id);
    const copy = templateRevisionId && guidedRevisionId ? copyTilemap(studio, project.id, mapAsset.id, { revisionId: republished.revision.id, name: "Cópia com o gabarito", tilesetRevisionId: templateRevisionId }) : null;
    // Exportar pelo X1 e reconstruir no consumidor independente.
    const { export: requested } = requestExport(studio, project.id, { revisionIds: [republished.revision.id], profile: "portable-v1" });
    await drain();
    const ready = getExport(studio.db, project.id, requested.id);
    const zipPath = exportFilePath(studio.config.paths.exports, ready);
    const work = await mkdtemp(path.join(os.tmpdir(), "mundo-pacote-"));
    execFileSync(PYTHON, [READER, zipPath, path.join(work, "out")]);
    const summary = JSON.parse(await readFile(path.join(work, "out", "summary.json"), "utf8")) as { entries: { kind: string; file?: string }[] };
    const tm = summary.entries.find((e) => e.kind === "tilemap")!;
    execFileSync(PYTHON, ["-I", "-c", "import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]); im.resize((im.width*2, im.height*2), Image.Resampling.NEAREST).save(sys.argv[2])", path.join(work, "out", tm.file!), path.join(outDir, "mapa-12x8-consumidor.png")]);
    await rm(work, { recursive: true, force: true });
    mapResult = {
      firstRevision: { id: first.revision.id, passages: first.passages, missing: first.missing },
      secondRevision: { id: republished.revision.id, passages: republished.passages, objects: (getRevision(studio.db, project.id, republished.revision.id).payload as { objects: unknown[] }).objects },
      copyAssetId: copy?.asset.id ?? null,
      export: { state: ready.state, report: ready.report },
      consumer: tm,
    };
  }
}
results.map = mapResult;
results.tree = { revisionId: treeRevisionId };
results.costs = costs;
const total = costs.reduce((n, c) => n + (c.usd ?? 0), 0);
results.totalUsd = total;
await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
log(`custo real US$ ${total.toFixed(4)} · ${path.relative(REPO_ROOT, outDir)} · projeto ${project.id}`);
studio.db.close();
