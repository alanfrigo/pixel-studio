import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CornerTilesetPayload, MapObjectPayload, RoomPayload, TilemapPayload } from "@/contracts";
import type { LocalizedText } from "@/i18n/locales";
import { validateManifest } from "@/domain/manifest/validate";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { readZip } from "@/lib/zip";
import { createAsset, createProject, getAsset, getRevision, getUpload, reviewRevision } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { buildPlan } from "../plan-builders";
import { ingestUpload, submitJob } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { composeExtracted, editRoom, inspectKit, mapKit, previewCutout, previewLink, previewRoom, publishCutout, reviewObject, roomToMap } from "./rooms";

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

/** Máscara opaca preto/branco com o retângulo marcado (255 = recortar). */
function rectMask(size: [number, number], rect: [number, number, number, number]) {
  const img = createImage(size[0], size[1]);
  fillRect(img, 0, 0, size[0], size[1], [0, 0, 0, 255]);
  fillRect(img, rect[0], rect[1], rect[2], rect[3], [255, 255, 255, 255]);
  return encodePng(img);
}

async function run(projectId: string, body: Record<string, unknown>, targetAssetId: string, key: string) {
  const planned = await buildPlan(studio, projectId, body as never);
  const { job } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId } }, key);
  await studio.runner().runOnce();
  const done = studio.queue.get(job.id)!;
  return { planned, done, result: JSON.parse(done.result_json ?? "null") as { revisionIds: string[] } | null, error: JSON.parse(done.error_json ?? "null") as { message: string } | null };
}

const DOORS = [
  { doorId: "porta-sul", cell: [3, 5], side: "S" },
  { doorId: "porta-leste", cell: [6, 2], side: "E" },
];

async function genericRoom(projectId: string, name: string, theme: string, doors = DOORS, extra: Record<string, unknown> = {}) {
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "map", kind: "room", name });
  const r = await run(projectId, { operation: "generate_room", providerProfileId: "simulated", theme, doors, ...extra }, asset.id, `room:${name}`);
  expect(r.error).toBeNull();
  return { asset, revisionId: r.result!.revisionIds[0]!, planned: r.planned };
}

describe.skipIf(!existsSync(PYTHON))("salas (cartão T2)", { timeout: 60_000 }, () => {
  it("rota genérica: planta como guia raster; recortar a mesa, reconstruir a área por inpainting, mover e reutilizar em outra sala; exportar e reconstruir fora do Studio", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Edifício" });
    const a = await genericRoom(project.id, "Biblioteca", "biblioteca de um castelo, estantes e uma mesa de leitura");
    expect(a.planned.plan.params).toMatchObject({ guide: { pictureSize: [256, 256], cellPx: [32, 32], gridOrigin: [16, 48] } });
    expect(a.planned.plan.requiredCapabilities).toEqual(["text_to_image", "image_references"]);
    expect(a.planned.plan.prompt.compiled).not.toMatch(/#[0-9a-f]{6}/i);
    expect((a.planned as unknown as { routeLabel: LocalizedText }).routeLabel).toMatchObject({ "pt-BR": expect.stringMatching(/não é geração nativa de sala/), en: expect.stringMatching(/not native room generation/) });
    const roomRev = getRevision(studio.db, project.id, a.revisionId);
    const room = RoomPayload.parse(roomRev.payload);
    expect(room).toMatchObject({ route: "generic_image_references", projection: "top_down", picture: { rect: [0, 0, 256, 256] } });
    expect(room.doors.map((d) => [d.doorId, d.anchorPx])).toEqual([["porta-sul", [128, 256]], ["porta-leste", [256, 144]]]);
    expect(roomRev.files.map((f) => f.fileKey).sort()).toEqual(["guide", "picture", "raw"]);
    approve(project.id, a.revisionId);

    // Mesa desenhada pela sala simulada na célula (3,2): retângulo [115,118,26,18] e sombra embaixo.
    const maskId = await upload(project.id, "mesa.png", rectMask([256, 256], [115, 118, 26, 18]));
    const shadowId = await upload(project.id, "sombra.png", rectMask([256, 256], [117, 134, 26, 3]));
    const preview = await previewCutout(studio, project.id, { roomRevisionId: a.revisionId, maskUploadId: maskId, shadowMaskUploadId: shadowId });
    expect(preview.report).toMatchObject({ pieceRect: [115, 118, 26, 18], shadowOffset: [2, 16], needsReconstruction: true });
    expect(preview.previews.area).toMatch(/^data:image\/png/);

    const cut = await publishCutout(studio, project.id, { roomRevisionId: a.revisionId, maskUploadId: maskId, shadowMaskUploadId: shadowId, name: "mesa", collision: [[0, 12, 26, 6]] });
    const table = MapObjectPayload.parse(cut.object.payload);
    expect(table).toMatchObject({ supportPoint: [13, 18], shadow: { offset: [2, 16] }, sourceRoom: { roomRevisionId: a.revisionId, method: "local_mask_cutout" } });
    approve(project.id, cut.object.id);

    // Só apagar o alfa não basta: o contorno é piso.
    expect(() => composeExtracted(studio, project.id, { roomRevisionId: a.revisionId, areaMaskUploadId: cut.areaMaskUploadId, reconstruction: { kind: "transparent" } })).toThrow(/reconstrua por inpainting/);

    // E1: inpainting da área antes oculta, revisado e aprovado.
    const inpaint = await run(project.id, { operation: "inpaint", providerProfileId: "simulated", sourceRevisionId: a.revisionId, sourceFileKey: "picture", maskUploadId: cut.areaMaskUploadId, instruction: "piso de madeira contínuo onde estava a mesa", mode: "native-mask" }, a.asset.id, "inpaint:mesa");
    expect(inpaint.error).toBeNull();
    const inpaintId = inpaint.result!.revisionIds[0]!;
    expect((getRevision(studio.db, project.id, inpaintId).technicalReport as { composite: { protectedDiffPixels: number } }).composite.protectedDiffPixels).toBe(0);
    expect(() => composeExtracted(studio, project.id, { roomRevisionId: a.revisionId, areaMaskUploadId: cut.areaMaskUploadId, reconstruction: { kind: "inpaint", inpaintRevisionId: inpaintId } })).toThrow(/aprove o inpainting/i);
    approve(project.id, inpaintId);
    const furnished = composeExtracted(studio, project.id, { roomRevisionId: a.revisionId, areaMaskUploadId: cut.areaMaskUploadId, reconstruction: { kind: "inpaint", inpaintRevisionId: inpaintId } });
    const fp = RoomPayload.parse(furnished.payload);
    expect(fp.furniture).toEqual([{ placementId: "mesa-1", objectRevisionId: cut.object.id, supportAtPx: [128, 136], label: "mesa" }]);
    expect(fp.exposedAreas[0]).toMatchObject({ status: "reconstructed_inpaint", inpaintRevisionId: inpaintId, measured: { contextOpaque: expect.any(Number) } });
    expect(fp.background).toEqual({ fileId: "background", rect: [0, 0, 256, 256] });
    approve(project.id, furnished.id);

    // Mover a mesa (outra revisão) e recusar apoio fora do piso.
    const moved = editRoom(studio, project.id, { baseRevisionId: furnished.id, furniture: [{ ...fp.furniture[0]!, supportAtPx: [80, 200] }] });
    expect(moved.furniture[0]!.problems).toEqual([]);
    expect(() => editRoom(studio, project.id, { baseRevisionId: furnished.id, furniture: [{ ...fp.furniture[0]!, supportAtPx: [4, 4] }] })).toThrow(/fora do piso/);
    approve(project.id, moved.revision.id);
    expect((await previewRoom(studio, project.id, moved.revision.id)).previews.room).toMatch(/^data:image\/png/);

    // Segunda sala do edifício: mesma vista/escala, estilo da primeira, porta oeste ligada à leste da primeira, e a mesa reutilizada.
    const b = await genericRoom(project.id, "Sala de estudo", "sala de estudo do mesmo castelo", [{ doorId: "porta-oeste", cell: [0, 2], side: "W" }], { styleRoomRevisionId: furnished.id });
    expect(b.planned.plan.sources[0]).toMatchObject({ role: "style", revisionId: furnished.id, fileId: "background" });
    approve(project.id, b.revisionId);
    const link = await previewLink(studio, project.id, { aRevisionId: moved.revision.id, aDoorId: "porta-leste", bRevisionId: b.revisionId, bDoorId: "porta-oeste" });
    expect(link.link).toMatchObject({ ok: true, offsetPx: [256, 0], method: "anchors" });
    expect(link.preview).toMatch(/^data:image\/png/);
    const reused = editRoom(studio, project.id, {
      baseRevisionId: b.revisionId,
      furniture: [{ placementId: "mesa", objectRevisionId: cut.object.id, supportAtPx: [100, 160], label: "mesa reutilizada" }],
      connections: [{ doorId: "porta-oeste", toRoomRevisionId: moved.revision.id, toDoorId: "porta-leste" }],
    });
    expect(reused.connections[0]).toMatchObject({ ok: true, method: "anchors", offsetPx: [-256, 0] });
    approve(project.id, reused.revision.id);
    // Escala diferente (célula 16) recusa reutilizar a mesa.
    const small = await genericRoom(project.id, "Torre", "quarto pequeno da torre", [{ doorId: "s", cell: [3, 5], side: "S" }], { projection: "isometric", tileSize: 16 });
    approve(project.id, small.revisionId);
    expect(() => editRoom(studio, project.id, { baseRevisionId: small.revisionId, furniture: [{ placementId: "mesa", objectRevisionId: cut.object.id, supportAtPx: [60, 40] }] })).toThrow(/isometric|escala/);

    // Exportação X1: sala B depende da mesa e da sala A (runtime); origem, estilo e inpainting são proveniência.
    const { export: requested } = requestExport(studio, project.id, { revisionIds: [reused.revision.id], profile: "portable-v1" });
    expect(await studio.runner().runOnce()).toBe(true);
    const ready = getExport(studio.db, project.id, requested.id);
    expect([ready.state, ready.error]).toEqual(["ready", null]);
    const zip = new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
    const manifest = JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    const roomB = manifest.entries.find((e: { revisionId: string }) => e.revisionId === reused.revision.id);
    expect(roomB.dependencies.map((d: { role: string }) => d.role).sort()).toEqual(["connected_room", "furniture"]);
    expect(roomB.dependencies.some((d: { revisionId: string }) => d.revisionId === inpaintId || d.revisionId === b.revisionId)).toBe(false);
    const roomA = manifest.entries.find((e: { revisionId: string }) => e.revisionId === moved.revision.id);
    expect(roomA.payload.exposedAreas[0].status).toBe("reconstructed_inpaint");
    expect(manifest.files.some((f: { path: string }) => f.path.endsWith(".zip"))).toBe(false);

    const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-rooms-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "salas.zip"), zip);
    const reader = spawnSync(PYTHON, [READER, path.join(dir, "salas.zip"), path.join(dir, "out")], { encoding: "utf8" });
    expect(reader.status, reader.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8"));
    const rb = summary.entries.find((e: { revisionId: string }) => e.revisionId === reused.revision.id);
    expect(rb).toMatchObject({ projection: "top_down", floorPlan: [7, 6], furniture: ["mesa"], connections: [["porta-oeste", moved.revision.id, "porta-leste"]] });
    expect(existsSync(path.join(dir, "out", rb.file))).toBe(true);
    const tableEntry = summary.entries.find((e: { revisionId: string }) => e.revisionId === cut.object.id);
    expect(tableEntry).toMatchObject({ shadow: true, sourceRoom: a.revisionId });

    // Revisar o prop (colisão) preserva sombra e origem.
    const reviewed = reviewObject(studio, project.id, { baseRevisionId: cut.object.id, supportPoint: [13, 18], footprintCells: [1, 1], collision: [[2, 10, 22, 8]], occlusionAboveY: 6 });
    expect(MapObjectPayload.parse(reviewed.payload)).toMatchObject({ shadow: { offset: [2, 16] }, sourceRoom: { roomRevisionId: a.revisionId }, occlusionAboveY: 6 });
  });

  it("kit local pela grade da imagem da sala → tileset por cantos → trecho editável no T1", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Castelo" });
    const forge = await genericRoom(project.id, "Forja", "forja de ferreiro sob o castelo");
    approve(project.id, forge.revisionId);
    // Sala de estilo só da mesma vista e escala.
    await expect(buildPlan(studio, project.id, { operation: "generate_room", providerProfileId: "simulated", theme: "outra vista", projection: "isometric", doors: [{ doorId: "w", cell: [0, 2], side: "W" }], styleRoomRevisionId: forge.revisionId } as never)).rejects.toThrow(/mesma vista/);

    const inspected = inspectKit(studio, project.id, forge.revisionId);
    expect(inspected.sheets).toMatchObject([{ sheetId: "picture", size: [256, 256], source: "picture" }]);
    expect(inspected.grid).toEqual({ cellPx: [32, 32], gridOrigin: [16, 48] });
    // Grade da sala deslocada meia célula: os cantos piso/parede ficam no meio dos tiles.
    const keys = Array.from({ length: 16 }, (_, mask) => ({ kind: "mask" as const, mask }));
    const mapped = await mapKit(studio, project.id, { roomRevisionId: forge.revisionId, name: "Kit da forja", origin: [0, 32], cell: [32, 32], keys });
    expect(mapped.complete).toBe(true);
    expect((mapped.tileset.payload as CornerTilesetPayload).terrains.map((t) => t.terrainId)).toEqual(["floor", "wall"]);
    expect((mapped.tileset.technicalReport as { routeLabel: LocalizedText }).routeLabel["pt-BR"]).toMatch(/Kit derivado localmente/);
    const missing = await mapKit(studio, project.id, { roomRevisionId: forge.revisionId, name: "Kit incompleto", origin: [0, 32], cell: [32, 32], keys: keys.slice(0, 15) });
    expect([missing.complete, missing.missing]).toEqual([false, [15]]);
    approve(project.id, mapped.tileset.id);
    const built = roomToMap(studio, project.id, { roomRevisionId: forge.revisionId, tilesetRevisionId: mapped.tileset.id, name: "Forja (mapa)" });
    const map = TilemapPayload.parse(built.draft.payload);
    expect(map.size).toEqual([9, 8]);
    expect(map.entrances.map((e) => e.entranceId)).toEqual(["porta-sul", "porta-leste"]);
    expect(built.passages[0]).toMatchObject({ from: "porta-sul", to: "porta-leste", connected: true });
    expect(built.openUrl).toContain("/world?tab=maps&map=");
  });

  it("oblíqua: sem móveis a extrair, e a restrição aparece antes de cobrar", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Oblíqua" });
    const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "room", name: "Corredor" });
    const r = await run(project.id, { operation: "generate_room", providerProfileId: "simulated", theme: "corredor de pedra", projection: "oblique", doors: [{ doorId: "n", cell: [3, 0], side: "N" }] }, asset.id, "room:obl");
    expect(r.error).toBeNull();
    approve(project.id, r.result!.revisionIds[0]!);
    expect((r.planned as unknown as { restrictions: LocalizedText[] }).restrictions.map((t) => t["pt-BR"]).join(" ")).toMatch(/Oblíqua/);
    const failure = await (async () => {
      try {
        await previewCutout(studio, project.id, { roomRevisionId: r.result!.revisionIds[0]!, maskUploadId: "x" });
      } catch (e) {
        return e;
      }
    })();
    expect(failure).toBeInstanceOf(DomainFailure);
  });
});
