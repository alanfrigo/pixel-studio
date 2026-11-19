/**
 * Qualificação real de um perfil OpenRouter (03 §1: "qualificar texto, uma
 * referência e duas referências distintas e ordenadas"; 08 · I1).
 *
 *   npx tsx scripts/qualify-openrouter.ts [--model=bytedance-seed/seedream-4.5] [--resolution=2K] [--size=16] [--max-usd=0.5] [--note=...] [--yes]
 *
 * Sem --yes só faz as consultas gratuitas e mostra o custo máximo. Com --yes
 * roda os três casos pelo pipeline real (fila, worker, normalização), grava as
 * capacidades testadas no perfil e escreve o relatório em reports/qualificacao/.
 * O julgamento artístico (A1) fica com o artista, na interface do projeto criado.
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
import { runPython } from "@/server/python/bridge";
import { buildGenerationPlan, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso, sleep, slugify } from "@/server/util";
import { readZip, writeZip } from "@/lib/zip";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MODEL = arg("model", "bytedance-seed/seedream-4.5");
const MAX_USD = Number(arg("max-usd", "0.5"));
const CONFIRMED = process.argv.includes("--yes");
const RESOLUTION = arg("resolution", "2K");
const SIZE = Number(arg("size", "16"));
const NOTE = arg("note", "");
const SECRET_REF = "OPENROUTER_API_KEY";
const BASE = "https://openrouter.ai/api/v1";

function log(msg: string) {
  console.log(`[qualificação] ${msg}`);
}

// ---- 1. Consultas gratuitas ----
const discovery = new OpenRouterAdapter({ id: "discovery", baseUrl: BASE, secretRef: null, model: MODEL }, {});
const endpoints = await discovery.discover(AbortSignal.timeout(30_000));
const endpoint = endpoints.find((e) => e.providerTag) ?? endpoints[0];
if (!endpoint) throw new Error(`Nenhuma rota de imagem para ${MODEL}`);
const price = (endpoint.pricing as { billable: string; unit: string; cost_usd: number }[]).find((p) => p.billable === "output_image" && p.unit === "image")?.cost_usd;
if (price === undefined) throw new Error("Preço por imagem não informado pelo catálogo; qualificação abortada para não gastar sem estimativa");
const keyRes = await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env[SECRET_REF] ?? ""}` } });
if (!keyRes.ok) throw new Error(`Chave recusada pelo OpenRouter (${keyRes.status}); confira ${SECRET_REF} no .env`);
const key = ((await keyRes.json()) as { data: { limit: number | null; limit_remaining: number | null; usage: number } }).data;
const CASES = 3;
const maxCost = CASES * price;
log(`modelo ${MODEL} · rota ${endpoint.providerTag} · até ${endpoint.maxReferences} referências · US$ ${price}/imagem · fundo transparente: ${endpoint.transparent ? "sim" : "não"}`);
log(`chave: limite ${key.limit ?? "sem limite"} · restante ${key.limit_remaining ?? "?"} · uso ${key.usage}`);
log(`custo máximo desta qualificação: ${CASES} imagens × US$ ${price} = US$ ${maxCost.toFixed(2)} (teto do script: US$ ${MAX_USD})`);
if (maxCost > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (key.limit_remaining !== null && key.limit_remaining < maxCost) throw new Error("Saldo restante da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar os casos pagos.");
  process.exit(0);
}

// ---- 2. Perfil e projeto de qualificação ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const profileId = `openrouter-${slugify(MODEL).replaceAll("_", "-")}`.slice(0, 64);
saveProfile(studio.db, studio.clock, {
  id: profileId,
  name: `OpenRouter · ${MODEL}`,
  transport: "openrouter_images",
  secretRef: SECRET_REF,
  model: MODEL,
  config: {
    maxReferences: endpoint.maxReferences,
    transparent: endpoint.transparent,
    provider: endpoint.providerTag ? { only: [endpoint.providerTag], allow_fallbacks: false } : undefined,
    resolution: RESOLUTION,
    aspectRatio: "1:1",
    pricePerImageUsd: price,
  },
});
const today = iso(studio.clock.now()).slice(0, 10);
const project = createProject(studio.db, studio.clock, { name: `Qualificação OpenRouter · ${MODEL} · ${today}` });
const fixture = buildClareira();
const { revisionMap } = await importPortablePackage(
  studio,
  project.id,
  readZip(writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })))),
  { approve: true },
);
const potion = revisionMap["potion-v1"]!;
const warrior = revisionMap["warrior-base-v1"]!;
log(`projeto "${project.name}" (${project.id}) com a cena da clareira aprovada`);

// ---- 3. Casos ----
type Ref = { revisionId: string; fileKey: string; role: "identity" | "palette"; instruction: string };
const cases: { key: string; label: string; brief: string; references: Ref[] }[] = [
  { key: "texto", label: "Só texto", brief: "poção verde em frasco de vidro arredondado com rolha de cortiça, ícone de inventário", references: [] },
  {
    key: "uma-referencia",
    label: "Uma referência",
    brief: "a mesma poção da imagem 1, agora com líquido azul",
    references: [{ revisionId: potion, fileKey: "potion-sheet", role: "identity", instruction: "frasco e formato da poção; ignore a segunda poção menor" }],
  },
  {
    key: "duas-referencias",
    label: "Duas referências ordenadas",
    brief: "a poção da imagem 1 com o líquido na cor da túnica do guerreiro da imagem 2",
    references: [
      { revisionId: potion, fileKey: "potion-sheet", role: "identity", instruction: "frasco e formato da poção" },
      { revisionId: warrior, fileKey: "warrior-base-s", role: "palette", instruction: "azul da túnica" },
    ],
  },
];

const runner = new JobRunner({ ...studio, log: () => undefined }, { workerId: "qualificacao", heartbeatMs: 10_000 });
const reportDir = path.join(REPO_ROOT, "reports", "qualificacao", `${today}-${profileId}-${SIZE}px`);
await mkdir(reportDir, { recursive: true });

async function preview(sha256: string, maxSize: number, file: string) {
  const work = path.join(studio.config.paths.staging, "qualificacao", `${file}-${Date.now()}`);
  await mkdir(path.join(work, "in"), { recursive: true });
  await writeFile(path.join(work, "in", "source"), await studio.blobs.read(sha256));
  const r = await runPython(
    { protocolVersion: 1, jobId: "job_q", attemptId: "att_q", operation: "make_thumbnail", inputs: [{ ordinal: 0, role: "source", sha256, relPath: "in/source" }], recipe: { version: 1, maxSize } },
    { python: studio.config.python, workDir: work },
  );
  if (r.status === "error") throw new Error(r.message);
  await writeFile(path.join(reportDir, file), await readFile(r.outputs[0]!.absolutePath));
}

interface CaseResult {
  key: string;
  label: string;
  brief: string;
  state: string;
  seconds: number;
  cost: { unit: string; amount: number }[] | null;
  revision: ReturnType<typeof getRevision> | null;
  report: { receivedSize?: number[]; fittedToLogical?: { method: string; lossless: boolean }; warnings?: string[]; steps?: { operation: string; grid?: number[]; cell?: number[]; agreement?: number; measuredKeyHue?: number; contentRect?: number[] }[] };
  error: { message?: string } | null;
}
const results: CaseResult[] = [];
for (const c of cases) {
  const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "consumable", name: `Qualificação · ${c.label}` });
  const planned = buildGenerationPlan(studio, project.id, {
    operation: "generate_asset",
    providerProfileId: profileId,
    brief: c.brief,
    params: { family: "item", kind: "consumable", logicalSize: [SIZE, SIZE], transparent: true, variants: 1 },
    references: c.references,
  });
  const started = Date.now();
  const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: asset.id } }, `qualificacao:${c.key}:${planned.digest}`);
  log(`${c.label}: job ${job.id} enviado`);
  let final = studio.queue.get(job.id)!;
  while (!["succeeded", "failed", "cancelled", "needs_attention"].includes(final.state)) {
    if (!(await runner.runOnce())) await sleep(1000);
    final = studio.queue.get(job.id)!;
  }
  const seconds = (Date.now() - started) / 1000;
  const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
  const revision = result?.revisionIds[0] ? getRevision(studio.db, project.id, result.revisionIds[0]) : null;
  const report = (revision?.technicalReport ?? {}) as CaseResult["report"];
  if (revision) {
    const raw = revision.files.find((f) => f.fileKey === "raw")!;
    const image = revision.files.find((f) => f.fileKey === "image")!;
    await preview(raw.sha256, 256, `${c.key}-bruta-256.png`);
    await preview(image.sha256, 128, `${c.key}-${SIZE}px-ampliada.png`);
  }
  results.push({ key: c.key, label: c.label, brief: c.brief, state: final.state, seconds, cost: result?.cost ?? null, revision, report, error: JSON.parse(final.error_json ?? "null") });
  log(`${c.label}: ${final.state} em ${seconds.toFixed(1)} s · custo ${result?.cost?.map((x) => `${x.amount} ${x.unit}`).join(", ") ?? "?"} · recebida ${report.receivedSize?.join("×") ?? "?"}`);
}

// ---- 4. Capacidades testadas ----
const ok = (k: string) => results.find((r) => r.key === k)?.state === "succeeded";
const now = iso(studio.clock.now());
const mark = (capability: string, limits: Record<string, unknown>) =>
  studio.db.run(
    `UPDATE model_capabilities SET status = 'tested', verified_at = :now, limits_json = :limits
     WHERE provider_profile_id = :id AND operation = 'generate_asset' AND capability = :cap`,
    { now, id: profileId, cap: capability, limits: JSON.stringify(limits) },
  );
if (ok("texto")) mark("text_to_image", {});
if (ok("uma-referencia") && ok("duas-referencias")) mark("image_references", { maxReferences: endpoint.maxReferences, testedReferences: 2 });

// ---- 5. Relatório ----
const totalCost = results.flatMap((r) => r.cost ?? []).reduce((n, c) => n + (c.unit === "USD" ? c.amount : 0), 0);
const lines = [
  `# Qualificação OpenRouter · ${MODEL}`,
  "",
  `- Data: ${now}`,
  `- Rota: \`${endpoint.providerTag}\` (fixada com \`provider.only\` e \`allow_fallbacks: false\`), resolução ${RESOLUTION}, proporção 1:1`,
  `- Preço do catálogo: US$ ${price} por imagem gerada; referências não cobradas`,
  `- Custo real somado (usage.cost): US$ ${totalCost.toFixed(4)}`,
  `- Projeto para revisão artística: "${project.name}" (\`${project.id}\`)`,
  ...(NOTE ? [`- Observação: ${NOTE}`] : []),
  `- Tamanho lógico pedido: ${SIZE}×${SIZE} com transparência; a rota não tem alfa, então o plano pede fundo de cor-chave e o pós-processamento detecta a grade da arte, remove a cor-chave pela matiz medida na borda e recorta ao conteúdo`,
  "",
  "| Caso | Estado | Tempo | Custo | Recebida | Grade da arte | Fundo | Conteúdo | Ajuste final | Alertas |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...results.map(
    (r) =>
      `| ${r.label} | ${r.state} | ${r.seconds.toFixed(1)} s | ${r.cost?.map((c) => `${c.amount} ${c.unit}`).join(", ") ?? "?"} | ${r.report.receivedSize?.join("×") ?? "—"} | ${
        (() => {
          const u = r.report.steps?.find((x) => x.operation === "unzoom");
          return u?.grid ? `${u.grid.join("×")} (célula ${u.cell?.[0]} px, ${Math.round((u.agreement ?? 0) * 100)}%)` : "—";
        })()
      } | ${(() => {
        const k = r.report.steps?.find((x) => x.operation === "remove_background_flood");
        return k ? `matiz medida ${k.measuredKeyHue}°` : "—";
      })()} | ${r.report.steps?.find((x) => x.operation === "fit_logical")?.contentRect?.join("×") ?? "—"} | ${
        r.report.fittedToLogical ? `${r.report.fittedToLogical.method}${r.report.fittedToLogical.lossless ? "" : " (com perda)"}` : "—"
      } | ${(r.report.warnings ?? []).join("; ") || (r.error?.message ?? "")} |`,
  ),
  "",
  "## Imagens",
  "",
  ...results.filter((r) => r.revision).flatMap((r) => [`### ${r.label}`, "", `Briefing: ${r.brief}`, "", `![bruta](${r.key}-bruta-256.png) ![${SIZE} px ampliada](${r.key}-${SIZE}px-ampliada.png)`, ""]),
  "## Capacidades",
  "",
  `- text_to_image: ${ok("texto") ? "testada" : "não qualificada"}`,
  `- image_references: ${ok("uma-referencia") && ok("duas-referencias") ? "testada com 1 e 2 referências ordenadas" : "não qualificada"}`,
  "- alpha_output: ausente nesta rota (sem parâmetro de fundo); transparência obtida por cor-chave + remoção local",
  "",
  "Julgamento artístico (identidade, estilo, leitura a 1×; notas 0–2) pendente: revisar as candidatas no projeto e aprovar ou reprovar com motivo.",
];
await writeFile(path.join(reportDir, "RELATORIO.md"), `${lines.join("\n")}\n`);
log(`relatório em ${path.relative(REPO_ROOT, reportDir)}/RELATORIO.md · custo real US$ ${totalCost.toFixed(4)}`);
studio.db.close();
