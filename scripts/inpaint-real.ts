/**
 * Ensaio real de inpainting (cartão E1 · demonstração de aceite do 05 §inpainting).
 *
 *   npx tsx scripts/inpaint-real.ts [--max-usd=1] [--models=a,b] [--yes]
 *
 * Dois cenários no modo "candidato editado + recorte local" pelo OpenRouter
 * (rota só com referências; nunca anunciado como máscara nativa):
 *   1. margem do lago no tileset da Clareira (fonte opaca);
 *   2. remover a placa de uma parede de pedra sintética, com alfa 0/64/128 e
 *      RGB sob alfa 0 fora da máscara.
 * Sem --yes só estima. Resultados em reports/inpainting/<data>/.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildClareira } from "@/fixtures/clareira";
import { createAsset, createProject, getRevision, getUpload, listRevisions, reviewRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { importPortablePackage } from "@/server/export/import";
import { buildInpaintPlan, guideScale } from "@/server/inpaint";
import { JobRunner } from "@/server/jobs/runner";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import { ingestUpload, publishFromSource, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso, slugify } from "@/server/util";
import { createImage, encodePng, fillRect, setPixel } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MAX_USD = Number(arg("max-usd", "1"));
const CONFIRMED = process.argv.includes("--yes");
const BASE = "https://openrouter.ai/api/v1";
const MODELS = arg("models", "openai/gpt-image-2.6-flare,google/gemini-3.1-flash-image").split(",");
const TOKEN_ESTIMATE: Record<string, number> = { "openai/gpt-image-2.6-flare": 0.08, "google/gemini-3.1-flash-image": 0.12 };
const PYTHON = path.join(REPO_ROOT, "python", ".venv", "bin", "python");
const log = (m: string) => console.log(`[inpainting] ${m}`);

// ---- Fontes e máscaras (determinísticas) ----
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** Parede de pedra 64×64 com placa de madeira; borda superior com alfa parcial e RGB sob alfa 0. */
function wallWithSign() {
  const img = createImage(64, 64);
  const r = rng(7);
  fillRect(img, 0, 0, 64, 64, [58, 56, 64, 255]); // argamassa
  for (let row = 0; row < 8; row++) {
    const offset = row % 2 ? 8 : 0;
    for (let col = -1; col < 5; col++) {
      const x0 = col * 16 + offset;
      const shade = [[118, 116, 124], [104, 102, 112], [132, 128, 134]][Math.floor(r() * 3)]!;
      for (let y = row * 8 + 1; y < row * 8 + 7; y++) {
        for (let x = Math.max(0, x0 + 1); x < Math.min(64, x0 + 15); x++) {
          const top = y === row * 8 + 1;
          setPixel(img, x, y, top ? [shade[0]! + 18, shade[1]! + 18, shade[2]! + 18, 255] : [shade[0]!, shade[1]!, shade[2]!, 255]);
        }
      }
      // musgo na base de algumas pedras
      if (r() < 0.45) for (let x = Math.max(0, x0 + 2); x < Math.min(64, x0 + 2 + Math.floor(r() * 9)); x++) setPixel(img, x, row * 8 + 6, [72, 120, 52, 255]);
    }
  }
  // placa: madeira com contorno escuro, tábuas e pregos
  fillRect(img, 18, 22, 28, 18, [40, 26, 18, 255]);
  fillRect(img, 19, 23, 26, 16, [150, 98, 52, 255]);
  for (const y of [28, 33]) fillRect(img, 19, y, 26, 1, [112, 70, 36, 255]);
  for (const [x, y] of [[21, 25], [42, 25], [21, 36], [42, 36]] as const) setPixel(img, x, y, [210, 200, 170, 255]);
  // fora da máscara: alfa parcial e RGB "escondido" sob alfa 0 (devem sair intactos)
  for (let x = 0; x < 64; x++) setPixel(img, x, 0, [90, 90, 98, x % 2 ? 64 : 128]);
  fillRect(img, 0, 0, 3, 3, [200, 10, 10, 0]);
  return encodePng(img);
}

function maskPng(w: number, h: number, inside: (x: number, y: number) => boolean) {
  const img = createImage(w, h);
  fillRect(img, 0, 0, w, h, [0, 0, 0, 255]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) setPixel(img, x, y, [255, 255, 255, 255]);
  return encodePng(img);
}

// ---- 1. Descoberta gratuita e estimativa ----
const routes = [];
for (const model of MODELS) {
  const found = await new OpenRouterAdapter({ id: "d", baseUrl: BASE, secretRef: null, model }, {}).discover(AbortSignal.timeout(30_000));
  const ep = found.find((e) => e.providerTag) ?? found[0];
  if (!ep || ep.maxReferences < 2) {
    log(`${model}: sem rota com 2 referências; ignorado`);
    continue;
  }
  const pricing = ep.pricing as { billable: string; unit: string; cost_usd: number }[];
  const perImage = pricing.filter((p) => p.billable === "output_image" && p.unit === "image").map((p) => p.cost_usd);
  routes.push({ model, tag: ep.providerTag, maxReferences: ep.maxReferences, price: perImage.length ? Math.max(...perImage) : null });
}
const SCENARIOS = 2;
const maxCost = routes.reduce((n, r) => n + SCENARIOS * (r.price ?? TOKEN_ESTIMATE[r.model] ?? 0.15), 0);
const key = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
for (const r of routes) log(`${r.model} · rota ${r.tag} · refs ≤ ${r.maxReferences} · ${r.price !== null ? `US$ ${r.price}/imagem` : "por token"}`);
log(`${routes.length * SCENARIOS} chamadas · custo máximo estimado US$ ${maxCost.toFixed(2)} (teto US$ ${MAX_USD}) · saldo da chave US$ ${key.limit_remaining} (uso ${key.usage})`);
if (maxCost > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (key.limit_remaining !== null && key.limit_remaining < maxCost) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

// ---- 2. Projeto, fontes aprovadas e máscaras ----
runMigrations();
const studio = openStudio({ config: loadConfig() });
const today = iso(studio.clock.now()).slice(0, 10);
const project = createProject(studio.db, studio.clock, { name: `Inpainting real · ${today}` });
const fixture = buildClareira();
const { revisionMap } = await importPortablePackage(studio, project.id, readZip(writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })))), {
  approve: true,
});
const worker = new JobRunner({ ...studio, log: () => undefined }, { workerId: "inpaint-real", heartbeatMs: 10_000 });
const drain = async () => {
  while (await worker.runOnce()) {
    /* processa ingestões pendentes */
  }
};
async function upload(name: string, bytes: Uint8Array) {
  const { upload } = await ingestUpload(studio, project.id, { name, bytes });
  await drain();
  if (getUpload(studio.db, project.id, upload.id).status !== "ready") throw new Error(`Upload ${name} não ficou pronto`);
  return upload.id;
}
const wallAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "material", name: "Parede com placa" });
const wallRev = publishFromSource(studio, project.id, wallAsset.id, { from: "upload", uploadId: await upload("parede-com-placa.png", wallWithSign()) });
reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: wallAsset.id, revisionId: wallRev.id, decision: "approve", reason: null, expectedActiveRevisionId: null });

const scenarios = [
  {
    key: "margem-do-lago",
    label: "Margem do lago (tileset da Clareira, 128×128)",
    revisionId: revisionMap["grass-water-v1"]!,
    fileKey: "grass-water-atlas",
    mask: await upload("mascara-lago.png", maskPng(128, 128, (x, y) => y >= 40 && y < 90 && x >= 30 + (y % 7) && x < 100 && !(x >= 60 && x < 64 && y >= 60 && y < 64))),
    instruction: "reconstruir a margem do lago com juncos e pedrinhas, mantendo a água azul e a grama verde em volta",
  },
  {
    key: "placa-na-parede",
    label: "Placa na parede de pedra (64×64, alfa parcial fora da máscara)",
    revisionId: wallRev.id,
    fileKey: "image",
    mask: await upload("mascara-placa.png", maskPng(64, 64, (x, y) => x >= 17 && x < 47 && y >= 21 && y < 41)),
    instruction: "remover a placa de madeira e reconstruir as pedras e a argamassa da parede no lugar, com um pouco de musgo",
  },
];

// ---- 3. Execução ----
const outDir = path.join(REPO_ROOT, "reports", "inpainting", today);
await mkdir(outDir, { recursive: true });
const results = [];
for (const route of routes) {
  const profileId = `inpaint-${slugify(route.model).replaceAll("_", "-")}`.slice(0, 64);
  saveProfile(studio.db, studio.clock, {
    id: profileId,
    name: `Inpainting (candidata) · ${route.model}`,
    transport: "openrouter_images",
    secretRef: "OPENROUTER_API_KEY",
    model: route.model,
    config: {
      maxReferences: route.maxReferences,
      ...(route.tag ? { provider: { only: [route.tag], allow_fallbacks: false } } : {}),
      ...(route.model.startsWith("openai/") ? { quality: "medium" } : { resolution: "1K" }),
      ...(route.price !== null ? { pricePerImageUsd: route.price } : {}),
    },
  });
  for (const sc of scenarios) {
    const source = getRevision(studio.db, project.id, sc.revisionId);
    const planned = await buildInpaintPlan(studio, project.id, {
      operation: "inpaint",
      providerProfileId: profileId,
      sourceRevisionId: sc.revisionId,
      sourceFileKey: sc.fileKey,
      maskUploadId: sc.mask,
      instruction: sc.instruction,
      mode: "candidate-composite",
      language: "en",
    });
    const started = Date.now();
    const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: source.assetId } }, `inpaint-real:${sc.key}:${route.model}`);
    await drain();
    const final = studio.queue.get(job.id)!;
    const error = JSON.parse(final.error_json ?? "null") as { message?: string } | null;
    const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
    const revision = result ? listRevisions(studio.db, project.id, source.assetId).find((r) => r.id === result.revisionIds[0]) : undefined;
    const base = `${sc.key}-${slugify(route.model).replaceAll("_", "-")}`;
    const fileOf = (rev: typeof source | undefined, key: string) => rev?.files.find((f) => f.fileKey === key);
    let verdict: { badProtected: number; badEdited: number; edited: number } | null = null;
    if (revision) {
      const paths = {
        source: studio.blobs.pathFor(fileOf(source, sc.fileKey)!.sha256),
        output: studio.blobs.pathFor(fileOf(revision, sc.fileKey)!.sha256),
        candidate: studio.blobs.pathFor(fileOf(revision, "inpaint-candidate")!.sha256),
        mask: studio.blobs.pathFor(fileOf(revision, "inpaint-mask")!.sha256),
        raw: studio.blobs.pathFor(fileOf(revision, "raw")!.sha256),
      };
      // Verificação independente (Pillow) + imagens do relatório: fonte, guia, candidato, resultado e diff.
      const script = `
import json, sys
from PIL import Image
src, out, cand, mask, raw, outdir, base, scale = sys.argv[1:9]
s, o, c, r = (Image.open(p).convert("RGBA") for p in (src, out, cand, raw))
m = Image.open(mask).convert("L")
bad_p = bad_e = edited = 0
diff = Image.new("RGBA", s.size, (0, 0, 0, 0))
for y in range(s.height):
    for x in range(s.width):
        if m.getpixel((x, y)) == 255:
            edited += 1
            bad_e += o.getpixel((x, y)) != c.getpixel((x, y))
        else:
            bad_p += o.getpixel((x, y)) != s.getpixel((x, y))
        if o.getpixel((x, y)) != s.getpixel((x, y)):
            diff.putpixel((x, y), (230, 40, 40, 255))
up = lambda im: im.resize((im.width * 4, im.height * 4), Image.Resampling.NEAREST)
up(s).save(f"{outdir}/{base}-fonte.png"); up(o).save(f"{outdir}/{base}-resultado.png"); up(c).save(f"{outdir}/{base}-candidato.png")
up(diff).save(f"{outdir}/{base}-diff.png"); r.save(f"{outdir}/{base}-bruta.png")
guide = s.copy(); guide.paste((255, 0, 255, 255), (0, 0), m); up(guide).save(f"{outdir}/{base}-guia.png")
print(json.dumps({"badProtected": bad_p, "badEdited": bad_e, "edited": edited}))
`;
      verdict = JSON.parse(
        execFileSync(PYTHON, ["-I", "-c", script, paths.source, paths.output, paths.candidate, paths.mask, paths.raw, outDir, base, String(guideScale(planned.plan.params.logicalSize))], { encoding: "utf8" }),
      );
    }
    const report = revision?.technicalReport as { composite?: Record<string, unknown>; warnings?: string[]; receivedSize?: number[] } | undefined;
    const entry = {
      scenario: sc.key,
      model: route.model,
      state: final.state,
      seconds: (Date.now() - started) / 1000,
      cost: result?.cost?.find((x) => x.unit === "USD")?.amount ?? null,
      error: error?.message ?? null,
      revisionId: revision?.id ?? null,
      receivedSize: report?.receivedSize ?? null,
      composite: report?.composite ?? null,
      warnings: report?.warnings ?? [],
      independentCheck: verdict,
    };
    results.push(entry);
    log(`${sc.key} · ${route.model}: ${final.state} em ${entry.seconds.toFixed(0)} s · US$ ${entry.cost ?? "?"} · fora da máscara: ${verdict ? verdict.badProtected : "—"} diferença(s)${error ? ` · ${error.message}` : ""}`);
  }
}
const total = results.reduce((n, r) => n + (r.cost ?? 0), 0);
await writeFile(path.join(outDir, "results.json"), JSON.stringify({ date: iso(studio.clock.now()), projectId: project.id, totalUsd: total, scenarios: scenarios.map(({ key, label, instruction }) => ({ key, label, instruction })), results }, null, 2));
log(`custo real US$ ${total.toFixed(4)} · ${path.relative(REPO_ROOT, outDir)}`);
studio.db.close();
