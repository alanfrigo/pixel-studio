/**
 * Ensaio real de "Criar peça para este personagem" (cartão S2) pela rota
 * genérica do OpenRouter.
 *
 *   npx tsx scripts/equipment-real.ts [--max-usd=1] [--models=a,b] [--yes]
 *
 * O OpenRouter só tem imagem + referências: a cobertura vai como CANDIDATO
 * VESTIDO (frames da base + guia da zona autorizada) e a peça é extraída
 * localmente por máscara explícita — nunca anunciada como máscara nativa nem
 * overlay nativo. Cenários sobre o guerreiro sintético da demonstração:
 *   1. pose de prova: gibão de couro no frame `windup` do ataque com escudo (S);
 *   2. só as lacunas: os outros 3 frames desse ataque, numa tira 2×2;
 *   3. golpe amplo (S): 6 frames numa tira 3×2;
 *   4. peça rígida: machado, vista `up` com empunhadura;
 *   5. `manga-zona-ampliada` (só com --scenarios): lacunas da manga com a zona ampliada em 3 px.
 * Depois, os conjuntos A e B (com o gibão no lugar da cota) são compostos
 * localmente para as folhas de contato. Sem --yes só estima (descoberta e
 * saldo são gratuitos). Resultados em reports/equipamentos/<data>/.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OverlayPayload } from "@/contracts";
import { createProject, getAsset, getProject, getRevision, reviewRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { seedEquipmentDemo } from "@/server/equipment/demo";
import { publishLoadout } from "@/server/equipment/loadouts";
import { composeCombo, resolveConfig } from "@/server/equipment/resolve";
import { runCoverage } from "@/server/equipment/service";
import { type CoveragePlan, stripGuide } from "@/server/jobs/handlers/pipelines/equipment";
import { pythonWith } from "@/server/jobs/handlers/pipelines/shared";
import { JobRunner } from "@/server/jobs/runner";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import { openStudio } from "@/server/studio";
import { iso, slugify } from "@/server/util";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MAX_USD = Number(arg("max-usd", "1"));
const CONFIRMED = process.argv.includes("--yes");
const BASE = "https://openrouter.ai/api/v1";
const MODELS = arg("models", "openai/gpt-image-1-mini,openai/gpt-image-2.6-flare").split(",");
/** Continuação: reaproveita um projeto do ensaio, roda só os cenários pedidos e retoma jobs falhos sem reenviar. */
const PROJECT = arg("project", "");
const ONLY = arg("scenarios", "").split(",").filter(Boolean);
const RETRY_FAILED = process.argv.includes("--retry-failed");
/** Teto conservador por imagem quando a rota cobra por token (duas referências de 1024 px). */
const TOKEN_ESTIMATE: Record<string, number> = { "openai/gpt-image-1-mini": 0.05, "openai/gpt-image-2.6-flare": 0.12 };
const SCENARIOS = 4;
const log = (m: string) => console.log(`[equipamentos] ${m}`);

// ---- 1. Descoberta gratuita, estimativa e saldo ----
const routes = [];
for (const model of MODELS) {
  const found = await new OpenRouterAdapter({ id: "d", baseUrl: BASE, secretRef: null, model }, {}).discover(AbortSignal.timeout(30_000));
  const ep = found.find((e) => e.providerTag && e.maxReferences >= 2) ?? found.find((e) => e.maxReferences >= 2);
  if (!ep) {
    log(`${model}: sem rota com 2 referências; ignorado`);
    continue;
  }
  const pricing = ep.pricing as { billable: string; unit: string; cost_usd: number }[];
  const perImage = pricing.filter((p) => p.billable === "output_image" && p.unit === "image").map((p) => p.cost_usd);
  routes.push({ model, tag: ep.providerTag, maxReferences: ep.maxReferences, transparent: ep.transparent, price: perImage.length ? Math.max(...perImage) : null });
}
const perRoute = ONLY.length ? ONLY.length : SCENARIOS;
const maxCost = routes.reduce((n, r) => n + perRoute * Math.max(r.price ?? 0, TOKEN_ESTIMATE[r.model] ?? 0.15), 0);
const keyInfo = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
for (const r of routes) log(`${r.model} · rota ${r.tag} · refs ≤ ${r.maxReferences} · alfa ${r.transparent ? "sim" : "não"} · ${r.price !== null ? `US$ ${r.price}/imagem` : "por token"}`);
log(`${routes.length * perRoute} chamadas · custo máximo estimado US$ ${maxCost.toFixed(2)} (teto US$ ${MAX_USD}) · saldo da chave US$ ${keyInfo.limit_remaining} (uso ${keyInfo.usage})`);
if (maxCost > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (keyInfo.limit_remaining !== null && keyInfo.limit_remaining < maxCost) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

// ---- 2. Projeto dedicado com o guerreiro da demonstração ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const today = iso(studio.clock.now()).slice(0, 10);
const project = PROJECT ? getProject(studio.db, PROJECT) : createProject(studio.db, studio.clock, { name: `Equipamentos real · ${today}` });
const demo = await seedEquipmentDemo(studio, project.id, { withFixture: false });
const worker = new JobRunner({ ...studio, log: () => undefined }, { workerId: "equipment-real", heartbeatMs: 10_000 });
const drain = async () => {
  while (await worker.runOnce()) {
    /* processa a fila */
  }
};
const approve = (revisionId: string) => {
  const rev = getRevision(studio.db, project.id, revisionId);
  const asset = getAsset(studio.db, project.id, rev.assetId);
  reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: asset.id, revisionId, decision: "approve", reason: "Ensaio S2 (aprovação automática do ensaio)", expectedActiveRevisionId: asset.approvedRevisionId });
};
const outDir = path.join(REPO_ROOT, "reports", "equipamentos", today);
await mkdir(outDir, { recursive: true });
// Aprovação explícita (revisão já inspecionada no relatório), ex.: resultado de um job retomado em execução anterior.
for (const rid of arg("approve", "").split(",").filter(Boolean)) {
  approve(rid);
  log(`revisão ${rid} aprovada`);
}
if (PROJECT) {
  // Continuação: jobs ainda na fila (ex.: falha local depois da resposta salva) são processados sem novo envio.
  const pending = studio.queue.list(project.id, { active: true }).map((j) => j.id);
  await drain();
  for (const id of pending) {
    const done = studio.queue.get(id)!;
    const ids = (JSON.parse(done.result_json ?? "null") as { revisionIds: string[] } | null)?.revisionIds ?? [];
    for (const rid of ids) approve(rid);
    log(`${id}: ${done.state}${ids.length ? ` · revisão ${ids.join(", ")} aprovada` : ""}`);
  }
}
if (RETRY_FAILED) {
  // Jobs que falharam DEPOIS de receber a resposta: reprocessa o bruto salvo, sem novo envio nem cobrança.
  const retried: string[] = [];
  for (const job of studio.queue.list(project.id, { active: false }).filter((j) => j.state === "failed")) {
    if (studio.queue.parts(job.id).every((p) => p.remote_state === "completed")) {
      studio.queue.retry(project.id, job.id);
      retried.push(job.id);
      log(`retomando ${job.id} a partir da resposta salva (sem reenviar)`);
    }
  }
  await drain();
  for (const id of retried) {
    const done = studio.queue.get(id)!;
    const ids = (JSON.parse(done.result_json ?? "null") as { revisionIds: string[] } | null)?.revisionIds ?? [];
    for (const rid of ids) approve(rid);
    log(`${id}: ${done.state}${ids.length ? ` · revisão ${ids.join(", ")} aprovada` : ""}`);
  }
}
const env = { blobs: studio.blobs, config: studio.config, signal: AbortSignal.timeout(600_000) };

/** Folha de contato: frames da mesma célula lado a lado em zoom inteiro. */
async function contactSheet(name: string, frames: Uint8Array[], cell: [number, number], background: string | null = null) {
  const shas = [];
  for (const f of frames) shas.push((await studio.blobs.putBytes(f)).sha256);
  const out = await pythonWith(
    { ...env, jobId: "relatorio", attemptId: "relatorio" },
    path.join(studio.config.paths.staging, "equipment-report", `${name}-${Date.now()}`),
    "animation_contact_sheet",
    shas.map((sha256) => ({ role: "layer", sha256 })),
    { version: 1, cell, zoom: 4, background, columns: frames.length, gap: 8 },
  );
  if (out.status === "error") throw new Error(out.message);
  await copyFile(out.outputs[0]!.absolutePath, path.join(outDir, `${name}.png`));
  return `${name}.png`;
}

/** Frames compostos de um conjunto (ou só da peça), na célula do clipe. */
async function frames(overlayIds: string[], stance: string, onlyPiece: string | null) {
  const ctx = resolveConfig(studio, project.id, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: overlayIds, stance, combos: [{ action: "attack", direction: "S" }] });
  const combo = ctx.resolution.combos[0]!;
  const filtered = onlyPiece ? { ...combo, frames: combo.frames.map((f) => ({ ...f, layers: f.layers.filter((l) => l.overlayRevisionId === onlyPiece) })) } : combo;
  const run = await composeCombo({ ...env, db: studio.db }, filtered, 1);
  return { cell: combo.clip!.payload.logicalSize, images: run.outputs.filter((o) => o.role === "frame").map((o) => o.bytes), status: combo.status, pendencies: combo.pendencies.map((p) => p.message) };
}

// ---- 3. Execução ----
const results: Record<string, unknown>[] = [];
let spent = 0;
for (const route of routes) {
  const profileId = `eqp-${slugify(route.model).replaceAll("_", "-")}`.slice(0, 64);
  const tag = slugify(route.model.split("/")[1] ?? route.model).replaceAll("_", "-");
  saveProfile(studio.db, studio.clock, {
    id: profileId,
    name: `Equipamentos (candidato vestido) · ${route.model}`,
    transport: "openrouter_images",
    secretRef: "OPENROUTER_API_KEY",
    model: route.model,
    config: {
      maxReferences: route.maxReferences,
      transparent: route.transparent,
      quality: "medium",
      ...(route.tag ? { provider: { only: [route.tag], allow_fallbacks: false } } : {}),
      ...(route.price !== null ? { pricePerImageUsd: route.price } : {}),
    },
  });
  const description = "brown leather jerkin with brass rivets and short leather sleeves";
  const common = { operation: "generate_overlay_coverage" as const, providerProfileId: profileId, rigRevisionId: demo.rigRevisionId, description, language: "en" as const };
  // Continuação: parte da revisão aprovada mais recente do gibão deste modelo.
  let jerkin: string | null =
    studio.db.get<{ id: string }>("SELECT approved_revision_id AS id FROM assets WHERE project_id = :p AND name = :n AND kind = 'overlay'", { p: project.id, n: `Gibão de couro · ${tag}` })?.id ?? null;
  const scenarios = [
    {
      key: "prova",
      plan: () => ({ ...common, mode: "coverage" as const, item: { slots: ["torso"], stances: ["one_hand_shield", "two_handed"] }, parts: ["torso", "sleeve_near"], clips: [{ clipRevisionId: demo.clips["osh-s"]! }], proofPose: { clipRevisionId: demo.clips["osh-s"]!, frameId: "windup" } }),
    },
    { key: "lacunas-2x2", plan: () => ({ ...common, mode: "coverage" as const, overlayRevisionId: jerkin, parts: ["torso", "sleeve_near"], clips: [{ clipRevisionId: demo.clips["osh-s"]! }], framesPerStrip: 4 }) },
    { key: "golpe-amplo-3x2", plan: () => ({ ...common, mode: "coverage" as const, overlayRevisionId: jerkin, parts: ["torso", "sleeve_near"], clips: [{ clipRevisionId: demo.clips["th-s"]! }], framesPerStrip: 6 }) },
    // Reensaio da manga: a zona derivada da cota fina ficou estreita; amplia 3 px e gera só as lacunas da manga.
    { key: "manga-zona-ampliada", plan: () => ({ ...common, mode: "coverage" as const, overlayRevisionId: jerkin, parts: ["sleeve_near"], clips: [{ clipRevisionId: demo.clips["osh-s"]! }], framesPerStrip: 4, growZonePx: 3 }) },
    {
      key: "machado",
      plan: () => ({
        ...common,
        description: "battle axe with a wooden handle and a single steel blade",
        mode: "rigid_view" as const,
        item: { slots: ["main_hand"], stances: ["one_hand_shield"] },
        view: { viewId: "up", size: [11, 26] as [number, number], grips: [{ socketId: "hand_right", at: [5, 20] as [number, number] }], orientation: "vertical_up" as const },
      }),
    },
  ];
  for (const sc of scenarios.filter((x) => !ONLY.length || ONLY.includes(x.key))) {
    if (spent > MAX_USD) {
      log(`teto atingido (US$ ${spent.toFixed(4)}); ${sc.key} não enviado`);
      break;
    }
    const started = Date.now();
    let entry: Record<string, unknown> = { scenario: sc.key, model: route.model };
    try {
      const run = await runCoverage(studio, project.id, { plan: sc.plan(), newItemName: sc.key === "machado" ? `Machado · ${tag}` : `Gibão de couro · ${tag}`, allowUnknownCost: true });
      await drain();
      const final = studio.queue.get(run.job.id)!;
      const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
      const error = JSON.parse(final.error_json ?? "null") as { message?: string } | null;
      // Custo real do usage.cost de cada parte (vale mesmo se a publicação falhar depois da cobrança).
      const partCosts = studio.queue.parts(run.job.id).map((p) => JSON.parse(p.cost_json ?? "null") as { unit: string; amount: number } | null);
      const cost = partCosts.some((c) => c?.unit === "USD") ? partCosts.reduce((n, c) => n + (c?.unit === "USD" ? c.amount : 0), 0) : null;
      if (run.plan.operation === "generate_overlay_coverage" && run.plan.params.mode === "coverage") {
        const guide = await stripGuide(env, run.plan as CoveragePlan, run.plan.params.strips[0]!);
        await writeFile(path.join(outDir, `${sc.key}-${tag}-guia.png`), guide.guide);
      }
      spent += Number(cost) || 0;
      const revision = result ? getRevision(studio.db, project.id, result.revisionIds[0]!) : null;
      const report = revision?.technicalReport as { warnings?: string[]; parts?: { shifts?: unknown; cells?: unknown }[] } | undefined;
      const prefix = `${sc.key}-${tag}`;
      // Respostas brutas e candidatos normalizados, guardados no job mesmo quando a publicação falha.
      for (const [i, p] of studio.queue.parts(run.job.id).entries()) {
        if (p.raw_blob_sha256) await writeFile(path.join(outDir, `${prefix}-bruta-${i + 1}.png`), await studio.blobs.read(p.raw_blob_sha256));
      }
      if (revision) {
        for (const f of revision.files.filter((x) => x.role === "candidate")) await writeFile(path.join(outDir, `${prefix}-${f.fileKey}.png`), await studio.blobs.read(f.sha256));
        approve(revision.id);
        if (sc.key !== "machado") jerkin = revision.id;
        if (sc.key === "machado") {
          const view = revision.files.find((x) => x.fileKey === "view-up");
          if (view) await writeFile(path.join(outDir, `${prefix}-vista.png`), await studio.blobs.read(view.sha256));
        }
      }
      entry = {
        ...entry,
        state: final.state,
        seconds: (Date.now() - started) / 1000,
        costUsd: cost,
        estimate: run.plan.limits.estimate,
        route: run.summary.routeLabel,
        plan: { toGenerate: run.summary.toGenerate, reused: run.summary.reused, existing: run.summary.existing, strips: run.summary.strips.map((s) => ({ frames: s.frameIds, grid: s.grid, canvas: s.canvas })) },
        revisionId: revision?.id ?? null,
        coverage: revision ? (revision.payload as OverlayPayload).parts.map((p) => ({ partId: p.partId, cells: p.coverage.filter((c) => c.layer).map((c) => c.frameId) })) : null,
        technical: report?.parts ?? null,
        warnings: report?.warnings ?? [],
        error: error?.message ?? null,
        prompt: run.plan.prompt.compiled,
      };
    } catch (err) {
      entry = { ...entry, state: "blocked", error: err instanceof Error ? err.message : String(err), seconds: (Date.now() - started) / 1000, costUsd: 0 };
    }
    results.push(entry);
    log(`${sc.key} · ${route.model}: ${entry.state} em ${Number(entry.seconds).toFixed(0)} s · US$ ${entry.costUsd ?? "?"}${entry.error ? ` · ${entry.error}` : ""}`);
  }

  // ---- 4. Folhas de contato: peça isolada, sobreposta, conjuntos A e B ----
  if (jerkin) {
    const iso2 = await frames([jerkin], "one_hand_shield", jerkin);
    const over = await frames([jerkin], "one_hand_shield", null);
    const isoTh = await frames([jerkin], "two_handed", jerkin);
    const overTh = await frames([jerkin], "two_handed", null);
    const sheets = {
      isolada: await contactSheet(`peca-isolada-ataque-escudo-${tag}`, iso2.images, iso2.cell, null),
      isoladaEscura: await contactSheet(`peca-isolada-escuro-${tag}`, iso2.images, iso2.cell, "#1b1b1f"),
      sobreposta: await contactSheet(`peca-sobreposta-ataque-escudo-${tag}`, over.images, over.cell, null),
      isoladaAmplo: await contactSheet(`peca-isolada-golpe-amplo-${tag}`, isoTh.images, isoTh.cell, null),
      sobrepostaAmplo: await contactSheet(`peca-sobreposta-golpe-amplo-${tag}`, overTh.images, overTh.cell, null),
    };
    const a = await publishLoadout(studio, project.id, { name: `Conjunto A real · ${tag}`, config: { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [jerkin, demo.overlays.shortSword, demo.overlays.shield], combos: [{ action: "attack", direction: "S" }] }, flatten: true });
    const b = await publishLoadout(studio, project.id, { name: `Conjunto B real · ${tag}`, config: { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [jerkin, demo.overlays.longSword], combos: [{ action: "attack", direction: "S" }] }, flatten: true });
    const fa = await frames([jerkin, demo.overlays.shortSword, demo.overlays.shield], "one_hand_shield", null);
    const fb = await frames([jerkin, demo.overlays.longSword], "two_handed", null);
    const setA = await contactSheet(`conjunto-a-${tag}`, fa.images, fa.cell, "#3d8b3d");
    const setB = await contactSheet(`conjunto-b-${tag}`, fb.images, fb.cell, "#3d8b3d");
    results.push({ scenario: "folhas", model: route.model, sheets: { ...sheets, setA, setB }, loadouts: { a: a.revision.id, b: b.revision.id }, statusA: fa.status, statusB: fb.status, pendenciesA: fa.pendencies, pendenciesB: fb.pendencies });
  }
}
// Referência: as mesmas folhas com a cota sintética da demonstração.
const refA = await frames([demo.overlays.mail, demo.overlays.shortSword, demo.overlays.shield], "one_hand_shield", null);
const refB = await frames([demo.overlays.mail, demo.overlays.longSword], "two_handed", null);
await contactSheet("referencia-conjunto-a-cota-sintetica", refA.images, refA.cell, "#3d8b3d");
await contactSheet("referencia-conjunto-b-cota-sintetica", refB.images, refB.cell, "#3d8b3d");
const resultsFile = path.join(outDir, PROJECT ? `results-continuacao-${Date.now()}.json` : "results.json");
await writeFile(resultsFile, JSON.stringify({ date: iso(studio.clock.now()), projectId: project.id, totalUsd: spent, scenarios: ONLY, results }, null, 2));
log(`custo real US$ ${spent.toFixed(4)} · ${path.relative(REPO_ROOT, outDir)}`);
