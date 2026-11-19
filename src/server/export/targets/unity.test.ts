import { describe, expect, it } from "vitest";
import type { Manifest, ManifestEntry } from "@/contracts";
import { validateManifest } from "@/domain/manifest/validate";
import { sha256Hex } from "@/domain/manifest/verify-files";
import { resolveSideMap } from "@/domain/world/side";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, setPixel } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import type { PackageFile } from "../package";
import { unityTarget } from "./unity";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function openBundle(manifest: Manifest, sources: PackageFile[], selected: string[]) {
  expect(validateManifest(manifest).issues).toEqual([]);
  const packageFiles = [
    { path: "manifest.json", bytes: encoder.encode(JSON.stringify(manifest)), compress: true }, ...sources,
  ];
  const target = await unityTarget.build({
    manifest, sourceFiles: packageFiles, selected: new Set(selected), projectName: "../../Clareira",
    workDir: "", python: "", signal: new AbortController().signal, timeoutMs: 1000,
  });
  const archive = readZip(writeZip([...packageFiles, ...target]));
  const job = archive.paths.find((p) => /\/PixelStudio\.job\.json$/.test(p))!;
  expect(job).toMatch(/^unity\/Assets\/PixelStudio\/Bundles\/job-[a-f0-9]{24}\/PixelStudio\.job\.json$/);
  expect(archive.read("manifest.json")).toEqual(packageFiles[0]!.bytes);
  expect(decoder.decode(archive.read("unity/README.txt"))).toContain(job.slice("unity/".length));
  return { archive, descriptor: JSON.parse(decoder.decode(archive.read(job))), directory: job.split("/").slice(0, -1).join("/") };
}

const image = createImage(8, 8);
setPixel(image, 1, 2, [75, 10, 220, 127]);
const alphaPng = { path: "sprites/test-alpha.png", bytes: encodePng(image), compress: false } satisfies PackageFile;
const alphaFile = {
  fileId: "partial:alpha", path: alphaPng.path, bytes: alphaPng.bytes.length, sha256: sha256Hex(alphaPng.bytes),
  mime: "image/png", width: image.width, height: image.height,
} satisfies Manifest["files"][number];

const sideTileset: Extract<ManifestEntry, { family: "tileset"; kind: "sidescroller" }> = {
  revisionId: "side:1", assetId: "side", family: "tileset", kind: "sidescroller", name: "../Plataforma", dependencies: [],
  payload: {
    projection: "side", cellSize: [3, 5], atlas: { fileId: alphaFile.fileId, margin: 0, spacing: 0 },
    platformMaterial: "stone", surfaceMaterial: "moss", walkableLineY: 1, requiredConfigurations: ["surface_middle"], complete: true,
    tiles: [
      { tileKey: "surface-variant", configuration: "surface_middle", variant: 9, weight: 1, rect: [0, 0, 3, 5], frames: [] },
      {
        tileKey: "surface", configuration: "surface_middle", variant: 0, weight: 1, rect: [3, 0, 3, 5],
        frames: [{ rect: [3, 0, 3, 5], durationMs: 80 }, { rect: [0, 0, 3, 5], durationMs: 120 }],
      },
    ],
  },
};

const prop: Extract<ManifestEntry, { family: "map"; kind: "object" }> = {
  revisionId: "prop:1", assetId: "prop", family: "map", kind: "object", name: "Banner", dependencies: [],
  payload: {
    projection: "side", fileId: alphaFile.fileId, rect: [0, 0, 5, 7], logicalSize: [5, 7], supportPoint: [2, 6],
    footprintCells: [1, 1], collision: [[1, 4, 2, 3]], occlusionAboveY: 3,
  },
};

describe("Unity 6 importer bundle", () => {
  it("preserves imported names, asymmetric ping-pong durations and unflattened alpha layers", async () => {
    const fixture = buildClareira();
    const clipId = "warrior-attack-osh-s-v1";
    const entries = fixture.manifest.entries.map((entry): ManifestEntry => {
      if (entry.revisionId !== clipId || entry.family !== "character" || entry.kind !== "clip") return entry;
      return {
        ...entry,
        payload: {
          ...entry.payload, playback: "ping_pong",
          frames: entry.payload.frames.map((frame, i) => i !== 1 ? frame : {
            ...frame, rootOffset: [2, -4],
            layers: [...frame.layers, { partId: "torso", fileId: alphaFile.fileId, rect: [1, 2, 3, 4], offset: [7, 9] }],
          }),
        },
      };
    });
    const manifest = { ...fixture.manifest, entries, files: [...fixture.manifest.files, alphaFile] };
    const { archive, descriptor, directory } = await openBundle(manifest, [
      ...fixture.packageFiles.filter((file) => file.path !== "manifest.json").map((file) => ({ ...file, compress: false })), alphaPng,
    ], ["warrior-base-v1", clipId, "potion-v1", "grass-water-v1"]);

    expect(descriptor.sprites).toMatchObject([
      { revisionId: "potion-v1", variants: [{ name: "icon-default" }, { name: "world-default" }] },
      { revisionId: "warrior-base-v1", variants: [{ name: "S" }] },
    ]);
    expect(descriptor.tilesets[0].tiles).toHaveLength(16);
    expect(descriptor.textures).toHaveLength(5); // Rig, overlay, event VFX and audio stay portable-only.
    const [clip] = descriptor.clips;
    expect(clip).toMatchObject({ revisionId: clipId, playback: "ping_pong", durationMs: 580 });
    expect(clip.frames.map((f: { startMs: number; durationMs: number }) => [f.startMs, f.durationMs])).toEqual([
      [0, 140], [140, 80], [220, 60], [280, 160], [440, 60], [500, 80],
    ]);
    expect(clip.frames[1]).toMatchObject({ moveX: 2, moveY: 4, layers: [{ part: "body" }, { part: "torso", x: -22, y: 47 }] });
    expect(clip.frames[2].layers).toHaveLength(1);
    expect(clip.frames[5].layers).toEqual(clip.frames[1].layers);
    const alphaTexture = descriptor.textures.find((texture: { width: number; height: number }) => texture.width === 8 && texture.height === 8);
    expect(alphaTexture.slices).toMatchObject([{ id: clip.frames[1].layers[1].sprite, x: 1, y: 2, width: 3, height: 4, pivotX: 3, pivotY: 0 }]);
    expect(archive.read(`${directory}/${alphaTexture.path}`)).toEqual(alphaPng.bytes);
    expect(archive.paths).toContain("unity/Assets/PixelStudio/Editor/PixelStudioImporter.cs");
  });

  it("carries an orthogonal map's dependency tile choices, colliders and spawn markers into its job", async () => {
    const size = [1, 2] satisfies [number, number];
    const solid = [0, 1] satisfies (0 | 1)[];
    const level: Extract<ManifestEntry, { family: "map"; kind: "tilemap" }> = {
      revisionId: "level-v1", assetId: "level", family: "map", kind: "tilemap", name: "Übung",
      dependencies: [{ revisionId: sideTileset.revisionId, role: "tileset" }, { revisionId: prop.revisionId, role: "object" }],
      payload: {
        size, projection: "side", cellSize: sideTileset.payload.cellSize, seed: 1, units: { cell: "cell", offset: "px", polygon: "px" },
        terrain: { mode: "side", rule: "side-v1", tilesetRevisionId: sideTileset.revisionId, solid, resolved: resolveSideMap(solid, size, sideTileset.payload).resolved },
        objects: [{ objectId: "p", objectRevisionId: prop.revisionId, pieceKey: null, cell: [0, 1], offsetPx: [1, -1] }],
        collisions: [{ collisionId: "wall", kind: "cells", cells: [[0, 0]] }, { collisionId: "floor", kind: "polygon", points: [[0, 1], [3, 1], [3, 3]] }],
        regions: [{ regionId: "start", name: "Spawn", kind: "spawn", rect: [0, 0, 1, 1] }],
        entrances: [{ entranceId: "east", name: "Exit", cell: [0, 1], side: "E" }], passages: [],
      },
    };
    const manifest: Manifest = { schemaVersion: 1, profile: "portable-v1", projectId: "world", entries: [sideTileset, prop, level], files: [alphaFile] };
    const { archive, descriptor } = await openBundle(manifest, [alphaPng], [level.revisionId, prop.revisionId]);
    expect(descriptor.maps).toMatchObject([{
      revisionId: level.revisionId, width: 1, height: 2, cellWidth: 3, cellHeight: 5,
      cells: [0, 2], blocked: [0, 1], tileset: descriptor.tilesets[0].key,
      polygons: [{ id: "floor", points: [{ x: 0, y: -1 }, { x: 3, y: -1 }, { x: 3, y: -3 }] }],
      regions: [{ kind: "spawn", id: "start", x: 1.5, y: -2.5, width: 3, height: 5 }],
      entrances: [{ id: "east", side: "E", x: 1.5, y: -7.5 }],
      objects: [{ id: "p", objectKey: descriptor.objects[0].key, x: 2.5, y: -6.5 }],
    }]);
    expect(descriptor.objects).toMatchObject([{
      selected: true, top: { x: 0, y: 3 }, bottom: { x: 0, y: 0 }, collision: [{ x: 0, y: 0.5, width: 2, height: 3 }],
    }]);
    expect(descriptor.tilesets[0].tiles[1].frames.map((f: { durationMs: number }) => f.durationMs)).toEqual([80, 120]);
    expect(descriptor.textures[0].slices).toContainEqual(expect.objectContaining({ x: 3, y: 3, width: 3, height: 5, pivotX: 1.5, pivotY: 2.5 }));
    expect(archive.paths).toContain("unity/Assets/PixelStudio/Runtime/PixelStudioTimedTile.cs");
  });

  it("rejects more timing subdivisions than the Unity player supports instead of rounding durations", () => {
    const tile = sideTileset.payload.tiles[1]!;
    expect(unityTarget.problem({
      ...sideTileset,
      payload: { ...sideTileset.payload, tiles: [{ ...tile, frames: [{ rect: tile.rect, durationMs: 59999 }, { rect: tile.rect, durationMs: 60000 }] }] },
    })).toEqual(expect.objectContaining({ en: expect.stringContaining("preserve its timings"), "pt-BR": expect.stringContaining("durações") }));
  });
});
