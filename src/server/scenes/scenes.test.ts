import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MapObjectPayload, SceneLayerPayload, ScenePayload, TilemapPayload } from "@/contracts";
import { validateManifest } from "@/domain/manifest/validate";
import { createImage, encodePng, fillRect, setPixel } from "@/lib/media/png";
import { readZip } from "@/lib/zip";
import { createAsset, createProject, getAsset, getRevision, getUpload, publishRevision, reviewRevision } from "../catalog/catalog";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { buildPlan } from "../plan-builders";
import { ingestUpload, submitJob } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { torusTexture } from "../world/simulated-art";
import { createTilemap, publishTilemap } from "../world/maps";
import { buildTilesetTemplate } from "../world/tilesets";
import { publishTexture } from "../world/textures";
import { annotateScene, composeScene, cutSceneLayer, overlaySceneCharacter, previewScene, publishSceneLayer, shiftLayerForSeam } from "./scenes";
import { reviewObject } from "./rooms";

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const READER = path.join(process.cwd(), "consumers", "portable_reader", "read_portable.py");

let studio: TestStudio;
const tmpDirs: string[] = [];
afterEach(() => {
  studio?.cleanup();
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function approve(projectId: string, revisionId: string) {
  const rev = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, rev.assetId);
  return reviewRevision(studio.db, studio.clock, { projectId, assetId: asset.id, revisionId, decision: "approve", reason: null, expectedActiveRevisionId: asset.approvedRevisionId });
}

async function upload(projectId: string, name: string, bytes: Uint8Array) {
  const { upload } = await ingestUpload(studio, projectId, { name, bytes });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, projectId, upload.id).status).toBe("ready");
  return upload.id;
}

async function run(projectId: string, body: Record<string, unknown>, targetAssetId: string, key: string) {
  const planned = await buildPlan(studio, projectId, body as never);
  const { job } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId } }, key);
  await studio.runner().runOnce();
  const done = studio.queue.get(job.id)!;
  return { planned, result: JSON.parse(done.result_json ?? "null") as { revisionIds: string[] } | null, error: JSON.parse(done.error_json ?? "null") as { message: string } | null };
}

/** Base de personagem aprovada com a vista E (para a escala em cena lateral). */
async function hero(projectId: string) {
  const img = createImage(16, 24);
  fillRect(img, 5, 2, 6, 21, [200, 40, 40, 255]);
  const uploadId = await upload(projectId, "heroi.png", encodePng(img));
  const blob = getUpload(studio.db, projectId, uploadId);
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "base", name: "Herói" });
  const rev = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "import",
    styleRevisionId: null,
    payload: { logicalSize: [16, 24], groundOrigin: [8, 23], state: "default", predecessorRevisionId: null, views: [{ direction: "E", fileId: "e", rect: [0, 0, 16, 24], sourceOffset: [0, 0] }] },
    files: [{ fileKey: "e", role: "normalized", idx: 0, blob: { sha256: blob.normalizedSha256 ?? blob.sha256, bytes: 1, mime: "image/png", modality: "raster", metadata: { width: 16, height: 24 } } }],
  });
  approve(projectId, rev.id);
  return rev.id;
}

describe.skipIf(!existsSync(PYTHON))("cenas e paralaxe (cartão T2)", { timeout: 60_000 }, () => {
  it("cena plana: rotulada como imagem plana (sem mapa nem objetos), revisada com personagem em escala e pontos de apoio", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Ponte" });
    const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "scene", name: "Ponte ao entardecer" });
    const r = await run(project.id, { operation: "generate_scene", providerProfileId: "simulated", brief: "ponte de madeira sobre um rio numa floresta ao entardecer", composition: "ponte no terço inferior, árvores emoldurando", lighting: "sol baixo à esquerda, céu laranja", requiredElements: ["ponte de madeira", "rio"], logicalSize: [240, 160] }, asset.id, "scene:ponte");
    expect(r.error).toBeNull();
    expect(r.planned.plan.prompt.compiled).not.toMatch(/#[0-9a-f]{6}/i);
    expect(r.planned.plan.prompt.compiled).toMatch(/ponte de madeira; rio/);
    expect((r.planned as unknown as { routeLabel: string }).routeLabel).toMatch(/não contém mapa, colisões nem objetos/);
    const rev = getRevision(studio.db, project.id, r.result!.revisionIds[0]!);
    const scene = ScenePayload.parse(rev.payload);
    expect(scene).toMatchObject({ outputKind: "flat_image", layers: [], cameraTest: null, editable: { map: false, collisions: false, objects: false }, logicalSize: [240, 160] });
    expect((rev.technicalReport as { notAMap: string }).notAMap).toMatch(/não são objetos/);
    expect((rev.technicalReport as { receivedSize: number[] }).receivedSize).toEqual([480, 320]);
    approve(project.id, rev.id);

    const heroId = await hero(project.id);
    const points = [{ pointId: "ponte", label: "Meio da ponte", at: [120, 111] as [number, number] }, { pointId: "margem", label: "Margem esquerda", at: [30, 140] as [number, number] }];
    const preview = await overlaySceneCharacter(studio, project.id, { sceneRevisionId: rev.id, characterRevisionId: heroId, supportPoints: points });
    expect(preview).toMatchObject({ view: "E", report: { characterHeightPx: 21 } });
    const annotated = await annotateScene(studio, project.id, { sceneRevisionId: rev.id, characterRevisionId: heroId, supportPoints: points });
    const ap = ScenePayload.parse(annotated.revision.payload);
    expect(ap).toMatchObject({ outputKind: "flat_image", supportPoints: points, characterScale: { characterRevisionId: heroId, heightPx: 21 } });
    expect(annotated.revision.files.map((f) => f.fileKey).sort()).toEqual(["image", "raw", "scale-overlay"]);
  });

  it("planos gerados separadamente, compostos com câmera por duas larguras do fundo; plano reprovado não repete; derivação de imagem plana usa E1; exporta e o leitor recompõe", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Lateral" });
    const layerIds: Record<string, string> = {};
    for (const [depth, name, transparent] of [["sky", "céu", false], ["mid", "morros", true], ["ground", "chão", true]] as const) {
      const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "scene_layer", name });
      const r = await run(project.id, { operation: "generate_scene", providerProfileId: "simulated", brief: "floresta ao entardecer, plataforma lateral", logicalSize: [160, 96], layer: { name, depth, repeatX: true, transparent } }, asset.id, `layer:${depth}`);
      expect(r.error).toBeNull();
      const lp = SceneLayerPayload.parse(getRevision(studio.db, project.id, r.result!.revisionIds[0]!).payload);
      expect(lp).toMatchObject({ obtained: "generated_separately", depth, repeat: { x: true, y: false }, continuity: { x: { passed: true } } });
      if (depth === "ground") expect(lp.groundLineY).toBe(76);
      approve(project.id, r.result!.revisionIds[0]!);
      layerIds[depth] = r.result!.revisionIds[0]!;
    }
    const layers = [
      { layerId: "ceu", name: "Céu", layerRevisionId: layerIds.sky!, parallax: { x: 0.2, y: 0 } },
      { layerId: "morros", name: "Morros", layerRevisionId: layerIds.mid!, parallax: { x: 0.5, y: 0 } },
      { layerId: "chao", name: "Chão", layerRevisionId: layerIds.ground!, parallax: { x: 1, y: 0 } },
    ];
    const preview = await previewScene(studio, project.id, { logicalSize: [160, 96], layers, groundLineY: 76 });
    expect(preview.cameraTest).toMatchObject({ spanPx: 1600, uncoveredFrames: 0, loopPassed: true, groundContinuous: true });
    const sceneAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "scene", name: "Floresta lateral" });
    const composed = await composeScene(studio, project.id, sceneAsset.id, { logicalSize: [160, 96], layers, groundLineY: 76 });
    const cp = ScenePayload.parse(composed.revision.payload);
    expect(cp).toMatchObject({ outputKind: "layers", cameraTest: { loopPassed: true }, editable: { map: false } });
    approve(project.id, composed.revision.id);

    // Plano importado com borda discrepante: emenda reprovada, não vira repetível e a composição recusa repetir.
    const broken = torusTexture("faixa", [64, 32], 1, [90, 70, 120]);
    for (let y = 0; y < 32; y++) setPixel(broken, 63, y, [12, 12, 16, 255]);
    const badAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "scene_layer", name: "faixa quebrada" });
    const bad = await publishSceneLayer(studio, project.id, badAsset.id, { image: { from: "upload", uploadId: await upload(project.id, "faixa.png", encodePng(broken)) }, depth: "far", repeatX: true });
    expect(SceneLayerPayload.parse(bad.revision.payload)).toMatchObject({ obtained: "imported", requestedRepeat: { x: true }, repeat: { x: false }, continuity: { x: { passed: false } } });
    approve(project.id, bad.revision.id);
    await expect(previewScene(studio, project.id, { logicalSize: [160, 96], layers: [layers[0]!, { layerId: "faixa", name: "Faixa", layerRevisionId: bad.revision.id, parallax: { x: 0.4, y: 0 } }] })).rejects.toThrow(/não é repetível em x: a emenda foi reprovada/);
    // Correção da emenda: deslocar meia largura (etapa sem promessa de repetição), E1 na faixa central, desfazer e revalidar.
    const shifted = await shiftLayerForSeam(studio, project.id, { layerRevisionId: bad.revision.id });
    expect(SceneLayerPayload.parse(shifted.revision.payload)).toMatchObject({ requestedRepeat: { x: false }, repeat: { x: false } });
    approve(project.id, shifted.revision.id);
    const seam = await run(project.id, { operation: "inpaint", providerProfileId: "simulated", sourceRevisionId: shifted.inpaint.sourceRevisionId, sourceFileKey: shifted.inpaint.sourceFileKey, maskUploadId: shifted.maskUploadId, instruction: "una as duas metades sem costura", mode: "native-mask" }, badAsset.id, "inpaint:emenda");
    expect(seam.error).toBeNull();
    approve(project.id, seam.result!.revisionIds[0]!);
    const fixed = await publishSceneLayer(studio, project.id, badAsset.id, { image: { from: "revision", revisionId: seam.result!.revisionIds[0]!, fileKey: "layer" }, depth: "far", repeatX: true, unshift: true, sourceRevisionId: bad.revision.id });
    expect((fixed.revision.technicalReport as { routeLabel: string }).routeLabel).toMatch(/emenda corrigida por inpainting/);
    expect(SceneLayerPayload.parse(fixed.revision.payload)).toMatchObject({ requestedRepeat: { x: true }, continuity: { x: { passed: true } }, repeat: { x: true } });

    // Derivar um plano de uma imagem plana: recorte com máscara revisada + fundo reconstruído por inpainting (E1).
    const flatAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "scene", name: "Plana" });
    const flat = await run(project.id, { operation: "generate_scene", providerProfileId: "simulated", brief: "clareira com árvore", logicalSize: [96, 64] }, flatAsset.id, "scene:flat");
    approve(project.id, flat.result!.revisionIds[0]!);
    const maskImg = createImage(96, 64);
    fillRect(maskImg, 0, 0, 96, 64, [0, 0, 0, 255]);
    fillRect(maskImg, 20, 10, 14, 30, [255, 255, 255, 255]);
    const cut = await cutSceneLayer(studio, project.id, { sceneRevisionId: flat.result!.revisionIds[0]!, maskUploadId: await upload(project.id, "arvore.png", encodePng(maskImg)) });
    expect(cut.report).toMatchObject({ pieceRect: [20, 10, 14, 30], needsReconstruction: true });
    expect(cut.label).toMatch(/inpainting \(E1\)/);
    const nearAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "scene_layer", name: "árvore (derivada)" });
    const near = await publishSceneLayer(studio, project.id, nearAsset.id, { image: { from: "upload", uploadId: cut.pieceUploadId }, depth: "near", repeatX: false, derivation: { sourceRevisionId: flat.result!.revisionIds[0]!, maskUploadId: cut.areaMaskUploadId, hiddenAreas: "transparent_reviewed" } });
    expect(SceneLayerPayload.parse(near.revision.payload)).toMatchObject({ obtained: "derived_local_reviewed", derivation: { hiddenAreas: "transparent_reviewed" } });
    const backAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "scene_layer", name: "fundo (derivado)" });
    await expect(
      publishSceneLayer(studio, project.id, backAsset.id, { image: { from: "revision", revisionId: flat.result!.revisionIds[0]!, fileKey: "image" }, depth: "far", repeatX: false, derivation: { sourceRevisionId: flat.result!.revisionIds[0]!, maskUploadId: cut.areaMaskUploadId, hiddenAreas: "reconstructed_inpaint", inpaintRevisionId: flat.result!.revisionIds[0]! } }),
    ).rejects.toThrow(/não é um inpainting/);
    const inpaint = await run(project.id, { operation: "inpaint", providerProfileId: "simulated", sourceRevisionId: cut.inpaint.sourceRevisionId, sourceFileKey: cut.inpaint.sourceFileKey, maskUploadId: cut.areaMaskUploadId, instruction: "fundo de floresta contínuo atrás da árvore", mode: "native-mask" }, flatAsset.id, "inpaint:arvore");
    expect(inpaint.error).toBeNull();
    approve(project.id, inpaint.result!.revisionIds[0]!);
    const back = await publishSceneLayer(studio, project.id, backAsset.id, {
      image: { from: "revision", revisionId: inpaint.result!.revisionIds[0]!, fileKey: "image" },
      depth: "far",
      repeatX: false,
      derivation: { sourceRevisionId: flat.result!.revisionIds[0]!, maskUploadId: cut.areaMaskUploadId, hiddenAreas: "reconstructed_inpaint", inpaintRevisionId: inpaint.result!.revisionIds[0]! },
    });
    expect(SceneLayerPayload.parse(back.revision.payload).derivation).toMatchObject({ hiddenAreas: "reconstructed_inpaint", inpaintRevisionId: inpaint.result!.revisionIds[0]! });

    // Exportação X1: a cena depende dos três planos (runtime); o leitor independente recompõe a câmera.
    const { export: requested } = requestExport(studio, project.id, { revisionIds: [composed.revision.id], profile: "portable-v1" });
    expect(await studio.runner().runOnce()).toBe(true);
    const ready = getExport(studio.db, project.id, requested.id);
    expect([ready.state, ready.error]).toEqual(["ready", null]);
    const zip = new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
    const manifest = JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    const sceneEntry = manifest.entries.find((e: { kind: string }) => e.kind === "scene");
    expect(sceneEntry.dependencies.map((d: { role: string }) => d.role)).toEqual(["layer", "layer", "layer"]);
    const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-scenes-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "cena.zip"), zip);
    const reader = spawnSync(PYTHON, [READER, path.join(dir, "cena.zip"), path.join(dir, "out")], { encoding: "utf8" });
    expect(reader.status, reader.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8"));
    const s = summary.entries.find((e: { kind: string }) => e.kind === "scene");
    expect(s).toMatchObject({ outputKind: "layers", matchesImage: true, cameraSpan: 1600, editable: { map: false } });
    expect(s.frames).toHaveLength(3);
    expect(summary.entries.filter((e: { kind: string }) => e.kind === "scene_layer").map((e: { repeat: { x: boolean } }) => e.repeat.x)).toEqual([true, true, true]);
  });

  it("prop independente: gerado, revisado (colisão não vem do prompt), colocado num mapa e reutilizado em outro", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Props" });
    const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "object", name: "Baú" });
    const r = await run(project.id, { operation: "generate_map_object", providerProfileId: "simulated", brief: "baú de madeira com cantos de ferro", logicalSize: [32, 32] }, asset.id, "obj:bau");
    expect(r.error).toBeNull();
    expect(r.planned.plan.params).toMatchObject({ transparent: true, backgroundKey: null });
    expect(r.planned.plan.requiredCapabilities).toEqual(["text_to_image", "alpha_output"]);
    const obj = MapObjectPayload.parse(getRevision(studio.db, project.id, r.result!.revisionIds[0]!).payload);
    expect(obj).toMatchObject({ collision: [], footprintCells: [1, 1] });
    const reviewed = reviewObject(studio, project.id, { baseRevisionId: r.result!.revisionIds[0]!, supportPoint: obj.supportPoint, footprintCells: [1, 1], collision: [[6, 16, 20, 14]], occlusionAboveY: null });
    approve(project.id, reviewed.id);

    // Dois mapas do T1 com o mesmo prop.
    const grass = createAsset(studio.db, studio.clock, { projectId: project.id, family: "texture", kind: "material", name: "grama" });
    const water = createAsset(studio.db, studio.clock, { projectId: project.id, family: "texture", kind: "material", name: "água" });
    const g = await publishTexture(studio, project.id, grass.id, { image: { from: "upload", uploadId: await upload(project.id, "g.png", encodePng(torusTexture("g", [32, 32], 1, [80, 150, 60]))) }, material: "grama", axes: { x: true, y: true } });
    const w = await publishTexture(studio, project.id, water.id, { image: { from: "upload", uploadId: await upload(project.id, "w.png", encodePng(torusTexture("w", [32, 32], 1, [50, 100, 200]))) }, material: "água", axes: { x: true, y: true } });
    approve(project.id, g.revision.id);
    approve(project.id, w.revision.id);
    const tsAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "tileset", kind: "corner", name: "Grama ↔ água" });
    const ts = await buildTilesetTemplate(studio, project.id, tsAsset.id, { kind: "corner", materialA: g.revision.id, materialB: w.revision.id, terrains: [{ terrainId: "grass", name: "Grama", color: "#469632" }, { terrainId: "water", name: "Água", color: "#3264c8" }], diagonals: { mask5: "separate", mask10: "connected" } });
    for (const name of ["Mapa A", "Mapa B"]) {
      const { asset: mapAsset, draft } = createTilemap(studio, project.id, { name, tilesetRevisionId: ts.revision.id, size: [6, 4] });
      const map = TilemapPayload.parse(draft.payload);
      const published = publishTilemap(studio, project.id, mapAsset.id, { payload: { ...map, objects: [{ objectId: "bau-1", objectRevisionId: reviewed.id, pieceKey: null, cell: [2, 1], offsetPx: [0, 0] }] } });
      expect(TilemapPayload.parse(published.revision.payload).objects[0]!.objectRevisionId).toBe(reviewed.id);
    }
  });
});
