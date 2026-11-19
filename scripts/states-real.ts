/**
 * Ensaio real do cartão S3 (estados e edição temporal) pela rota genérica do
 * OpenRouter (imagem + referências).
 *
 *   npx tsx scripts/states-real.ts [--max-usd=0.8] [--models=a,b] [--yes]
 *   npx tsx scripts/states-real.ts --resume=<projectId> --only=interpolacao [--models=a] [--yes]
 *     (retoma um projeto de ensaio já criado e roda só os cenários pedidos)
 *
 * Tudo vai como FOLHA desenhada pelo modelo e casada/fatiada localmente,
 * identificada como rota genérica — nunca anunciada como estado, animação de
 * objeto, interpolação ou máscara nativos. Cenários, por modelo:
 *   1. baú fechado: ícone 48×48 gerado → objeto (sem rig) → canvas 64×64 (sem gerar pixels);
 *   2. estado aberto do baú (vista S);
 *   3. animação de abrir: 4 quadros gerados + quadro 0 = vista fechada, pose final = estado aberto;
 *   4. interpolação entre os dois estados (2 intermediários, extremos uma vez só);
 *   5. correção de uma região de um quadro (braço no contato do ataque da Clareira), candidato + recorte local.
 * As rotas nativas (interpolação, trecho, roupa, máscara) são ensaiadas pelo
 * provedor simulado em `src/server/animation/temporal.test.ts`. Sem --yes só
 * estima (descoberta e saldo são gratuitos). Resultados em reports/animacao/<data>-s3/.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pick } from "@/i18n/locales";
import type { BasePayload, ClipPayload } from "@/contracts";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import { runAnimation, runAnimationChecked } from "@/server/animation/service";
import { createObjectFromImage } from "@/server/animation/temporal-service";
import { createAsset, createProject, getAsset, getProject, getRevision, getUpload, reviewRevision, type RevisionView } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { importPortablePackage } from "@/server/export/import";
import { pythonWith } from "@/server/jobs/handlers/pipelines/shared";
import { JobRunner } from "@/server/jobs/runner";
import { resizeCanvas } from "@/server/library/library";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import { buildGenerationPlan, ingestUpload, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso, slugify } from "@/server/util";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MAX_USD = Number(arg("max-usd", "0.8"));
const CONFIRMED = process.argv.includes("--yes");
const BASE = "https://openrouter.ai/api/v1";
const MODELS = arg("models", "openai/gpt-image-1-mini,openai/gpt-image-2.6-flare").split(",");
/** Teto conservador por imagem quando a rota cobra por token. */
const TOKEN_ESTIMATE: Record<string, number> = { "openai/gpt-image-1-mini": 0.04, "openai/gpt-image-2.6-flare": 0.1 };
const RESUME = arg("resume", "");
const ONLY = arg("only", "").split(",").filter(Boolean);
const want = (key: string) => ONLY.length === 0 || ONLY.includes(key);
const SCENARIOS = ONLY.length || 5;
const log = (m: string) => console.log(`[s3] ${m}`);

// ---- 1. Descoberta gratuita, estimativa e saldo ----
const routes = [];
for (const model of MODELS) {
  const found = await new OpenRouterAdapter({ id: "d", baseUrl: BASE, secretRef: null, model }, {}).discover(AbortSignal.timeout(30_000));
  const ep = found.find((e) => e.providerTag && e.maxReferences >= 4) ?? found.find((e) => e.maxReferences >= 4);
  if (!ep) {
    log(`${model}: sem rota com 4 referências (correção com vizinhos); ignorado`);
    continue;
  }
  const pricing = ep.pricing as { billable: string; unit: string; cost_usd: number }[];
  const perImage = pricing.filter((p) => p.billable === "output_image" && p.unit === "image").map((p) => p.cost_usd);
  routes.push({ model, tag: ep.providerTag, maxReferences: ep.maxReferences, transparent: ep.transparent, price: perImage.length ? Math.max(...perImage) : null });
}
const maxCost = routes.reduce((n, r) => n + SCENARIOS * Math.max(r.price ?? 0, TOKEN_ESTIMATE[r.model] ?? 0.15), 0);
const keyInfo = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
for (const r of routes) log(`${r.model} · rota ${r.tag} · refs ≤ ${r.maxReferences} · alfa ${r.transparent ? "sim" : "não"} · ${r.price !== null ? `US$ ${r.price}/imagem` : "por token"}`);
log(`${routes.length * SCENARIOS} chamadas · custo máximo estimado US$ ${maxCost.toFixed(2)} (teto US$ ${MAX_USD}) · saldo da chave US$ ${keyInfo.limit_remaining} (uso ${keyInfo.usage})`);
if (maxCost > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (keyInfo.limit_remaining !== null && keyInfo.limit_remaining < maxCost) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

// ---- 2. Projeto dedicado com a Clareira aprovada ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const today = iso(studio.clock.now()).slice(0, 10);
const project = RESUME ? getProject(studio.db, RESUME) : createProject(studio.db, studio.clock, { name: `Estados e edição temporal · ${today}` });
const fixture = buildClareira();
const revisionMap: Record<string, string> = RESUME
  ? { "warrior-attack-osh-s-v1": studio.db.get<{ id: string }>("SELECT r.id FROM assets a JOIN asset_revisions r ON r.id = a.approved_revision_id WHERE a.project_id = :p AND a.family = 'character' AND a.kind = 'clip' AND json_extract(r.payload_json, '$.action') = 'attack' ORDER BY a.created_at LIMIT 1", { p: project.id })!.id }
  : (await importPortablePackage(studio, project.id, readZip(writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })))), { approve: true })).revisionMap;
const attack = getRevision(studio.db, project.id, revisionMap["warrior-attack-osh-s-v1"]!);
const worker = new JobRunner({ ...studio, log: () => undefined }, { workerId: "states-real", heartbeatMs: 10_000 });
const drain = async () => {
  while (await worker.runOnce()) {
    /* processa a fila */
  }
};
const approve = (revisionId: string) => {
  const rev = getRevision(studio.db, project.id, revisionId);
  const asset = getAsset(studio.db, project.id, rev.assetId);
  reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: asset.id, revisionId, decision: "approve", reason: "Ensaio S3 (aprovação técnica para encadear os cenários)", expectedActiveRevisionId: asset.approvedRevisionId });
};
const outDir = path.join(REPO_ROOT, "reports", "animacao", `${today}-s3`);
await mkdir(outDir, { recursive: true });

// Máscara do braço da espada no quadro `contact` (64×64): 255 edita, 0 protege.
const mask = createImage(64, 64);
fillRect(mask, 0, 0, 64, 64, [0, 0, 0, 255]);
fillRect(mask, 33, 18, 22, 22, [255, 255, 255, 255]);
await writeFile(path.join(outDir, "mascara-contato.png"), encodePng(mask));
const { upload: maskUpload } = await ingestUpload(studio, project.id, { name: "mascara-contato.png", bytes: encodePng(mask) });
await drain();
if (getUpload(studio.db, project.id, maskUpload.id).status !== "ready") throw new Error("Máscara não importada");

// ---- 3. Relatório: folhas de contato ----
const env = { blobs: studio.blobs, config: studio.config, jobId: "relatorio", attemptId: "relatorio", signal: AbortSignal.timeout(600_000) };
let sheetN = 0;
async function framesOf(revision: RevisionView): Promise<string[]> {
  const clip = revision.payload as ClipPayload;
  const files = [...new Set(clip.frames.flatMap((f) => f.layers.map((l) => l.fileId)))];
  const out = await pythonWith(env, path.join(studio.config.paths.staging, "s3-report", `frames-${++sheetN}`), "compose_frames", files.map((fileId) => ({ role: "layer", sha256: revision.files.find((f) => f.fileKey === fileId)!.sha256 })), {
    version: 1,
    cell: clip.logicalSize,
    frames: clip.frames.map((f) => ({ key: f.frameId, layers: f.layers.map((l) => ({ input: files.indexOf(l.fileId), rect: l.rect, offset: l.offset })) })),
    sheet: null,
    emitFrames: true,
  });
  if (out.status === "error") throw new Error(pick(out.message, "pt-BR"));
  const shas = [];
  for (const o of out.outputs.filter((x) => x.role === "frame")) shas.push((await studio.blobs.putFile(o.absolutePath)).sha256);
  return shas;
}
async function contactSheet(name: string, shas: string[], cell: [number, number]) {
  const out = await pythonWith(env, path.join(studio.config.paths.staging, "s3-report", `${name}-${++sheetN}`), "animation_contact_sheet", shas.map((sha256) => ({ role: "layer", sha256 })), {
    version: 1,
    cell,
    zoom: 4,
    background: null,
    columns: shas.length,
    gap: 8,
  });
  if (out.status === "error") throw new Error(pick(out.message, "pt-BR"));
  await copyFile(out.outputs[0]!.absolutePath, path.join(outDir, `${name}.png`));
}
const viewSha = (revision: RevisionView, direction = "S") => revision.files.find((f) => f.fileKey === (revision.payload as BasePayload).views.find((v) => v.direction === direction)!.fileId)!.sha256;

// ---- 4. Execução ----
const results: Record<string, unknown>[] = [];
async function step(model: string, key: string, fn: () => Promise<{ jobId: string; route: string; prompt: string } | null>, after?: (revision: RevisionView) => Promise<void>) {
  const started = Date.now();
  let entry: Record<string, unknown> = { scenario: key, model };
  try {
    const started2 = await fn();
    if (!started2) return null;
    await drain();
    const final = studio.queue.get(started2.jobId)!;
    const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
    const error = JSON.parse(final.error_json ?? "null") as { message?: string } | null;
    const revision = result ? getRevision(studio.db, project.id, result.revisionIds[0]!) : undefined;
    const tag = `${key}-${slugify(model).replaceAll("_", "-")}`;
    if (revision) {
      const raw = revision.files.find((f) => f.role === "raw");
      if (raw) await writeFile(path.join(outDir, `${tag}-bruta.png`), await studio.blobs.read(raw.sha256));
      if (after) await after(revision);
    }
    const report = revision?.technicalReport as { routeLabel?: string; modeLabel?: string; warnings?: string[]; composite?: unknown; frames?: unknown; steps?: unknown } | undefined;
    entry = {
      ...entry,
      route: started2.route,
      state: final.state,
      seconds: (Date.now() - started) / 1000,
      costUsd: result?.cost?.find((x) => x.unit === "USD")?.amount ?? null,
      error: error?.message ?? null,
      revisionId: revision?.id ?? null,
      frames: revision && (revision.payload as ClipPayload).frames ? (revision.payload as ClipPayload).frames.map((f) => ({ frameId: f.frameId, durationMs: f.durationMs })) : null,
      composite: report?.composite ?? null,
      warnings: report?.warnings ?? [],
      prompt: started2.prompt,
    };
    results.push(entry);
    log(`${key} · ${model}: ${entry.state} em ${Number(entry.seconds).toFixed(0)} s · US$ ${entry.costUsd ?? "?"}${entry.error ? ` · ${entry.error}` : ""}`);
    return revision ?? null;
  } catch (err) {
    entry = { ...entry, state: "blocked", error: err instanceof Error ? err.message : String(err), seconds: (Date.now() - started) / 1000, costUsd: 0 };
    results.push(entry);
    log(`${key} · ${model}: bloqueado · ${entry.error}`);
    return null;
  }
}

async function interpolation(model: string, profileId: string, tagOf: (k: string) => string, closed: RevisionView, open: RevisionView) {
  await step(
    model,
    "interpolacao",
    async () => {
      const run = runAnimation(studio, project.id, {
        plan: { operation: "interpolate_frames", providerProfileId: profileId, start: { kind: "view", baseRevisionId: closed.id, direction: "S" }, end: { kind: "view", baseRevisionId: open.id, direction: "S" }, action: "the lid opens", count: 2, transitionMs: 200, newClip: { action: "open", startMs: 150, endMs: 250, playback: "once" }, language: "en" },
      });
      return { jobId: run.job.id, route: run.route.label["pt-BR"], prompt: run.plan.prompt.compiled };
    },
    async (rev) => contactSheet(tagOf("interpolacao-folha"), await framesOf(rev), [64, 64]),
  );
}

for (const route of routes) {
  const profileId = `s3-${slugify(route.model).replaceAll("_", "-")}`.slice(0, 64);
  saveProfile(studio.db, studio.clock, {
    id: profileId,
    name: `S3 (folha por imagem) · ${route.model}`,
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
  const tagOf = (k: string) => `${k}-${slugify(route.model).replaceAll("_", "-")}`;

  // Retomada: reusa o baú (canvas 64×64) e o estado aberto já aprovados deste modelo.
  const named = (name: string) => studio.db.get<{ id: string }>("SELECT approved_revision_id AS id FROM assets WHERE project_id = :p AND name = :n", { p: project.id, n: name.slice(0, 120) })?.id ?? null;
  if (RESUME) {
    const closedId = named(`Baú · ${route.model}`);
    const openId = named(`Baú · ${route.model} · estado open`);
    if (!closedId || !openId) {
      log(`${route.model}: baú/estado aprovados não encontrados no projeto ${project.id}`);
      continue;
    }
    const closedR = getRevision(studio.db, project.id, closedId);
    const openR = getRevision(studio.db, project.id, openId);
    if (want("interpolacao")) await interpolation(route.model, profileId, tagOf, closedR, openR);
    continue;
  }

  // 1. Baú fechado: ícone gerado → objeto → canvas 64×64 (pixels intactos, apoio deslocado).
  const icon = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "misc", name: `Baú fechado (ícone) · ${route.model}`.slice(0, 120) });
  const iconRev = await step(route.model, "bau-fechado", async () => {
    const planned = buildGenerationPlan(studio, project.id, {
      operation: "generate_asset",
      providerProfileId: profileId,
      brief: "a closed wooden treasure chest with iron bands and a gold lock on the front, seen from the front, centered, sitting on the ground",
      params: { family: "item", kind: "misc", logicalSize: [48, 48], transparent: true, variants: 1 },
      language: "en",
    });
    const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: icon.id } }, `s3:icon:${planned.digest}`);
    return { jobId: job.id, route: "ícone por texto (generate_asset)", prompt: planned.plan.prompt.compiled };
  });
  if (!iconRev) continue;
  approve(iconRev.id);
  const created = await createObjectFromImage(studio, project.id, { name: `Baú · ${route.model}`.slice(0, 120), image: { from: "revision", revisionId: iconRev.id, fileKey: "image" }, direction: "S" });
  approve(created.revision.id);
  const grown = await resizeCanvas(studio, project.id, { revisionId: created.revision.id, margins: { left: 8, right: 8, top: 16, bottom: 0 } });
  approve(grown.revision.id);
  const closed = getRevision(studio.db, project.id, grown.revision.id);
  log(`objeto ${route.model}: canvas ${(closed.payload as BasePayload).logicalSize.join("×")}, apoio ${(closed.payload as BasePayload).groundOrigin.join(",")}`);

  // 2. Estado aberto (vista S).
  const open = await step(
    route.model,
    "estado-aberto",
    async () => {
      const run = runAnimation(studio, project.id, { plan: { operation: "create_state", providerProfileId: profileId, sourceRevisionId: closed.id, stateKey: "open", description: "the lid is open and raised, revealing the dark interior with a few gold coins; same wood, iron bands, lock, scale and ground spot", directions: ["S"], language: "en" } });
      return { jobId: run.job.id, route: run.route.label["pt-BR"], prompt: run.plan.prompt.compiled };
    },
    async (rev) => contactSheet(tagOf("estado-aberto-folha"), [viewSha(closed), viewSha(rev)], [64, 64]),
  );
  if (open) approve(open.id);

  // 3. Animação de abrir (keepFirstFrame: a vista fechada é o quadro 0; pose final = estado aberto).
  await step(
    route.model,
    "animacao-abrir",
    async () => {
      const run = runAnimation(studio, project.id, {
        plan: {
          operation: "animate_object",
          providerProfileId: profileId,
          objectRevisionId: closed.id,
          direction: "S",
          action: "open",
          description: "the lid swings open from closed to fully open; only the lid moves, the chest body stays still",
          durationsMs: [90, 90, 110, 200],
          playback: "once",
          keepFirstFrame: true,
          ...(open ? { endFrame: { revisionId: open.id, direction: "S" as const } } : {}),
          language: "en",
        },
      });
      return { jobId: run.job.id, route: run.route.label["pt-BR"], prompt: run.plan.prompt.compiled };
    },
    async (rev) => contactSheet(tagOf("animacao-abrir-folha"), await framesOf(rev), [64, 64]),
  );

  // 4. Interpolação entre os dois estados (2 intermediários).
  if (open) await interpolation(route.model, profileId, tagOf, closed, open);

  // 5. Correção de uma região de um quadro (braço no contato), candidato + recorte local.
  await step(
    route.model,
    "correcao-braco",
    async () => {
      const run = await runAnimationChecked(studio, project.id, {
        plan: { operation: "correct_frame", providerProfileId: profileId, clipRevisionId: attack.id, frameId: "contact", maskUploadId: maskUpload.id, instruction: "bend the sword arm at the elbow a little more; the hand keeps holding the sword grip", mode: "candidate-composite", language: "en" },
      });
      return { jobId: run.job.id, route: run.route.label["pt-BR"], prompt: run.plan.prompt.compiled };
    },
    async (rev) => {
      const before = await framesOf(attack);
      const after = await framesOf(rev);
      const candidate = rev.files.find((f) => f.role === "candidate")!.sha256;
      await contactSheet(tagOf("correcao-braco-folha"), [before[2]!, candidate, after[2]!], [64, 64]);
      await contactSheet(tagOf("correcao-braco-clipe"), after, [64, 64]);
    },
  );
}
const total = results.reduce((n, r) => n + (Number(r.costUsd) || 0), 0);
await writeFile(path.join(outDir, RESUME ? `results-retomada-${ONLY.join("-") || "todos"}.json` : "results.json"), JSON.stringify({ date: iso(studio.clock.now()), projectId: project.id, totalUsd: total, results }, null, 2));
const after = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { usage: number } }).data;
log(`custo real US$ ${total.toFixed(6)} · uso da chave ${keyInfo.usage} → ${after.usage} · ${path.relative(REPO_ROOT, outDir)}`);
studio.db.close();
