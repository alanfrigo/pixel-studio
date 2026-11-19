import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, fillRect, setPixel } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import { createProject, getRevision, getUpload, listRevisions, revisionDependents } from "./catalog/catalog";
import { DomainFailure } from "./errors";
import { importPortablePackage } from "./export/import";
import { buildInpaintPlan } from "./inpaint";
import { saveProfile } from "./providers/profiles";
import { ingestUpload, submitJob } from "./services";
import { makeTestStudio, type TestStudio } from "./testing";

const PYTHON = `${process.cwd()}/python/.venv/bin/python`;
let studio: TestStudio;
afterEach(() => studio?.cleanup());

/** Máscara irregular 128×128 (margem do lago) com um buraco protegido dentro. */
function lakeMask(size = 128, fill: (x: number, y: number) => boolean = (x, y) => y >= 40 && y < 90 && x >= 30 + (y % 7) && x < 100) {
  const img = createImage(size, size);
  fillRect(img, 0, 0, size, size, [0, 0, 0, 255]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (fill(x, y)) setPixel(img, x, y, [255, 255, 255, 255]);
  fillRect(img, 60, 60, 4, 4, [0, 0, 0, 255]);
  return encodePng(img);
}

async function setup() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Inpainting" });
  const fixture = buildClareira();
  const zip = writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })));
  const { revisionMap } = await importPortablePackage(studio, project.id, readZip(zip), { approve: true });
  const source = getRevision(studio.db, project.id, revisionMap["grass-water-v1"]!);
  return { project, source };
}

async function upload(projectId: string, name: string, bytes: Uint8Array) {
  const { upload } = await ingestUpload(studio, projectId, { name, bytes });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, projectId, upload.id).status).toBe("ready");
  return upload.id;
}

/** Verificador independente (Pillow): compara os 4 bytes RGBA de cada pixel. */
function verifyProtection(source: Uint8Array, output: Uint8Array, candidate: Uint8Array, mask: Uint8Array) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "inpaint-verify-"));
  try {
    const files = { source, output, candidate, mask };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, `${name}.png`), bytes);
    const script = `
import json, sys
from PIL import Image
d = sys.argv[1]
s, o, c = (Image.open(f"{d}/{n}.png").convert("RGBA") for n in ("source", "output", "candidate"))
m = Image.open(f"{d}/mask.png").convert("L")
bad_protected = bad_edited = edited = 0
for y in range(s.height):
    for x in range(s.width):
        if m.getpixel((x, y)) == 255:
            edited += 1
            bad_edited += o.getpixel((x, y)) != c.getpixel((x, y))
        else:
            bad_protected += o.getpixel((x, y)) != s.getpixel((x, y))
print(json.dumps({"badProtected": bad_protected, "badEdited": bad_edited, "edited": edited}))
`;
    return JSON.parse(execFileSync(PYTHON, ["-I", "-c", script, dir], { encoding: "utf8" })) as { badProtected: number; badEdited: number; edited: number };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const input = (sourceRevisionId: string, maskUploadId: string, mode: "native-mask" | "candidate-composite" = "native-mask", providerProfileId = "simulated") => ({
  operation: "inpaint" as const,
  providerProfileId,
  sourceRevisionId,
  sourceFileKey: "grass-water-atlas",
  maskUploadId,
  instruction: "reconstruir a margem do lago com juncos",
  mode,
});

describe.skipIf(!existsSync(PYTHON))("inpainting (cartão E1)", () => {
  it("máscara nativa: só a região marcada muda, cada byte protegido fica idêntico e a revisão nova aponta para a fonte", async () => {
    const { project, source } = await setup();
    const maskId = await upload(project.id, "margem.png", lakeMask());
    const planned = await buildInpaintPlan(studio, project.id, input(source.id, maskId));
    expect(planned.modeLabel).toEqual({ "pt-BR": "Inpainting com máscara nativa", en: "Inpainting with a native mask" });
    expect(planned.plan.requiredCapabilities).toEqual(["native_mask"]);
    expect(planned.mask.emptyMask).toBe(false);
    expect(planned.scope["pt-BR"]).toMatch(/protegido\(s\) saem idênticos/);
    expect(planned.scope.en).toMatch(/protected pixel\(s\) come out identical/);

    const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: source.assetId } }, "inpaint-1");
    await studio.runner().runOnce();
    const done = studio.queue.get(job.id)!;
    expect([done.state, done.error_json]).toEqual(["succeeded", null]);
    expect(studio.simulatedStore.read().charged).toBe(1);

    const [edited] = listRevisions(studio.db, project.id, source.assetId).filter((r) => r.id !== source.id);
    expect(edited).toMatchObject({ origin: "edit", predecessorId: source.id, status: "candidate" });
    expect(edited!.payload).toEqual(source.payload); // mesma estrutura de tileset, só o atlas muda
    const report = edited!.technicalReport as { mode: string; composite: { protectedDiffPixels: number; editedPixels: number; candidateAgreement: number }; warnings: string[] };
    expect(report.mode).toBe("native-mask");
    expect(report.composite.protectedDiffPixels).toBe(0);
    expect(revisionDependents(studio.db, project.id, source.id)).toEqual([expect.objectContaining({ revisionId: edited!.id, role: "source", runtime: 0 })]);

    const file = (rev: typeof edited, key: string) => studio.blobs.read(rev!.files.find((f) => f.fileKey === key)!.sha256);
    const verdict = verifyProtection(await file(source, "grass-water-atlas"), await file(edited, "grass-water-atlas"), await file(edited, "inpaint-candidate"), await file(edited, "inpaint-mask"));
    expect(verdict).toEqual({ badProtected: 0, badEdited: 0, edited: report.composite.editedPixels });
    expect(verdict.edited).toBeGreaterThan(1000);
  });

  it("máscara vazia não envia nada; tamanho errado e cinza são recusados antes do envio; máscara cheia avisa o alcance", async () => {
    const { project, source } = await setup();
    const empty = await upload(project.id, "vazia.png", lakeMask(128, () => false));
    await expect(buildInpaintPlan(studio, project.id, input(source.id, empty))).rejects.toThrow(/Máscara vazia: nenhuma região a editar/);
    const small = await upload(project.id, "pequena.png", lakeMask(64));
    await expect(buildInpaintPlan(studio, project.id, input(source.id, small))).rejects.toThrow(/Máscara inválida: .*64×64.*128×128/);
    const grayImg = createImage(128, 128);
    fillRect(grayImg, 0, 0, 128, 128, [128, 128, 128, 255]);
    const gray = await upload(project.id, "cinza.png", encodePng(grayImg));
    await expect(buildInpaintPlan(studio, project.id, input(source.id, gray))).rejects.toThrow(/cinza intermediário/);
    expect(studio.simulatedStore.read().submissions).toBe(0);

    const fullImg = createImage(128, 128);
    fillRect(fullImg, 0, 0, 128, 128, [255, 255, 255, 255]);
    const full = await upload(project.id, "cheia.png", encodePng(fullImg));
    const planned = await buildInpaintPlan(studio, project.id, input(source.id, full));
    expect(planned.mask.fullMask).toBe(true);
    expect(planned.scope["pt-BR"]).toMatch(/Máscara cheia: regeneração integral/);
  });

  it("perfil sem máscara nativa não vira inpainting nativo: o modo candidata é escolha explícita e identificada", async () => {
    const { project, source } = await setup();
    saveProfile(studio.db, studio.clock, {
      id: "or",
      name: "OpenRouter",
      transport: "openrouter_images",
      baseUrl: "https://openrouter.ai/api/v1",
      secretRef: "TEST_PROVIDER_KEY",
      model: "openai/gpt-image-2.6-flare",
      config: { maxReferences: 16, transparent: true },
    });
    process.env.TEST_PROVIDER_KEY = "x";
    const maskId = await upload(project.id, "margem.png", lakeMask());
    const err = await buildInpaintPlan(studio, project.id, input(source.id, maskId, "native-mask", "or")).catch((e) => e);
    expect(err).toBeInstanceOf(DomainFailure);
    expect((err as DomainFailure).code).toBe("capability_missing");
    expect((err as DomainFailure).message).toMatch(/não recebe máscara nativa.*candidato editado \+ recorte local/);
    const candidate = await buildInpaintPlan(studio, project.id, input(source.id, maskId, "candidate-composite", "or"));
    expect(candidate.modeLabel["pt-BR"]).toBe("Candidato editado + recorte local; sem condicionamento nativo por máscara");
    expect(candidate.plan.requiredCapabilities).toEqual(["image_edit"]);
    expect(candidate.plan.prompt.compiled).toMatch(/A imagem 2 é a mesma imagem com a região a mudar pintada de magenta/);
  });
});
