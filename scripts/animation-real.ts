/**
 * Ensaio real de animação e vistas (cartão S1) pela rota genérica do OpenRouter.
 *
 *   npx tsx scripts/animation-real.ts [--max-usd=1] [--models=a,b] [--yes]
 *
 * O OpenRouter só tem imagem + referências: cada modo vai como FOLHA desenhada
 * pelo modelo e fatiada localmente — identificado como tal, nunca anunciado
 * como animação nativa, esqueleto estruturado ou rotação nativa. Cenários
 * sobre o guerreiro da Clareira (base aprovada, vista S):
 *   1. um clique: preset "walk" (6 quadros, folha 3×2);
 *   2. texto livre: pulo (4 quadros, folha 2×2);
 *   3. esqueleto via guia de poses em imagem: ataque com escudo (4 poses);
 *   4. vista nova E (arte nova, assimetrias declaradas).
 * O modo esqueleto com poses como DADOS (PixelLab) não tem credencial aqui.
 * Sem --yes só estima (descoberta e saldo são gratuitos). Resultados em
 * reports/animacao/<data>/.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClipPayload, MotionPayload } from "@/contracts";
import { findPreset } from "@/domain/animation/presets";
import { defaultHumanoidPose, humanoidSkeleton, presetPoses } from "@/domain/animation/skeleton";
import { renderPoseGuide } from "@/domain/animation/pose-guide";
import { buildClareira } from "@/fixtures/clareira";
import { readZip, writeZip } from "@/lib/zip";
import { runAnimation, saveMotion } from "@/server/animation/service";
import { createProject, getAsset, getRevision, reviewRevision, type RevisionView } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { importPortablePackage } from "@/server/export/import";
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
/** Teto conservador por imagem quando a rota cobra por token (folhas 3:2 custam mais que 1:1). */
const TOKEN_ESTIMATE: Record<string, number> = { "openai/gpt-image-1-mini": 0.04, "openai/gpt-image-2.6-flare": 0.1 };
const log = (m: string) => console.log(`[animação] ${m}`);

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
const SCENARIOS = 4;
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
const project = createProject(studio.db, studio.clock, { name: `Animação real · ${today}` });
const fixture = buildClareira();
const { revisionMap } = await importPortablePackage(studio, project.id, readZip(writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })))), { approve: true });
const base = getRevision(studio.db, project.id, revisionMap["warrior-base-v1"]!);
const worker = new JobRunner({ ...studio, log: () => undefined }, { workerId: "animation-real", heartbeatMs: 10_000 });
const drain = async () => {
  while (await worker.runOnce()) {
    /* processa a fila */
  }
};
const approve = (revisionId: string) => {
  const rev = getRevision(studio.db, project.id, revisionId);
  const asset = getAsset(studio.db, project.id, rev.assetId);
  reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: asset.id, revisionId, decision: "approve", reason: "Ensaio S1", expectedActiveRevisionId: asset.approvedRevisionId });
};

// Movimento aprovado (ataque com escudo, 4 poses) a partir do esqueleto padrão ajustado à base.
const attack = findPreset("attack-shield")!;
const ref = defaultHumanoidPose("S", [64, 64], [12, 10, 34, 50]);
const motion: MotionPayload = {
  skeleton: humanoidSkeleton(),
  generationCell: [64, 64],
  direction: "S",
  projection: "top_down",
  action: "attack",
  referencePose: ref,
  poses: presetPoses(attack.poseRecipe, ref, "S", 4).map((joints, i) => ({ poseId: attack.frameIds[i]!, durationMs: attack.durationsMs[i]!, joints })),
  loop: false,
  jointSocketMap: [],
};
const savedMotion = saveMotion(studio, project.id, { baseRevisionId: base.id, motion, presetKey: attack.key });
approve(savedMotion.revision.id);

const outDir = path.join(REPO_ROOT, "reports", "animacao", today);
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "guia-de-poses-ataque.png"),
  renderPoseGuide({ skeleton: motion.skeleton, poses: motion.poses.map((p) => p.joints), columns: 2, rows: 2, cell: [64, 64], scale: 4, background: [255, 255, 255, 255] }),
);

// ---- 3. Execução ----
const env = { blobs: studio.blobs, config: studio.config, jobId: "relatorio", attemptId: "relatorio", signal: AbortSignal.timeout(600_000) };
async function contactSheet(name: string, shas: string[], columns: number) {
  const out = await pythonWith(env, path.join(studio.config.paths.staging, "animation-report", name), "animation_contact_sheet", shas.map((sha256) => ({ role: "layer", sha256 })), {
    version: 1,
    cell: [64, 64],
    zoom: 4,
    background: null,
    columns,
    gap: 8,
  });
  if (out.status === "error") throw new Error(out.message);
  await copyFile(out.outputs[0]!.absolutePath, path.join(outDir, `${name}.png`));
}

const results = [];
for (const route of routes) {
  const profileId = `anim-${slugify(route.model).replaceAll("_", "-")}`.slice(0, 64);
  saveProfile(studio.db, studio.clock, {
    id: profileId,
    name: `Animação (folha por imagem) · ${route.model}`,
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
  const common = { providerProfileId: profileId, baseRevisionId: base.id, language: "en" as const };
  const scenarios = [
    { key: "um-clique-walk", plan: { operation: "animate_preset" as const, ...common, direction: "S" as const, presetKey: "walk", costCeiling: { amount: 0.2, unit: "USD" } }, oneClick: true },
    { key: "texto-pulo", plan: { operation: "animate_text" as const, ...common, direction: "S" as const, actionText: "jumps straight up in place: crouch, take off, top of the jump with knees tucked, land", durationsMs: [120, 90, 160, 120], playback: "once" as const }, oneClick: false },
    { key: "guia-de-poses-ataque", plan: { operation: "animate_skeleton" as const, ...common, motionRevisionId: savedMotion.revision.id, actionText: "short one-handed sword strike", playback: "once" as const }, oneClick: false },
    { key: "vista-leste", plan: { operation: "rotate_views" as const, ...common, view: "E" as const, asymmetries: ["the sword stays in the right hand", "the shield stays on the left arm"] }, oneClick: false },
  ];
  for (const sc of scenarios) {
    const started = Date.now();
    let entry: Record<string, unknown> = { scenario: sc.key, model: route.model };
    try {
      // Rota cobrada por token: o atalho só envia com o custo desconhecido aceito explicitamente (configuração do preset).
      const run = runAnimation(studio, project.id, { plan: sc.plan, oneClick: sc.oneClick, allowUnknownCost: sc.oneClick });
      await drain();
      const final = studio.queue.get(run.job.id)!;
      const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
      const error = JSON.parse(final.error_json ?? "null") as { message?: string } | null;
      const revision: RevisionView | undefined = result ? getRevision(studio.db, project.id, result.revisionIds[0]!) : undefined;
      const tag = `${sc.key}-${slugify(route.model).replaceAll("_", "-")}`;
      const report = revision?.technicalReport as { routeLabel?: string; warnings?: string[]; frames?: { details?: { sheet?: unknown } }[]; steps?: unknown[] } | undefined;
      if (revision) {
        const raw = revision.files.find((f) => f.role === "raw");
        if (raw) await writeFile(path.join(outDir, `${tag}-bruta.png`), await studio.blobs.read(raw.sha256));
        const frames = revision.files.filter((f) => f.role === "frame" || f.role === "view").sort((a, b) => a.idx - b.idx);
        const baseView = base.files.find((f) => f.fileKey === "warrior-base-s")!;
        await contactSheet(`${tag}-folha`, [baseView.sha256, ...frames.map((f) => f.sha256)], frames.length + 1);
      }
      entry = {
        ...entry,
        operation: sc.plan.operation,
        route: run.route.label,
        state: final.state,
        seconds: (Date.now() - started) / 1000,
        costUsd: result?.cost?.find((x) => x.unit === "USD")?.amount ?? null,
        estimate: run.plan.limits.estimate,
        error: error?.message ?? null,
        revisionId: revision?.id ?? null,
        frames: revision ? (revision.payload as ClipPayload).frames?.map((f) => ({ frameId: f.frameId, durationMs: f.durationMs })) ?? null : null,
        sheet: report?.frames?.[0]?.details?.sheet ?? null,
        warnings: report?.warnings ?? [],
        prompt: run.plan.prompt.compiled,
      };
    } catch (err) {
      entry = { ...entry, state: "blocked", error: err instanceof Error ? err.message : String(err), seconds: (Date.now() - started) / 1000, costUsd: 0 };
    }
    results.push(entry);
    log(`${sc.key} · ${route.model}: ${entry.state} em ${Number(entry.seconds).toFixed(0)} s · US$ ${entry.costUsd ?? "?"}${entry.error ? ` · ${entry.error}` : ""}`);
  }
}
const total = results.reduce((n, r) => n + (Number(r.costUsd) || 0), 0);
await writeFile(path.join(outDir, "results.json"), JSON.stringify({ date: iso(studio.clock.now()), projectId: project.id, totalUsd: total, results }, null, 2));
log(`custo real US$ ${total.toFixed(4)} · ${path.relative(REPO_ROOT, outDir)}`);
studio.db.close();
