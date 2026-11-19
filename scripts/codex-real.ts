/**
 * Ensaio real do provedor Codex CLI local (login do ChatGPT, sem chave de API).
 *
 *   npx tsx scripts/codex-real.ts                       # simulação: confere versão, login e skill; nada é gerado
 *   npx tsx scripts/codex-real.ts --yes                 # executa (cada imagem consome uma geração da cota do plano)
 *   npx tsx scripts/codex-real.ts --only=potion,inpaint --yes
 *
 * Cada caso passa pela fila real do Studio: plano congelado, adaptador Codex
 * CLI (um turno `codex exec` por imagem, sandbox somente leitura), recuperação
 * da grade de pixels e ajuste ao tamanho lógico. O inpainting usa a rota
 * "candidato + recorte local" e é conferido de forma independente (nenhum
 * byte RGBA fora da máscara muda). Saída em reports/codex/<data>/.
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAsset, createProject, getRevision, getUpload, reviewRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { buildInpaintPlan } from "@/server/inpaint";
import { JobRunner } from "@/server/jobs/runner";
import { buildPlan } from "@/server/plan-builders";
import { CodexCliAdapter } from "@/server/providers/codex-cli";
import { saveProfile } from "@/server/providers/profiles";
import { ingestUpload, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso, sleep } from "@/server/util";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const CONFIRMED = process.argv.includes("--yes");
const ONLY = arg("only", "").split(",").filter(Boolean);
const MAX_IMAGES = Number(arg("max-images", "8"));
const MODEL = arg("model", "");
const EFFORT = arg("effort", "low");
const CONCURRENCY = Number(arg("concurrency", "2"));
const PYTHON = path.join(REPO_ROOT, "python", ".venv", "bin", "python");
const log = (m: string) => console.log(`[codex] ${m}`);

type Kind = "icon" | "character" | "prop" | "texture" | "styled" | "inpaint";
interface Case {
  key: string;
  kind: Kind;
  size: [number, number];
  brief: string;
  /** Caso que depende de outro (referência de estilo ou fonte do inpainting). */
  after?: string;
}

const CASES: Case[] = [
  { key: "potion", kind: "icon", size: [32, 32], brief: "red health potion in a round glass flask with a cork stopper and a small highlight" },
  { key: "sword", kind: "icon", size: [32, 32], brief: "steel longsword with a golden crossguard and a blue leather grip, pointing up and to the right" },
  { key: "knight", kind: "character", size: [64, 64], brief: "full body game character sprite of a knight in silver armor with a red cape and a sword, standing, front view facing the viewer" },
  { key: "oak", kind: "prop", size: [64, 64], brief: "leafy oak tree with a thick brown trunk, top-down RPG map prop seen at three-quarter angle" },
  { key: "cobblestone", kind: "texture", size: [64, 64], brief: "mossy grey cobblestone path" },
  { key: "mana", kind: "styled", size: [32, 32], brief: "blue mana potion in a tall slender glass bottle with a silver cap", after: "potion" },
  { key: "inpaint", kind: "inpaint", size: [64, 64], brief: "recolor the red cape, red tabard and red helmet plume to royal blue with the same pixel art shading; keep the silver armor unchanged", after: "knight" },
];
const runs = CASES.filter((c) => ONLY.length === 0 || ONLY.includes(c.key));
const missing = runs.flatMap((c) => (c.after && !runs.some((r) => r.key === c.after) ? [`${c.key} depende de ${c.after}`] : []));
if (missing.length) throw new Error(`Casos dependentes sem a origem: ${missing.join("; ")}`);

// ---- 1. Pré-requisitos (grátis: nenhum turno é iniciado) ----
const probe = new CodexCliAdapter({ id: "probe", baseUrl: "", secretRef: null, model: MODEL || null }, { reasoningEffort: EFFORT });
const check = await probe.check(AbortSignal.timeout(60_000));
log(`${check.ok ? "pronto" : "NÃO pronto"} · ${check.message}`);
log(`${runs.length} imagem(ns): ${runs.map((c) => c.key).join(", ")} · teto ${MAX_IMAGES} · modelo ${MODEL || "padrão do Codex"} · esforço ${EFFORT}`);
if (!check.ok) throw new Error("Codex CLI não está pronto; nada foi gerado");
if (runs.length > MAX_IMAGES) throw new Error("Mais imagens que --max-images; nada foi gerado");
if (!CONFIRMED) {
  log("simulação: nada foi gerado. Rode com --yes para executar (consome a cota do plano do Codex).");
  process.exit(0);
}

// ---- 2. Projeto e perfil ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const today = iso(studio.clock.now()).slice(0, 10);
const project = createProject(studio.db, studio.clock, { name: `Codex CLI real · ${today}` });
const profileId = "codex-local";
saveProfile(studio.db, studio.clock, {
  id: profileId,
  name: "Codex CLI local",
  transport: "codex_cli",
  ...(MODEL ? { model: MODEL } : {}),
  config: { reasoningEffort: EFFORT },
});
log(`projeto "${project.name}" (${project.id})`);
const outDir = path.join(REPO_ROOT, "reports", "codex", today);
await mkdir(outDir, { recursive: true });

// ---- 3. Execução pela fila real ----
interface Result {
  key: string;
  kind: Kind;
  size: [number, number];
  brief: string;
  state: string;
  generations: number | null;
  seconds: number;
  error: string | null;
  revisionId: string | null;
  assetId: string | null;
  files: Record<string, string>;
  report: unknown;
  check?: unknown;
}
const results = new Map<string, Result>();
const workers = Array.from({ length: CONCURRENCY }, (_, i) => new JobRunner({ ...studio, log: () => undefined }, { workerId: `codex-${i}`, heartbeatMs: 10_000 }));
let submitting = true;
const pump = Promise.all(
  workers.map(async (w) => {
    while (submitting || studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running') AND project_id = :p", { p: project.id })!.n > 0) {
      if (!(await w.runOnce())) await sleep(300);
    }
  }),
);

async function waitJob(jobId: string) {
  let final = studio.queue.get(jobId)!;
  while (!["succeeded", "failed", "cancelled", "needs_attention"].includes(final.state)) {
    await sleep(500);
    final = studio.queue.get(jobId)!;
  }
  return final;
}

function approved(key: string) {
  const r = results.get(key);
  if (!r?.revisionId || !r.assetId) throw new Error(`${key} não gerou revisão`);
  const rev = getRevision(studio.db, project.id, r.revisionId);
  if (rev.status !== "approved") reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: r.assetId, revisionId: rev.id, decision: "approve", reason: null, expectedActiveRevisionId: null });
  return rev;
}

async function inpaintPlan(c: Case) {
  const source = approved(c.after!);
  const sourcePath = studio.blobs.pathFor(source.files.find((f) => f.fileKey === "image")!.sha256);
  const maskPath = path.join(outDir, "inpaint-mask-upload.png");
  // Máscara 255 edita / 0 protege: pixels avermelhados + 1 px de folga, dentro da silhueta.
  execFileSync(PYTHON, [
    "-I",
    "-c",
    `import sys
from PIL import Image, ImageFilter
im = Image.open(sys.argv[1]).convert("RGBA")
w, h = im.size
red = Image.new("L", (w, h), 0)
for y in range(h):
    for x in range(w):
        r, g, b, a = im.getpixel((x, y))
        if a and r > 70 and r > g + 45 and r > b + 45:
            red.putpixel((x, y), 255)
grown = red.filter(ImageFilter.MaxFilter(3))
alpha = im.getchannel("A").point(lambda v: 255 if v else 0)
Image.composite(grown, Image.new("L", (w, h), 0), alpha).save(sys.argv[2])`,
    sourcePath,
    maskPath,
  ]);
  const { upload } = await ingestUpload(studio, project.id, { name: "mascara-capa.png", bytes: new Uint8Array(await readFile(maskPath)) });
  for (let i = 0; i < 120 && getUpload(studio.db, project.id, upload.id).status !== "ready"; i++) await sleep(250);
  if (getUpload(studio.db, project.id, upload.id).status !== "ready") throw new Error("Máscara não ficou pronta");
  await copyFile(sourcePath, path.join(outDir, "inpaint-source.png"));
  const planned = await buildInpaintPlan(studio, project.id, {
    operation: "inpaint",
    providerProfileId: profileId,
    sourceRevisionId: source.id,
    sourceFileKey: "image",
    maskUploadId: upload.id,
    instruction: c.brief,
    mode: "candidate-composite",
    language: "en",
  });
  return { planned, assetId: results.get(c.after!)!.assetId!, sourcePath };
}

async function execute(c: Case): Promise<void> {
  const started = Date.now();
  let assetId: string;
  let planned: { plan: unknown; digest: string };
  let sourcePath: string | null = null;
  if (c.kind === "inpaint") {
    const p = await inpaintPlan(c);
    planned = p.planned;
    assetId = p.assetId;
    sourcePath = p.sourcePath;
  } else {
    const family = c.kind === "texture" ? "texture" : "item";
    const kind = c.kind === "texture" ? "material" : c.kind === "icon" || c.kind === "styled" ? "gear" : "misc";
    assetId = createAsset(studio.db, studio.clock, { projectId: project.id, family, kind, name: c.key } as never).id;
    const references = c.kind === "styled" ? [{ revisionId: approved(c.after!).id, fileKey: "image", role: "style", instruction: "match outline, palette approach and pixel size" }] : [];
    planned =
      c.kind === "texture"
        ? await buildPlan(studio, project.id, { operation: "generate_texture", providerProfileId: profileId, materialBrief: c.brief, logicalSize: c.size, repeatAxes: { x: true, y: true }, language: "en" } as never)
        : await buildPlan(studio, project.id, {
            operation: "generate_asset",
            providerProfileId: profileId,
            brief: c.brief,
            language: "en",
            params: { family: "item", kind, logicalSize: c.size, transparent: true, variants: 1 },
            references,
          } as never);
  }
  const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan as never, planDigest: planned.digest, targetAssetId: assetId } }, `codex:${today}:${c.key}:${assetId}`);
  const final = await waitJob(job.id);
  const error = (JSON.parse(final.error_json ?? "null") as { message?: string } | null)?.message ?? null;
  const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
  const revision = result?.revisionIds[0] ? getRevision(studio.db, project.id, result.revisionIds[0]) : null;
  const files = Object.fromEntries((revision?.files ?? []).filter((f) => f.mime === "image/png").map((f) => [f.fileKey, f.sha256]));
  for (const [fileKey, sha] of Object.entries(files)) await copyFile(studio.blobs.pathFor(sha), path.join(outDir, `${c.key}-${fileKey}.png`));
  let verified: unknown;
  if (c.kind === "inpaint" && revision && sourcePath) {
    // Verificação independente: nenhum byte RGBA fora da máscara mudou.
    verified = JSON.parse(
      execFileSync(PYTHON, [
        "-I",
        "-c",
        `import sys, json
from PIL import Image
src = Image.open(sys.argv[1]).convert("RGBA"); out = Image.open(sys.argv[2]).convert("RGBA"); mask = Image.open(sys.argv[3]).convert("L")
inside = outside = 0
for y in range(src.height):
    for x in range(src.width):
        if src.getpixel((x, y)) != out.getpixel((x, y)):
            if mask.getpixel((x, y)) > 0: inside += 1
            else: outside += 1
print(json.dumps({"changedInside": inside, "changedOutside": outside, "maskPixels": sum(1 for v in mask.get_flattened_data() if v)}))`,
        sourcePath,
        studio.blobs.pathFor(files.image!),
        studio.blobs.pathFor(files["inpaint-mask"]!),
      ]).toString(),
    );
  }
  results.set(c.key, {
    key: c.key,
    kind: c.kind,
    size: c.size,
    brief: c.brief,
    state: final.state,
    generations: result?.cost?.find((x) => x.unit === "generations")?.amount ?? null,
    seconds: (Date.now() - started) / 1000,
    error,
    revisionId: revision?.id ?? null,
    assetId,
    files,
    report: revision?.technicalReport ?? null,
    ...(verified ? { check: verified } : {}),
  });
  log(`${c.key}: ${final.state} em ${((Date.now() - started) / 1000).toFixed(0)} s${verified ? ` · ${JSON.stringify(verified)}` : ""}${error ? ` · ${error.slice(0, 160)}` : ""}`);
}

// Independentes em paralelo; dependentes depois da origem.
const first = runs.filter((c) => !c.after);
const second = runs.filter((c) => c.after);
for (const batch of [first, second]) {
  const queue = [...batch];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        await execute(c).catch((err: unknown) => {
          results.set(c.key, { key: c.key, kind: c.kind, size: c.size, brief: c.brief, state: "error", generations: null, seconds: 0, error: err instanceof Error ? err.message : String(err), revisionId: null, assetId: null, files: {}, report: null });
          log(`${c.key}: erro antes da fila · ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }),
  );
}
submitting = false;
await pump;

// ---- 4. Resumo ----
const list = [...results.values()];
const generations = list.reduce((n, r) => n + (r.generations ?? 0), 0);
await writeFile(path.join(outDir, "results.json"), JSON.stringify({ date: iso(studio.clock.now()), projectId: project.id, check, model: MODEL || null, effort: EFFORT, generations, results: list }, null, 2));
log(`${list.filter((r) => r.state === "succeeded").length}/${list.length} concluídas · ${generations} geração(ões) da cota · ${path.relative(REPO_ROOT, outDir)}`);
studio.db.close();
