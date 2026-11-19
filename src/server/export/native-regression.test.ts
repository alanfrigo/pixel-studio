import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ClipPayload, Manifest, type ManifestEntry, TilemapPayload } from "@/contracts";
import { entryRefs } from "@/domain/manifest/refs";
import { sha256Hex } from "@/domain/manifest/verify-files";
import { C } from "@/fixtures/art";
import { buildClareira } from "@/fixtures/clareira";
import { readZip, writeZip, type ZipArchive } from "@/lib/zip";
import { createProject, getRevision } from "../catalog/catalog";
import { makeTestStudio, type TestStudio } from "../testing";
import { type ExportView, exportFilePath, getExport, requestExport } from "./exports";
import { importPortablePackage } from "./import";
import type { ExportProfileId } from "./profiles";

const CLIP = "warrior-attack-osh-s-v1";
const SPARK = "spark-v1";
const POTION = "potion-v1";
const TILESET = "grass-water-v1";
const PROP = "trail-potion-v1";
const MAP = "lake-trail-v1";
const masks = [4, 10, 2, 1];
const attackDurations = [140, 80, 60, 160];
const decoder = new TextDecoder();

// An asymmetric 2x2 map on Clareira's atlas, with a prop cropped from its potion sheet.
// It is selected alone in Tiled: both the terrain and the prop must travel as dependencies.
const mapEntries: ManifestEntry[] = [
  {
    assetId: "trail-potion", revisionId: PROP, family: "map", kind: "object", name: "Trail potion", dependencies: [],
    payload: {
      projection: "top_down", fileId: "potion-sheet", rect: [16, 0, 16, 16], logicalSize: [16, 16],
      footprintCells: [1, 1], supportPoint: [8, 15], collision: [], occlusionAboveY: null,
    },
  },
  {
    assetId: "lake-trail", revisionId: MAP, family: "map", kind: "tilemap", name: "Lake trail",
    dependencies: [{ revisionId: TILESET, role: "tileset" }, { revisionId: PROP, role: "object" }],
    payload: {
      projection: "top_down", size: [2, 2], cellSize: [32, 32], seed: 17,
      units: { cell: "cell", offset: "px", polygon: "px" },
      terrain: {
        mode: "corner", rule: "corner-v1", tilesetRevisionId: TILESET,
        vertices: [0, 0, 1, 0, 1, 0, 0, 0, 0], walkable: [true, false], overrides: [],
        resolved: ["grass-water-4", "grass-water-10", "grass-water-2", "grass-water-1"],
      },
      objects: [{ objectId: "supply", objectRevisionId: PROP, pieceKey: null, cell: [0, 0], offsetPx: [2, -3] }],
      collisions: [{ collisionId: "rock", kind: "cells", cells: [[0, 1]] }],
      regions: [{ regionId: "start", name: "Start", kind: "spawn", rect: [0, 0, 1, 1] }],
      entrances: [{ entranceId: "east", name: "East", cell: [1, 1], side: "E" }], passages: [],
    },
  },
];

let studio: TestStudio;
beforeEach(() => { studio = makeTestStudio(); });
afterEach(() => { studio?.cleanup(); });

async function seedClareira(withMap = false) {
  const project = createProject(studio.db, studio.clock, { name: "Clareira" });
  const { manifest, packageFiles } = buildClareira();
  const source = packageFiles.filter((file) => file.path !== "manifest.json");
  const entries = withMap ? [...manifest.entries, ...mapEntries] : manifest.entries;
  const seed = readZip(writeZip([
    ...source.map((file) => ({ ...file, compress: false })),
    { path: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify({ ...manifest, entries })), compress: true },
  ]));
  const { revisionMap } = await importPortablePackage(studio, project.id, seed, { approve: true });
  return { projectId: project.id, revisions: revisionMap, seed };
}

function onePath(zip: ZipArchive, suffix: string) {
  const paths = zip.paths.filter((path) => path.endsWith(suffix));
  expect(paths, `One ${suffix} in the downloaded ZIP`).toHaveLength(1);
  return paths[0]!;
}

async function download(requested: ExportView) {
  expect(requested.state).toBe("pending");
  expect(studio.queue.get(requested.jobId!)?.state).toBe("queued");
  expect(await studio.runner().runOnce()).toBe(true);
  const ready = getExport(studio.db, requested.projectId, requested.id);
  expect(ready.state, JSON.stringify(ready.error)).toBe("ready");
  expect(studio.queue.get(requested.jobId!)?.state).toBe("succeeded");
  // This is the promoted file used by GET /exports/:id/download, not staging output.
  const bytes = await readFile(exportFilePath(studio.config.paths.exports, ready));
  expect(ready.bytes).toBe(bytes.length);
  expect(ready.zipSha256).toBe(sha256Hex(bytes));
  const zip = readZip(bytes);
  const text = (path: string) => decoder.decode(zip.read(path));
  const manifest = Manifest.parse(JSON.parse(text("manifest.json")));
  expect(manifest.profile).toBe("portable-v1");
  expect(ready.report).toMatchObject({
    profile: requested.profile, profileVersion: 1, selected: requested.revisionIds,
    entries: manifest.entries.length, files: zip.paths.length - 1,
  });
  return { ready, bytes, zip, text, manifest };
}

async function runExport(projectId: string, profile: Exclude<ExportProfileId, "portable-v1">, revisionIds: string[]) {
  const requested = requestExport(studio, projectId, { profile, revisionIds });
  expect(requested.created).toBe(true);
  return download(requested.export);
}

async function reimport({ zip, manifest }: { zip: ZipArchive; manifest: Manifest }) {
  const project = createProject(studio.db, studio.clock, { name: "Reopened native ZIP" });
  const { revisionMap } = await importPortablePackage(studio, project.id, zip, { approve: true });
  expect(Object.keys(revisionMap).sort()).toEqual(manifest.entries.map((entry) => entry.revisionId).sort());
  const files = new Map(manifest.files.map((file) => [file.fileId, file.sha256]));
  for (const entry of manifest.entries) {
    const revision = getRevision(studio.db, project.id, revisionMap[entry.revisionId]!);
    expect(revision.id).not.toBe(entry.revisionId);
    expect(revision.status).toBe("approved");
    expect(revision.files.map(({ fileKey, sha256 }) => [fileKey, sha256]).sort()).toEqual(
      [...new Set(entryRefs(entry).files.map(({ fileId }) => fileId))].map((id) => [id, files.get(id)]).sort(),
    );
    if (entry.family === "map" && entry.kind === "tilemap") {
      const map = TilemapPayload.parse(revision.payload);
      expect(map.terrain.tilesetRevisionId).toBe(revisionMap[entry.payload.terrain.tilesetRevisionId]);
      expect(map.objects).toEqual(entry.payload.objects.map((object) => ({
        ...object, objectRevisionId: revisionMap[object.objectRevisionId!],
      })));
    }
    if (entry.family === "character" && entry.kind === "clip") {
      const clip = ClipPayload.parse(revision.payload);
      expect(clip.frames.map(({ durationMs }) => durationMs)).toEqual(attackDurations);
      expect(clip.events).toMatchObject([{
        eventId: "impact", frameId: "contact",
        vfx: { revisionId: revisionMap[entry.payload.events[0]!.vfx!.revisionId] },
        audio: { revisionId: revisionMap[entry.payload.events[0]!.audio!.revisionId] },
      }]);
    }
  }
}

function inspectPython(source: string, bytes: Uint8Array, ...args: string[]) {
  return JSON.parse(execFileSync(studio.config.python, ["-I", "-c", source, ...args], {
    input: bytes, encoding: "utf8", timeout: 5_000,
  }));
}

it("downloads GIFs with authored timing and thresholded alpha, deduplicates requests, and rebuilds identical bytes", async () => {
  const { projectId, revisions } = await seedClareira();
  const revisionIds = [revisions[CLIP]!, revisions[SPARK]!];
  const profile = "gif-v1";
  const first = await runExport(projectId, profile, revisionIds);
  const { zip } = first;
  expect(zip.paths.filter((path) => path.endsWith(".gif"))).toHaveLength(2);
  const spark = inspectPython(`
import io, json, sys
from PIL import Image, ImageSequence
with Image.open(io.BytesIO(sys.stdin.buffer.read())) as gif:
    frames = []
    for frame in ImageSequence.Iterator(gif):
        rgba = frame.convert('RGBA')
        frames.append([frame.info['duration'], rgba.getpixel((3, 3))[3], rgba.getpixel((3, 2)), rgba.getpixel((4, 3))[3]])
    print(json.dumps(dict(size=gif.size, loop=gif.info.get('loop'), frames=frames)))
`, zip.read(onePath(zip, "-burst.gif")));
  expect(spark).toEqual({ size: [8, 8], loop: null, frames: [
    [80, 255, C.clear, 0], [120, 0, C.spark, 0],
  ] });
  const attack = inspectPython(`
import io, json, sys
from PIL import Image, ImageSequence
with Image.open(io.BytesIO(sys.stdin.buffer.read())) as gif:
    print(json.dumps(dict(size=gif.size, durations=[f.info['duration'] for f in ImageSequence.Iterator(gif)])))
`, zip.read(onePath(zip, "-attack_s.gif")));
  expect(attack).toEqual({ size: [64, 64], durations: attackDurations });
  await reimport(first);

  const reordered = [revisionIds[1]!, revisionIds[0]!, revisionIds[1]!];
  const same = requestExport(studio, projectId, { profile, revisionIds: reordered });
  expect(same).toMatchObject({ created: false, export: { id: first.ready.id, jobId: first.ready.jobId, state: "ready" } });
  expect(await studio.runner().runOnce()).toBe(false);

  studio.clock.advance(60_000);
  const rebuild = requestExport(studio, projectId, { profile, revisionIds: reordered }, "rebuild-native");
  expect(rebuild.created).toBe(true);
  expect(rebuild.export.jobId).not.toBe(first.ready.jobId);
  expect(() => requestExport(studio, projectId, { profile: "aseprite-v1", revisionIds }, "rebuild-native"))
    .toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
  const rebuilt = await download(rebuild.export);
  expect(rebuilt.bytes.equals(first.bytes)).toBe(true);

  const differentProfile = await runExport(projectId, "aseprite-v1", revisionIds);
  expect(differentProfile.ready.id).not.toBe(first.ready.id);
  expect(differentProfile.zip.paths.filter((path) => path.endsWith(".aseprite"))).toHaveLength(2);
});

// Read the frame/chunk directory from the ASE binary and check that it consumes the whole file.
function readAseprite(zip: ZipArchive, suffix: string) {
  const file = Buffer.from(zip.read(onePath(zip, suffix)));
  expect(file.readUInt32LE(0)).toBe(file.length);
  expect(file.readUInt16LE(4)).toBe(0xa5e0);
  let cursor = 128;
  const frames = Array.from({ length: file.readUInt16LE(6) }, () => {
    const end = cursor + file.readUInt32LE(cursor);
    expect(file.readUInt16LE(cursor + 4)).toBe(0xf1fa);
    const count = file.readUInt16LE(cursor + 6);
    const duration = file.readUInt16LE(cursor + 8);
    cursor += 16;
    const chunks = Array.from({ length: count }, () => {
      const start = cursor;
      cursor += file.readUInt32LE(cursor);
      expect(cursor - start).toBeGreaterThanOrEqual(6);
      return { type: file.readUInt16LE(start + 4), data: file.subarray(start + 6, cursor) };
    });
    expect(cursor).toBe(end);
    return { duration, chunks };
  });
  expect(cursor).toBe(file.length);
  return { size: [file.readUInt16LE(8), file.readUInt16LE(10)], depth: file.readUInt16LE(12), frames };
}

it("downloads editable Aseprite cels without converting the clip's portable-only dependencies", async () => {
  const { projectId, revisions } = await seedClareira();
  const bundle = await runExport(projectId, "aseprite-v1", [revisions[CLIP]!, revisions[POTION]!]);
  expect(bundle.zip.paths.filter((path) => path.endsWith(".aseprite"))).toHaveLength(3);
  expect(bundle.ready.report?.addedDependencies).toContain(revisions[SPARK]);
  const attack = readAseprite(bundle.zip, "-attack_s.aseprite");
  expect(attack).toMatchObject({ size: [64, 64], depth: 32 });
  expect(attack.frames.map(({ duration }) => duration)).toEqual(attackDurations);
  const layer = attack.frames[0]!.chunks.find(({ type }) => type === 0x2004)!.data;
  expect(layer.toString("utf8", 18)).toBe("body");
  const world = readAseprite(bundle.zip, "-world_default.aseprite");
  expect(world).toMatchObject({ size: [16, 16], depth: 32, frames: [{ duration: 100 }] });
  const cel = world.frames[0]!.chunks.find(({ type }) => type === 0x2005)!.data;
  expect([cel.readUInt16LE(0), cel.readInt16LE(2), cel.readInt16LE(4), cel.readUInt16LE(7)]).toEqual([0, 0, 0, 2]);
  const pixels = inflateSync(cel.subarray(20));
  expect(pixels.length).toBe(16 * 16 * 4);
  const pixel = (x: number, y: number) => [...pixels.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4)];
  expect(pixel(3, 14)).toEqual(C.shadow);
  expect(pixel(6, 1)).toEqual(C.clear); // The icon (left half of the sheet) is not in this cel.
  await reimport(bundle);
});

it("downloads Tiled maps whose native GIDs and relative images resolve through both formats", async () => {
  const { projectId, revisions, seed } = await seedClareira(true);
  const bundle = await runExport(projectId, "tiled-v1", [revisions[MAP]!]);
  const { bytes, zip, text } = bundle;
  expect(bundle.ready.report?.addedDependencies.toSorted()).toEqual([revisions[TILESET]!, revisions[PROP]!].sort());
  const tmj = onePath(zip, ".tmj");
  const map = JSON.parse(text(tmj));
  expect(map).toMatchObject({ orientation: "orthogonal", width: 2, height: 2, tilewidth: 32, tileheight: 32 });
  expect(map.layers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Terrain", data: [5, 11, 3, 2] }),
    expect.objectContaining({ name: "Objects", objects: [expect.objectContaining({ gid: 17, x: 10, y: -2, width: 16, height: 16 })] }),
    expect.objectContaining({ name: "Collisions", objects: [expect.objectContaining({ x: 0, y: 32, width: 32, height: 32 })] }),
  ]));
  const [terrain, prop] = map.tilesets.map(({ source, firstgid }: { source: string; firstgid: number }) => {
    const path = posix.join(posix.dirname(tmj), source);
    return { path, firstgid, data: JSON.parse(text(path)) };
  });
  expect(terrain).toMatchObject({ firstgid: 1, data: { tilecount: 16, columns: 4, imagewidth: 128, imageheight: 128 } });
  expect(prop).toMatchObject({ firstgid: 17, data: { tiles: [{ id: 0, x: 16, y: 0, width: 16, height: 16 }] } });
  const terrainImage = posix.join(posix.dirname(terrain.path), terrain.data.image);
  const propImage = posix.join(posix.dirname(prop.path), prop.data.tiles[0].image);
  expect(Buffer.from(zip.read(terrainImage)).equals(seed.read("tiles/grass-water.png"))).toBe(true);
  expect(Buffer.from(zip.read(propImage)).equals(seed.read("items/potion.png"))).toBe(true);
  const xml = inspectPython(`
import io, json, posixpath, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    tmx = sys.argv[1]
    root = ET.fromstring(archive.read(tmx))
    references = []
    for reference in root.findall('tileset'):
        tsx = posixpath.join(posixpath.dirname(tmx), reference.attrib['source'])
        image = ET.fromstring(archive.read(tsx)).find('.//image').attrib['source']
        references.append([int(reference.attrib['firstgid']), posixpath.normpath(posixpath.join(posixpath.dirname(tsx), image))])
    print(json.dumps(dict(gids=[int(gid) for gid in root.find('./layer/data').text.split(',')], references=references)))
`, bytes, onePath(zip, ".tmx"));
  expect(xml).toEqual({ gids: [5, 11, 3, 2], references: [[1, terrainImage], [17, propImage]] });
  await reimport(bundle);
});

it("downloads a Godot project with valid resource references, native cells, and the attack timeline", async () => {
  const { projectId, revisions, seed } = await seedClareira(true);
  const bundle = await runExport(projectId, "godot-v1", [revisions[MAP]!, revisions[CLIP]!]);
  const { zip, text } = bundle;
  const map = text(onePath(zip, `-${revisions[MAP]}.tscn`));
  const data = Buffer.from(map.match(/tile_map_data = PackedByteArray\("([^"]+)"\)/)![1]!, "base64");
  expect(data.readUInt16LE(0)).toBe(0);
  expect(data.length).toBe(2 + 4 * 12);
  const cells = Array.from({ length: 4 }, (_, i) => Array.from({ length: 6 }, (_, j) => data.readUInt16LE(2 + i * 12 + j * 2)));
  expect(cells).toEqual([[0, 0, 0, 0, 1, 0], [1, 0, 0, 2, 2, 0], [0, 1, 0, 2, 0, 0], [1, 1, 0, 1, 0, 0]]);
  const tiles = text(`godot/${map.match(/type="TileSet" path="res:\/\/([^"]+)"/)![1]}`);
  const atlasPath = tiles.match(/type="Texture2D" path="res:\/\/([^"]+)"/)![1];
  expect(Buffer.from(zip.read(`godot/${atlasPath}`)).equals(seed.read("tiles/grass-water.png"))).toBe(true);
  expect([...tiles.matchAll(/^(\d+:\d+)\/0\/custom_data_0 = "(grass-water-\d+)"$/gm)].map((match) => match.slice(1)))
    .toContainEqual(["2:2", "grass-water-10"]);
  const attack = text(onePath(zip, `-${revisions[CLIP]}.tscn`));
  expect(Number(attack.match(/^length = ([\d.]+)$/m)![1])).toBe(0.44);
  const switches = [...attack.matchAll(/^tracks\/\d+\/keys = \{"times": PackedFloat32Array\(([^)]+)\)/gm)]
    .map((match) => match[1]!.split(",").map(Number));
  expect(switches).toEqual([[0, 0.14], [0, 0.14, 0.22], [0, 0.22, 0.28], [0, 0.28]]);
  for (const path of zip.paths.filter((path) => /^godot\/.+\.(?:godot|tscn|tres)$/.test(path))) {
    for (const [, resource] of text(path).matchAll(/"res:\/\/([^"]+)"/g)) zip.read(`godot/${resource}`);
  }
  await reimport(bundle);
});

it("downloads a Unity importer descriptor linking the map and clip to actual atlas slices", async () => {
  const { projectId, revisions, seed } = await seedClareira(true);
  const revisionIds = [revisions[MAP]!, revisions[CLIP]!];
  const bundle = await runExport(projectId, "unity-v1", revisionIds);
  const { zip, text } = bundle;
  const path = onePath(zip, "/PixelStudio.job.json");
  const descriptor = JSON.parse(text(path));
  expect(descriptor).toMatchObject({ version: 1, project: "Clareira", pixelsPerUnit: 32, selected: revisionIds.toSorted() });
  const [map] = descriptor.maps;
  const [tileset] = descriptor.tilesets;
  const [prop] = descriptor.objects;
  expect(map).toMatchObject({
    revisionId: revisions[MAP], tileset: tileset.key, width: 2, height: 2, cellWidth: 32, cellHeight: 32,
    cells: [5, 11, 3, 2], blocked: [1, 2],
    objects: [{ id: "supply", objectKey: prop.key, x: 18, y: -13 }],
    regions: [{ id: "start", kind: "spawn", x: 16, y: -16 }],
  });
  expect(prop).toMatchObject({ revisionId: revisions[PROP], selected: false });
  expect(tileset.revisionId).toBe(revisions[TILESET]);
  expect(map.cells.map((id: number) => tileset.tiles[id - 1].id)).toEqual(masks.map((mask) => `grass-water-${mask}`));
  const [clip] = descriptor.clips;
  expect(clip).toMatchObject({ revisionId: revisions[CLIP], playback: "once", durationMs: 440 });
  expect(clip.frames.map(({ startMs, durationMs }: { startMs: number; durationMs: number }) => [startMs, durationMs]))
    .toEqual([[0, 140], [140, 80], [220, 60], [280, 160]]);
  const atlas = descriptor.textures.find(({ width, height }: { width: number; height: number }) => width === 256 && height === 64);
  expect(Buffer.from(zip.read(posix.join(posix.dirname(path), atlas.path))).equals(seed.read("sprites/warrior-attack-s.png"))).toBe(true);
  expect(clip.frames[2].layers).toMatchObject([{ part: "body", x: 0, y: 0 }]);
  expect(atlas.slices).toContainEqual(expect.objectContaining({
    id: clip.frames[2].layers[0].sprite, x: 128, y: 0, width: 64, height: 64, pivotX: 32, pivotY: 4,
  }));
  await reimport(bundle);

  const rebuilt = requestExport(studio, projectId, { profile: "unity-v1", revisionIds: [...revisionIds].reverse() }, "rebuild-unity");
  expect(rebuilt.created).toBe(true);
  expect((await download(rebuilt.export)).bytes.equals(bundle.bytes)).toBe(true);
});
