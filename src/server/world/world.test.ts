import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CornerTilesetPayload, type IsoTilesetPayload, type SideTilesetPayload, TexturePayload, TilemapPayload } from "@/contracts";
import { validateManifest } from "@/domain/manifest/validate";
import { asCornerMap, moveObject, paintCornerVertex } from "@/domain/world/map";
import { createImage, encodePng, fillRect, type RgbaImage, setPixel } from "@/lib/media/png";
import { readZip } from "@/lib/zip";
import { createAsset, createProject, getAsset, getUpload, listRevisions, reviewRevision } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { importPortablePackage } from "../export/import";
import { buildPlan } from "../plan-builders";
import { ingestUpload, submitJob } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { copyTilemap, createTilemap, openTilemap, publishMapObject, publishTilemap } from "./maps";
import { torusTexture } from "./simulated-art";
import { buildTilesetTemplate, checkTilesetRevision } from "./tilesets";
import { checkTexture, publishTexture } from "./textures";

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const READER = path.join(process.cwd(), "consumers", "portable_reader", "read_portable.py");

let studio: TestStudio;
const tmpDirs: string[] = [];
afterEach(() => {
  studio?.cleanup();
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function upload(projectId: string, name: string, image: RgbaImage) {
  const { upload } = await ingestUpload(studio, projectId, { name, bytes: encodePng(image) });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, projectId, upload.id).status).toBe("ready");
  return upload.id;
}

function approve(projectId: string, assetId: string, revisionId: string) {
  const asset = getAsset(studio.db, projectId, assetId);
  return reviewRevision(studio.db, studio.clock, { projectId, assetId, revisionId, decision: "approve", reason: null, expectedActiveRevisionId: asset.approvedRevisionId });
}

/** Borda direita discrepante deliberada (06 §demonstrações): precisa ser destacada, não aprovada. */
function brokenBorder(img: RgbaImage): RgbaImage {
  for (let y = 0; y < img.height; y++) setPixel(img, img.width - 1, y, [12, 12, 16, 255]);
  return img;
}

/** Árvore alta 32×48: copa larga, tronco estreito com base em (16, 44). */
function treeImage(): RgbaImage {
  const img = createImage(32, 48);
  for (let y = 2; y < 34; y++) for (let x = 2; x < 30; x++) if ((x - 16) ** 2 / 196 + (y - 18) ** 2 / 256 <= 1) setPixel(img, x, y, [40, 120, 50, 255]);
  fillRect(img, 13, 30, 6, 15, [110, 70, 40, 255]);
  return img;
}

async function textureRevision(projectId: string, name: string, image: RgbaImage, axes = { x: true, y: true }) {
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "texture", kind: "material", name });
  const { revision, report } = await publishTexture(studio, projectId, asset.id, { image: { from: "upload", uploadId: await upload(projectId, `${name}.png`, image) }, material: name, axes });
  return { asset, revision, report };
}

async function cornerTileset(projectId: string) {
  const grass = await textureRevision(projectId, "grama", torusTexture("grama", [32, 32], 1, [80, 150, 60]));
  const water = await textureRevision(projectId, "água", torusTexture("água", [32, 32], 1, [50, 100, 200]));
  approve(projectId, grass.asset.id, grass.revision.id);
  approve(projectId, water.asset.id, water.revision.id);
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "tileset", kind: "corner", name: "Grama ↔ água" });
  const built = await buildTilesetTemplate(studio, projectId, asset.id, {
    kind: "corner",
    materialA: grass.revision.id,
    materialB: water.revision.id,
    terrains: [
      { terrainId: "grass", name: "Grama", color: "#469632" },
      { terrainId: "water", name: "Água", color: "#3264c8" },
    ],
    diagonals: { mask5: "separate", mask10: "connected" },
  });
  return { asset, ...built, grass, water };
}

describe.skipIf(!existsSync(PYTHON))("mundo (cartão T1)", () => {
  it("material gerado: volta à grade lógica, valida a emenda nos dois eixos e publica com mosaico", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Mundo" });
    const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "texture", kind: "material", name: "Pedra úmida" });
    const planned = (await buildPlan(studio, project.id, {
      operation: "generate_texture",
      providerProfileId: "simulated",
      materialBrief: "pedra úmida com musgo entre as juntas",
      logicalSize: [32, 32],
      repeatAxes: { x: true, y: true },
    } as never)) as Awaited<ReturnType<typeof buildPlan>> & { routeLabel: string };
    expect(planned.plan.prompt.compiled).not.toMatch(/#[0-9a-f]{6}/i); // cores por nome, nunca hex
    expect(planned.routeLabel).toMatch(/validada localmente/);
    const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: asset.id } }, "tex-1");
    await studio.runner().runOnce();
    const done = studio.queue.get(job.id)!;
    expect([done.state, done.error_json]).toEqual(["succeeded", null]);
    const [rev] = listRevisions(studio.db, project.id, asset.id);
    const payload = TexturePayload.parse(rev!.payload);
    expect(payload.logicalSize).toEqual([32, 32]);
    expect(payload.repeatAxes).toEqual({ x: true, y: true });
    expect(payload.seamReport.x!.passed && payload.seamReport.y!.passed).toBe(true);
    expect(rev!.files.map((f) => f.fileKey).sort()).toEqual(["mosaic", "mosaic-lines", "raw", "shifted", "texture"]);
    expect((rev!.technicalReport as { receivedSize: number[] }).receivedSize).toEqual([128, 128]);
  });

  it("amostra com borda discrepante deliberada é destacada e guardada sem eixo repetível; um eixo não promete o outro", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Mundo" });
    const bad = await textureRevision(project.id, "pedra quebrada", brokenBorder(torusTexture("pedra", [32, 32], 1, [120, 116, 124])));
    const payload = TexturePayload.parse(bad.revision.payload);
    expect(payload.repeatAxes).toEqual({ x: false, y: true });
    expect(payload.requestedAxes).toEqual({ x: true, y: true });
    expect(bad.report.x!.passed).toBe(false);
    expect(bad.report.x!.flagged[0]).toMatchObject({ start: 0, end: 31 });

    const both = await textureRevision(project.id, "faixa", brokenBorder(brokenBorder(torusTexture("faixa", [32, 32], 1))), { x: true, y: false });
    expect(TexturePayload.parse(both.revision.payload)).toMatchObject({ repeatAxes: { x: false, y: false }, requestedAxes: { x: true, y: false }, seamReport: { y: null } });

    const uploadId = await upload(project.id, "ok.png", torusTexture("ok", [32, 32]));
    const bench = await checkTexture(studio, project.id, { image: { from: "upload", uploadId }, axes: { x: true, y: false } });
    expect(bench.report.mosaicGrid).toEqual([3, 1]);
    expect(bench.previews.mosaicLines).toMatch(/^data:image\/png;base64,/);
  });

  it("gabarito por cantos: 16 máscaras, 64 pares por eixo sem costura discrepante; geração guiada reaplica a faixa travada", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Mundo" });
    const { asset, revision, check, routeLabel } = await cornerTileset(project.id);
    expect(routeLabel).toMatch(/não é geração nativa/);
    const payload = revision.payload as CornerTilesetPayload;
    expect(payload.complete).toBe(true);
    expect(payload.tiles.map((t) => t.mask).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    const report = check.report as { pairs: { x: number; y: number }; flagged: unknown[]; missingMasks: number[] };
    expect(report.pairs).toEqual({ x: 64, y: 64 });
    expect(report.flagged).toEqual([]);
    expect(report.missingMasks).toEqual([]);
    approve(project.id, asset.id, revision.id);

    const planned = await buildPlan(studio, project.id, { operation: "generate_tileset", providerProfileId: "simulated", guideRevisionId: revision.id, instruction: "grama com tufos e água com reflexos" } as never);
    expect(planned.plan.requiredCapabilities).toEqual(["image_references", "image_edit"]);
    expect(planned.plan.sources[0]).toMatchObject({ role: "base", revisionId: revision.id });
    const { job } = submitJob(studio, project.id, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId: asset.id } }, "ts-1");
    await studio.runner().runOnce();
    expect(studio.queue.get(job.id)!.error_json).toBeNull();
    const guided = listRevisions(studio.db, project.id, asset.id)[0]!;
    const tr = guided.technicalReport as { routeLabel: string; composite: { protectedDiffPixels: number }; check: { locked: { passed: boolean }; flagged: unknown[] } };
    expect(guided.predecessorId).toBe(revision.id);
    expect(tr.routeLabel).toMatch(/Não é geração nativa de tileset/);
    expect(tr.composite.protectedDiffPixels).toBe(0);
    expect(tr.check.locked.passed).toBe(true);
    expect((tr.check.locked as unknown as { frameFlagged: string[] }).frameFlagged).toEqual([]); // sem moldura falsa quando o miolo segue o gabarito
    expect(tr.check.flagged).toEqual([]);
    const recheck = await checkTilesetRevision(studio, project.id, guided.id);
    expect(recheck.previews.sample).toMatch(/^data:image\/png/);
  });

  it("tabela lateral própria: lacuna fica visível e o conjunto não se declara completo", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Lateral" });
    const body = await textureRevision(project.id, "terra", torusTexture("terra", [16, 16], 1, [120, 90, 60]));
    const top = await textureRevision(project.id, "grama", torusTexture("grama", [16, 16], 1, [70, 160, 60]));
    approve(project.id, body.asset.id, body.revision.id);
    approve(project.id, top.asset.id, top.revision.id);
    const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "tileset", kind: "sidescroller", name: "Plataforma" });
    const { revision, check } = await buildTilesetTemplate(studio, project.id, asset.id, {
      kind: "sidescroller",
      body: body.revision.id,
      surface: top.revision.id,
      configurations: ["surface_middle", "surface_left", "surface_right", "interior", "wall_left", "wall_right", "inner_corner_left"],
    });
    const payload = revision.payload as SideTilesetPayload;
    expect(payload.complete).toBe(false);
    expect((check.report as { gaps: string[] }).gaps).toEqual(["inner_corner_right"]);
    expect(check.warnings.join(" ")).toMatch(/inner_corner_right/);
  });

  it("quatro losangos e prop alto conservam o apoio (peças locais + árvore importada)", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Iso" });
    const floor = await textureRevision(project.id, "grama", torusTexture("grama", [32, 32], 1, [90, 150, 60]));
    approve(project.id, floor.asset.id, floor.revision.id);
    const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "tileset", kind: "isometric", name: "Bosque iso" });
    const tree = createImage(48, 96);
    for (let y = 4; y < 66; y++) for (let x = 4; x < 44; x++) if ((x - 24) ** 2 / 400 + (y - 33) ** 2 / 900 <= 1) setPixel(tree, x, y, [50, 130, 60, 255]);
    fillRect(tree, 21, 62, 6, 31, [110, 70, 40, 255]);
    const treeUpload = await upload(project.id, "arvore-alta.png", tree);
    const { revision, check } = await buildTilesetTemplate(studio, project.id, asset.id, {
      kind: "isometric",
      floor: floor.revision.id,
      prop: { image: { from: "upload", uploadId: treeUpload }, name: "Árvore alta", supportPoint: [24, 92], occluderRect: [0, 0, 48, 66] },
    });
    const payload = revision.payload as IsoTilesetPayload;
    expect(payload.pieces.map((p) => p.kind)).toEqual(["floor", "block", "prop"]);
    const r = check.report as { floors: { ok: boolean; iou: number }[]; patch: { holes: number; overlaps: number }; props: { ok: boolean }[]; placements: { ok: boolean }[] };
    expect(r.floors[0]).toMatchObject({ ok: true, iou: 1 });
    expect(r.patch).toMatchObject({ holes: 0, overlaps: 0 });
    expect(r.props[0]!.ok).toBe(true);
    expect(r.placements[0]!.ok).toBe(true);
  });

  it("mapa 12×8: mover árvore, repintar terreno e manter a passagem entre portas depois de reabrir; exporta pelo X1", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Clareira" });
    const { asset: tsAsset, revision: tsRev } = await cornerTileset(project.id);
    approve(project.id, tsAsset.id, tsRev.id);
    const ts = tsRev.payload as CornerTilesetPayload;

    const treeAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "object", name: "Árvore" });
    const treeRev = publishMapObject(studio, project.id, treeAsset.id, {
      image: { from: "upload", uploadId: await upload(project.id, "arvore.png", treeImage()) },
      supportPoint: [16, 44],
      collision: [[13, 38, 6, 7]],
      occlusionAboveY: 34,
    });
    approve(project.id, treeAsset.id, treeRev.id);

    const { asset: mapAsset, draft } = createTilemap(studio, project.id, { name: "Clareira 12×8", tilesetRevisionId: tsRev.id });
    let map = asCornerMap(TilemapPayload.parse(draft.payload));
    expect(map.size).toEqual([12, 8]);
    for (let vy = 2; vy <= 5; vy++) for (let vx = 5; vx <= 7; vx++) map = paintCornerVertex(map, ts, vx, vy, 1).map;
    const edited: TilemapPayload = {
      ...map,
      objects: [{ objectId: "arvore-1", objectRevisionId: treeRev.id, pieceKey: null, cell: [3, 3], offsetPx: [0, 0] }],
      regions: [{ regionId: "clareira", name: "Clareira", kind: "area", rect: [0, 0, 5, 8] }],
      collisions: [{ collisionId: "rocha", kind: "cells", cells: [[9, 6]] }],
      entrances: [
        { entranceId: "porta-oeste", name: "Oeste", cell: [0, 4], side: "W" },
        { entranceId: "porta-leste", name: "Leste", cell: [11, 4], side: "E" },
      ],
      passages: [{ from: "porta-oeste", to: "porta-leste" }],
    };
    const first = publishTilemap(studio, project.id, mapAsset.id, { payload: edited });
    expect(first.passages[0]).toMatchObject({ connected: true });

    // Reabrir a revisão publicada reproduz terreno, objetos e coordenadas.
    const reopened = openTilemap(studio, project.id, mapAsset.id, { revisionId: first.revision.id });
    expect(reopened.payload).toEqual(TilemapPayload.parse(first.revision.payload));
    expect(reopened.payload.objects[0]!.cell).toEqual([3, 3]);
    expect(reopened.tileset.atlasMediaId).toBeTruthy();
    expect(Object.keys(reopened.objects)).toEqual([treeRev.id]);

    // Mover a árvore e repintar terreno (sem fechar os vaus): a passagem continua.
    const second = paintCornerVertex(asCornerMap(moveObject(reopened.payload, "arvore-1", [8, 1], [2, -3])), ts, 2, 6, 1).map;
    const republished = publishTilemap(studio, project.id, mapAsset.id, { payload: second });
    expect(republished.passages[0]).toMatchObject({ connected: true });
    const again = openTilemap(studio, project.id, mapAsset.id, { revisionId: republished.revision.id });
    expect(again.payload.objects[0]).toMatchObject({ cell: [8, 1], offsetPx: [2, -3] });

    // Fechar a passagem com água de cima a baixo é recusado na publicação.
    let wall = asCornerMap(again.payload);
    for (let vy = 0; vy <= 8; vy++) for (let vx = 5; vx <= 7; vx++) wall = paintCornerVertex(wall, ts, vx, vy, 1).map;
    const err = (() => {
      try {
        publishTilemap(studio, project.id, mapAsset.id, { payload: wall });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(DomainFailure);
    expect((err as DomainFailure).message).toMatch(/Passagem interrompida: porta-oeste → porta-leste/);

    // Cópia com outra revisão do tileset: traçado e colocações coincidem.
    const copy = copyTilemap(studio, project.id, mapAsset.id, { revisionId: republished.revision.id, name: "Cópia", tilesetRevisionId: tsRev.id });
    const copied = TilemapPayload.parse(copy.draft.payload);
    expect(copied.terrain).toEqual(TilemapPayload.parse(republished.revision.payload).terrain);
    expect(copied.objects).toEqual(TilemapPayload.parse(republished.revision.payload).objects);

    // Exportação X1: o fecho inclui tileset e objeto; o manifesto valida; o pacote reabre noutro projeto.
    approve(project.id, mapAsset.id, republished.revision.id);
    const { export: requested } = requestExport(studio, project.id, { revisionIds: [republished.revision.id], profile: "portable-v1" });
    expect(await studio.runner().runOnce()).toBe(true);
    const ready = getExport(studio.db, project.id, requested.id);
    expect(ready.state).toBe("ready");
    expect(ready.report?.families).toMatchObject({ map: 2, tileset: 1 });
    const zip = new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
    const archive = readZip(zip);
    const manifest = JSON.parse(new TextDecoder().decode(archive.read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    const mapEntry = manifest.entries.find((e: { kind: string }) => e.kind === "tilemap");
    expect(mapEntry.dependencies.map((d: { role: string }) => d.role).sort()).toEqual(["object", "tileset"]);
    expect(mapEntry.payload.units).toEqual({ cell: "cell", offset: "px", polygon: "px" });

    const other = createProject(studio.db, studio.clock, { name: "Reaberto" });
    const { revisionMap } = await importPortablePackage(studio, other.id, archive, { approve: true });
    const reimported = listRevisions(studio.db, other.id, findAsset(other.id, "tilemap"))[0]!;
    const rp = TilemapPayload.parse(reimported.payload);
    expect(rp.terrain.tilesetRevisionId).toBe(revisionMap[tsRev.id]);
    expect(rp.objects[0]!.objectRevisionId).toBe(revisionMap[treeRev.id]);
    expect(rp.objects[0]!.cell).toEqual([8, 1]);

    // Consumidor independente: reconstrói o mapa pelas chaves, sem o Studio.
    const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-world-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "mapa.zip"), zip);
    const run = spawnSync(PYTHON, [READER, path.join(dir, "mapa.zip"), path.join(dir, "out")], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8"));
    const tilemap = summary.entries.find((e: { kind: string }) => e.kind === "tilemap");
    expect(tilemap).toMatchObject({ size: [12, 8], objects: 1, entrances: ["porta-oeste", "porta-leste"], missingTiles: 0 });
    expect(existsSync(path.join(dir, "out", tilemap.file))).toBe(true);
  });
});

function findAsset(projectId: string, kind: string): string {
  const row = studio.db.get<{ id: string }>("SELECT id FROM assets WHERE project_id = :p AND kind = :k", { p: projectId, k: kind });
  return row!.id;
}
