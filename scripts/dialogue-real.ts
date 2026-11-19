/**
 * Ensaio real do cartão D1 (retratos, fala e fontes) pelo OpenRouter (rota genérica).
 *
 *   npx tsx scripts/dialogue-real.ts [--model=openai/gpt-image-1-mini] [--max-usd=0.8] [--glyph=8] [--yes]
 *
 * Sem --yes só descobre a rota (grátis), estima o custo máximo e confere o
 * saldo da chave (`limit_remaining`); nada é enviado.
 *
 * Com --yes (pagas: 1 retrato, 2 folhas de bocas, as páginas de glyphs do kit
 * pt-BR e, se faltar glyph, as páginas da extensão): o guerreiro da fixture
 * vira personagem aprovado; o retrato sai por imagem + referência da vista; as
 * regiões sugeridas são aceitas como revisão; as expressões neutra e feliz
 * saem como folhas 4 × 2; duas falas são planejadas localmente (zero jobs); a
 * fonte sai pelo gabarito, a cobertura lista os ausentes e a extensão os
 * desenha com referência dos glyphs aprovados. Exporta pelo X1 e roda o leitor
 * independente. Resultados em reports/dialogo/<data>/ (results.json + imagens).
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type FontPayload, PortraitPayload } from "@/contracts";
import { warriorBase } from "@/fixtures/art";
import { encodePng } from "@/lib/media/png";
import { readZip } from "@/lib/zip";
import { createAsset, createProject, getAsset, getRevision, getUpload, publishRevision, reviewRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { fontCoverage, renderFontText } from "@/server/dialogue/fonts";
import { reviewPortrait } from "@/server/dialogue/portraits";
import { publishSpeech } from "@/server/dialogue/speech";
import { exportFilePath, getExport, requestExport } from "@/server/export/exports";
import { JobRunner } from "@/server/jobs/runner";
import { buildPlan } from "@/server/plan-builders";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import { ingestUpload, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { pageCodepoints, requiredCoverage } from "@/domain/dialogue/font";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MODEL = arg("model", "openai/gpt-image-1-mini");
const MAX_USD = Number(arg("max-usd", "0.8"));
const GLYPH = Number(arg("glyph", "8"));
const CONFIRMED = process.argv.includes("--yes");
const BASE = "https://openrouter.ai/api/v1";
/** Teto por imagem quando o catálogo cobra por token (conservador, como em scenes-real). */
const TOKEN_ESTIMATE: Record<string, number> = { "openai/gpt-image-1-mini": 0.05 };
const PYTHON = path.join(REPO_ROOT, "python", ".venv", "bin", "python");
const READER = path.join(REPO_ROOT, "consumers", "portable_reader", "read_portable.py");
const outDir = path.join(REPO_ROOT, "reports", "dialogo", new Date().toLocaleDateString("sv-SE"));
const log = (m: string) => console.log(`[dialogo] ${m}`);

// ---- 1. Descoberta gratuita, estimativa e saldo ----
const found = await new OpenRouterAdapter({ id: "d", baseUrl: BASE, secretRef: null, model: MODEL }, {}).discover(AbortSignal.timeout(30_000));
const ep = found.find((e) => e.providerTag) ?? found[0];
if (!ep) throw new Error(`${MODEL}: sem rota no catálogo`);
const perImage = (ep.pricing as { billable: string; unit: string; cost_usd: number }[]).filter((p) => p.billable === "output_image" && p.unit === "image").map((p) => p.cost_usd);
const price = perImage.length ? Math.max(...perImage) : null;
if (ep.maxReferences < 2) throw new Error(`${MODEL}: a folha de bocas exige 2 referências; a rota aceita ${ep.maxReferences}`);
// Pior caso: retrato + 2 expressões + páginas do kit pt-BR + as mesmas páginas de novo na extensão.
const fontPages = pageCodepoints(requiredCoverage("basic_pt", []).codepoints).length;
const calls = 1 + 2 + fontPages * 2;
const maxCost = calls * (price ?? TOKEN_ESTIMATE[MODEL] ?? 0.1);
const key = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
log(`${MODEL} · rota ${ep.providerTag} · refs ≤ ${ep.maxReferences} · ${price !== null ? `US$ ${price}/imagem` : "por token"}`);
log(`até ${calls} chamada(s) (retrato, neutra, feliz, ${fontPages} página(s) de glyphs + extensão) · custo máximo US$ ${maxCost.toFixed(3)} (teto US$ ${MAX_USD}) · saldo US$ ${key.limit_remaining}`);
if (maxCost > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (key.limit_remaining !== null && key.limit_remaining < maxCost) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

// ---- 2. Projeto dedicado no diretório de dados padrão ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const worker = new JobRunner({ ...studio, log: () => undefined }, { workerId: "dialogue-real", heartbeatMs: 10_000 });
const drain = async () => {
  while (await worker.runOnce()) {
    /* processa ingestões e gerações pendentes */
  }
};
await mkdir(outDir, { recursive: true });
const save = (sha: string, name: string) => copyFile(studio.blobs.pathFor(sha), path.join(outDir, name));
const profileId = "dialogo-real";
saveProfile(studio.db, studio.clock, {
  id: profileId,
  name: `Diálogo · ${MODEL}`,
  transport: "openrouter_images",
  secretRef: "OPENROUTER_API_KEY",
  model: MODEL,
  config: { maxReferences: ep.maxReferences, transparent: true, quality: "medium", ...(ep.providerTag ? { provider: { only: [ep.providerTag], allow_fallbacks: false } } : {}), ...(price !== null ? { pricePerImageUsd: price } : {}) },
});
const project = createProject(studio.db, studio.clock, { name: `Diálogo real ${new Date().toISOString().slice(0, 16)}` });
const projectId = project.id;
const approve = (revisionId: string) => {
  const rev = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, rev.assetId);
  reviewRevision(studio.db, studio.clock, { projectId, assetId: asset.id, revisionId, decision: "approve", reason: null, expectedActiveRevisionId: asset.approvedRevisionId });
};
const results: Record<string, unknown> = { model: MODEL, route: ep.providerTag, price, projectId };
const run = async (label: string, body: Record<string, unknown>, assetId: string) => {
  const planned = await buildPlan(studio, projectId, { providerProfileId: profileId, ...body } as never);
  const { job } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: assetId } }, `dialogo:${label}`);
  await drain();
  const done = studio.queue.get(job.id)!;
  const cost = studio.db.get<{ c: string | null }>("SELECT cost_actual_json AS c FROM generation_runs WHERE job_id = :j", { j: job.id })?.c ?? null;
  log(`${label}: ${done.state}${done.error_json ? ` · ${done.error_json}` : ""} · custo ${cost}`);
  if (done.state !== "succeeded") throw new Error(`${label} falhou`);
  return (JSON.parse(done.result_json!) as { revisionIds: string[] }).revisionIds;
};

// Personagem aprovado: o guerreiro da fixture (vista S).
const { upload } = await ingestUpload(studio, projectId, { name: "guerreiro.png", bytes: encodePng(warriorBase()) });
await drain();
const blob = getUpload(studio.db, projectId, upload.id);
const charAsset = createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "base", name: "Guerreiro" });
const character = publishRevision(studio.db, studio.clock, {
  projectId,
  assetId: charAsset.id,
  origin: "import",
  styleRevisionId: null,
  payload: { logicalSize: [64, 64], groundOrigin: [32, 63], state: "default", predecessorRevisionId: null, views: [{ direction: "S", fileId: "s", rect: [0, 0, 64, 64], sourceOffset: [0, 0] }] },
  files: [{ fileKey: "s", role: "normalized", idx: 0, blob: { sha256: blob.normalizedSha256 ?? blob.sha256, bytes: 1, mime: "image/png", modality: "raster", metadata: { width: 64, height: 64 } } }],
});
approve(character.id);

// ---- 3. Retrato → regiões → expressões ----
const portraitAsset = createAsset(studio.db, studio.clock, { projectId, family: "portrait", kind: "portrait", name: "Guerreiro · retrato" });
const [portraitId] = await run("retrato", { operation: "generate_portrait", characterRevisionId: character.id, logicalSize: [64, 64], brief: "guerreiro de túnica azul, olhar firme" }, portraitAsset.id);
const portraitRev = getRevision(studio.db, projectId, portraitId!);
const portrait = PortraitPayload.parse(portraitRev.payload);
await save(portraitRev.files.find((f) => f.fileKey === "image")!.sha256, "retrato.png");
await save(portraitRev.files.find((f) => f.fileKey === "compare")!.sha256, "retrato-comparacao.png");
results.portrait = portraitRev.technicalReport;
const reviewed = reviewPortrait(studio, projectId, { revisionId: portraitRev.id, faceAnchor: portrait.faceAnchor, faceRect: portrait.faceRect!, mouthRect: portrait.mouthRect! });
approve(reviewed.revision.id);
const expressions: Record<string, string> = {};
for (const [key, brief] of [["neutral", "expressão neutra e calma"], ["happy", "sorriso largo, olhos alegres"]] as const) {
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "portrait", kind: "expression", name: `Guerreiro · ${key}` });
  const [id] = await run(`expressão ${key}`, { operation: "generate_visemes", portraitRevisionId: reviewed.revision.id, expressionKey: key, expressionBrief: brief }, asset.id);
  const rev = getRevision(studio.db, projectId, id!);
  await save(rev.files.find((f) => f.fileKey === "sheet")!.sha256, `bocas-${key}.png`);
  await save(rev.files.find((f) => f.fileKey === "review")!.sha256, `bocas-${key}-revisao.png`);
  results[`expression_${key}`] = rev.technicalReport;
  approve(id!);
  expressions[key] = id!;
}

// ---- 4. Falas: plano local, zero jobs ----
const speeches = [];
for (const [textKey, text, expr] of [["npc.greeting", "Olá, viajante! Vamos à aventura?", "neutral"], ["npc.potion", "Use a poção de cura, rápido!", "happy"]] as const) {
  const s = await publishSpeech(studio, projectId, { expressionRevisionId: expressions[expr]!, textKey, language: "pt-BR", text, name: textKey });
  approve(s.revision.id);
  await save(s.revision.files.find((f) => f.fileKey === "preview-gif")!.sha256, `${textKey}.gif`);
  speeches.push(s.revision.id);
}

// ---- 5. Fonte: base → cobertura → extensão dos ausentes ----
const fontAsset = createAsset(studio.db, studio.clock, { projectId, family: "font", kind: "bitmap", name: "Fonte do guerreiro" });
const [fontId] = await run("fonte base", { operation: "generate_pixel_font", brief: "metal forjado, legível em 1×", glyphSize: GLYPH, kit: "basic_pt" }, fontAsset.id);
let finalFont = fontId!;
const baseCoverage = fontCoverage(studio, projectId, { fontRevisionId: fontId! });
results.fontBase = { report: getRevision(studio.db, projectId, fontId!).technicalReport, missing: baseCoverage.missingLabels };
approve(fontId!);
if (!baseCoverage.complete) {
  const [extId] = await run("fonte extensão", { operation: "generate_pixel_font", mode: "extend", baseRevisionId: fontId!, kit: "basic_pt" }, fontAsset.id);
  results.fontExtension = { report: getRevision(studio.db, projectId, extId!).technicalReport, missing: fontCoverage(studio, projectId, { fontRevisionId: extId! }).missingLabels };
  approve(extId!);
  finalFont = extId!;
}
const fontRev = getRevision(studio.db, projectId, finalFont);
for (const [i, key] of [...new Set((fontRev.payload as FontPayload).glyphs.map((g) => g.fileId))].entries()) await save(fontRev.files.find((f) => f.fileKey === key)!.sha256, `fonte-pagina-${i + 1}.png`);
const rendered = await renderFontText(studio, projectId, { fontRevisionId: finalFont, zoom: 4, background: "#1e1e26" });
for (const [i, t] of rendered.texts.entries()) await writeFile(path.join(outDir, `texto-${i + 1}.png`), Buffer.from(t.zoomed.replace(/^data:image\/png;base64,/, ""), "base64"));
results.render = rendered.texts.map((t) => ({ text: t.text, missing: t.missing, overflow: t.overflow }));

// ---- 6. Exportação X1 + leitor independente ----
const { export: requested } = requestExport(studio, projectId, { revisionIds: [...speeches, finalFont], profile: "portable-v1" });
await drain();
const ready = getExport(studio.db, projectId, requested.id);
const zipPath = path.join(outDir, "dialogo.zip");
await copyFile(exportFilePath(studio.config.paths.exports, ready), zipPath);
results.manifestEntries = (JSON.parse(new TextDecoder().decode(readZip(new Uint8Array(await readFile(zipPath))).read("manifest.json"))) as { entries: { kind: string }[] }).entries.map((e) => e.kind);
const reader = spawnSync(PYTHON, [READER, zipPath, path.join(outDir, "leitor")], { encoding: "utf8" });
results.reader = { status: reader.status, stdout: reader.stdout.trim(), stderr: reader.stderr.trim() };
await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
log(`pronto: ${outDir}`);
studio.db.close();
