/**
 * Inpainting da vitrine: recolore a capa do cavaleiro gerado por IA, protegendo
 * cada pixel fora da máscara.
 *
 *   npx tsx scripts/showcase-inpaint.ts                 # simulação; nada é enviado
 *   npx tsx scripts/showcase-inpaint.ts --max-usd=0.2 --yes
 *
 * Usa o projeto mais recente "Vitrine do README" (scripts/showcase-real.ts).
 * A máscara cobre os pixels avermelhados do sprite com 1 px de folga, dentro
 * da silhueta. Rota OpenRouter = candidato editado + recorte local (não é
 * máscara nativa). Saída em reports/vitrine/<data>/inpaint-*.png.
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getRevision, getUpload, reviewRevision } from "@/server/catalog/catalog";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { buildInpaintPlan } from "@/server/inpaint";
import { JobRunner } from "@/server/jobs/runner";
import { OpenRouterAdapter } from "@/server/providers/adapters";
import { saveProfile } from "@/server/providers/profiles";
import { ingestUpload, submitJob } from "@/server/services";
import { openStudio } from "@/server/studio";
import { iso } from "@/server/util";
import { runMigrations } from "./migrate";

loadDotEnv();
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const MAX_USD = Number(arg("max-usd", "0.2"));
const CONFIRMED = process.argv.includes("--yes");
const MODEL = arg("model", "openai/gpt-image-2.6-flare");
const BASE = "https://openrouter.ai/api/v1";
const ESTIMATE = 0.1;
const PYTHON = path.join(REPO_ROOT, "python", ".venv", "bin", "python");
const log = (m: string) => console.log(`[vitrine-inpaint] ${m}`);

const found = await new OpenRouterAdapter({ id: "d", baseUrl: BASE, secretRef: null, model: MODEL }, {}).discover(AbortSignal.timeout(30_000));
const ep = found.find((e) => e.providerTag) ?? found[0];
if (!ep) throw new Error(`${MODEL}: sem rota`);
const key = ((await (await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` } })).json()) as { data: { limit_remaining: number | null; usage: number } }).data;
log(`${MODEL} · rota ${ep.providerTag} · 1 chamada · custo máximo estimado US$ ${ESTIMATE} (teto US$ ${MAX_USD}) · saldo US$ ${key.limit_remaining} (uso ${key.usage})`);
if (ESTIMATE > MAX_USD) throw new Error("Custo máximo acima de --max-usd; nada foi enviado");
if (key.limit_remaining !== null && key.limit_remaining < ESTIMATE) throw new Error("Saldo da chave abaixo do custo máximo; nada foi enviado");
if (!CONFIRMED) {
  log("simulação: nada foi enviado. Rode com --yes para executar.");
  process.exit(0);
}

runMigrations();
const studio = openStudio({ config: loadConfig() });
const row = studio.db.get<{ project_id: string; asset_id: string; revision_id: string }>(
  `SELECT a.project_id, a.id AS asset_id, r.id AS revision_id FROM assets a
   JOIN projects p ON p.id = a.project_id
   JOIN asset_revisions r ON r.asset_id = a.id
   WHERE p.name LIKE 'Vitrine do README%' AND a.name = 'knight'
   ORDER BY r.created_at DESC LIMIT 1`,
  {},
);
if (!row) throw new Error("Rode scripts/showcase-real.ts antes: cavaleiro não encontrado");
const projectId = row.project_id;
const source = getRevision(studio.db, projectId, row.revision_id);
if (source.status !== "approved") {
  reviewRevision(studio.db, studio.clock, { projectId, assetId: row.asset_id, revisionId: source.id, decision: "approve", reason: null, expectedActiveRevisionId: null });
}
const sourcePath = studio.blobs.pathFor(source.files.find((f) => f.fileKey === "image")!.sha256);

// Máscara 255 edita / 0 protege: pixels avermelhados + 1 px de folga, dentro da silhueta.
const today = iso(studio.clock.now()).slice(0, 10);
const outDir = path.join(REPO_ROOT, "reports", "vitrine", today);
await mkdir(outDir, { recursive: true });
const maskPath = path.join(outDir, "inpaint-mask-upload.png");
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
mask = Image.composite(grown, Image.new("L", (w, h), 0), alpha)
mask.save(sys.argv[2])
print(sum(1 for v in mask.getdata() if v))`,
  sourcePath,
  maskPath,
]);
const worker = new JobRunner({ ...studio, log: () => undefined }, { workerId: "vitrine-inpaint", heartbeatMs: 10_000 });
const drain = async () => {
  while (await worker.runOnce()) {
    /* ingestão e geração */
  }
};
const { upload } = await ingestUpload(studio, projectId, { name: "mascara-capa.png", bytes: new Uint8Array(await readFile(maskPath)) });
await drain();
if (getUpload(studio.db, projectId, upload.id).status !== "ready") throw new Error("Máscara não ficou pronta");

const profileId = "vitrine-inpaint-flare";
saveProfile(studio.db, studio.clock, {
  id: profileId,
  name: `Vitrine inpainting · ${MODEL}`,
  transport: "openrouter_images",
  secretRef: "OPENROUTER_API_KEY",
  model: MODEL,
  config: { maxReferences: ep.maxReferences, quality: "medium", ...(ep.providerTag ? { provider: { only: [ep.providerTag], allow_fallbacks: false } } : {}) },
});
const planned = await buildInpaintPlan(studio, projectId, {
  operation: "inpaint",
  providerProfileId: profileId,
  sourceRevisionId: source.id,
  sourceFileKey: "image",
  maskUploadId: upload.id,
  instruction: "recolor the red cape, red tabard and red helmet plume to royal blue with the same pixel art shading; keep the silver armor unchanged",
  mode: "candidate-composite",
  language: "en",
});
const { job } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: row.asset_id } }, `vitrine-inpaint:${today}:${source.id}`);
await drain();
const final = studio.queue.get(job.id)!;
const result = JSON.parse(final.result_json ?? "null") as { revisionIds: string[]; cost: { unit: string; amount: number }[] | null } | null;
const error = (JSON.parse(final.error_json ?? "null") as { message?: string } | null)?.message ?? null;
log(`${final.state} · US$ ${result?.cost?.find((c) => c.unit === "USD")?.amount ?? "?"}${error ? ` · ${error}` : ""}`);
if (!result?.revisionIds[0]) process.exit(1);
const edited = getRevision(studio.db, projectId, result.revisionIds[0]);
const file = (k: string) => studio.blobs.pathFor(edited.files.find((f) => f.fileKey === k)!.sha256);
await copyFile(sourcePath, path.join(outDir, "inpaint-source.png"));
await copyFile(file("image"), path.join(outDir, "inpaint-result.png"));
await copyFile(file("inpaint-mask"), path.join(outDir, "inpaint-mask.png"));
await copyFile(file("inpaint-candidate"), path.join(outDir, "inpaint-candidate.png"));
// Verificação independente: nenhum byte RGBA fora da máscara mudou.
const check = execFileSync(PYTHON, [
  "-I",
  "-c",
  `import sys
from PIL import Image
a = Image.open(sys.argv[1]).convert("RGBA"); b = Image.open(sys.argv[2]).convert("RGBA"); m = Image.open(sys.argv[3]).convert("L")
bad = sum(1 for pa, pb, mv in zip(a.getdata(), b.getdata(), m.getdata()) if mv == 0 and pa != pb)
changed = sum(1 for pa, pb, mv in zip(a.getdata(), b.getdata(), m.getdata()) if mv and pa != pb)
print(f"fora da máscara alterados: {bad} · dentro alterados: {changed} · máscara: {sum(1 for v in m.getdata() if v)}")`,
  sourcePath,
  file("image"),
  file("inpaint-mask"),
], { encoding: "utf8" });
log(check.trim());
log(`revisão ${edited.id} · ${path.relative(REPO_ROOT, outDir)}`);
studio.db.close();
