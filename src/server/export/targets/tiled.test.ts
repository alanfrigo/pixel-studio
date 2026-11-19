import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { Manifest, type ManifestEntry, type ManifestFile } from "@/contracts";
import { sha256Hex } from "@/domain/manifest/verify-files";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import type { PackageFile } from "../package";
import { tiledTarget } from "./tiled";

function raster(fileId: string, path: string, width: number, height: number): { spec: ManifestFile; file: PackageFile } {
  const bytes = encodePng(createImage(width, height));
  return { spec: { fileId, path, mime: "image/png", width, height, bytes: bytes.length, sha256: sha256Hex(bytes) }, file: { path, bytes, compress: false } };
}

async function bundle(manifest: Manifest, sourceFiles: PackageFile[], selected: string[]) {
  const generated = await tiledTarget.build({ manifest, sourceFiles, selected: new Set(selected), projectName: "Clareira", workDir: "", python: "", signal: new AbortController().signal, timeoutMs: 1_000 });
  const zip = readZip(writeZip([...sourceFiles, ...generated]));
  return { zip, text: (path: string) => new TextDecoder().decode(zip.read(path)) };
}

const terrainEntry = {
  family: "tileset", kind: "corner", assetId: "field", revisionId: "field-r1", name: "Field & lake", dependencies: [],
  payload: {
    projection: "three_quarter", cellSize: [4, 4], atlas: { fileId: "terrain", margin: 1, spacing: 1 },
    complete: false, diagonals: { mask5: "connected", mask10: "separate" },
    terrains: [{ terrainId: "grass", name: "Grass & <moss>", color: "#128800" }, { terrainId: "water", name: "Water", color: "#004488" }],
    tiles: [
      { tileKey: "still", rect: [1, 1, 4, 4], mask: 15, variant: 0, weight: 2, frames: [] },
      { tileKey: "ripple", rect: [6, 6, 4, 4], mask: 15, variant: 1, weight: 5, frames: [{ rect: [6, 6, 4, 4], durationMs: 43 }, { rect: [1, 6, 4, 4], durationMs: 217 }] },
    ],
  },
} satisfies ManifestEntry;

const propEntry = {
  family: "map", kind: "object", assetId: "tree", revisionId: "tree-r1", name: "Tree", dependencies: [],
  payload: {
    projection: "three_quarter", fileId: "tree", rect: [2, 3, 7, 12], logicalSize: [7, 12], supportPoint: [3, 11], footprintCells: [2, 1],
    collision: [[2, 9, 3, 2]], occlusionAboveY: 6,
    shadow: { fileId: "shadow", rect: [1, 1, 8, 4], offset: [-1, 9] },
  },
} satisfies ManifestEntry;

const mapEntry = {
  family: "map", kind: "tilemap", assetId: "pond", revisionId: "pond-r1", name: "Pond", dependencies: [{ revisionId: "field-r1", role: "tileset" }, { revisionId: "tree-r1", role: "object" }],
  payload: {
    projection: "three_quarter", size: [2, 1], cellSize: [5, 7], seed: 17, units: { cell: "cell", offset: "px", polygon: "px" },
    terrain: { mode: "corner", tilesetRevisionId: "field-r1", rule: "corner-v1", vertices: [1, 1, 0, 1, 1, 0], walkable: [true, false], overrides: [{ cell: [0, 0], tileKey: "ripple" }], resolved: ["ripple", null] },
    objects: [{ objectId: "tree-at-pond", objectRevisionId: "tree-r1", pieceKey: null, cell: [0, 0], offsetPx: [-1, 1], label: 'Oak "A"' }],
    collisions: [{ collisionId: "cells", kind: "cells", cells: [[1, 0]] }, { collisionId: "shore", kind: "polygon", points: [[3, 2], [4, 6], [-1, 6]] }],
    entrances: [{ entranceId: "door-west", name: "West gate", cell: [0, 0], side: "W" }],
    regions: [{ regionId: "start", name: "Start", kind: "spawn", rect: [1, 0, 1, 1] }], passages: [],
  },
} satisfies ManifestEntry;

describe("editable Tiled targets", () => {
  it("opens standalone grid tilesets using relative portable PNG references", async () => {
    const fixture = buildClareira();
    const { zip, text } = await bundle(fixture.manifest, fixture.packageFiles.map((f) => ({ ...f, compress: false })), ["grass-water-v1"]);
    const stem = "tiled/tileset-grama_agua";
    const tileset = JSON.parse(text(`${stem}.tsj`));
    expect(tileset).toMatchObject({ type: "tileset", tilewidth: 32, tileheight: 32, tilecount: 16, columns: 4, image: "../tiles/grass-water.png", imagewidth: 128, imageheight: 128 });
    expect(tileset.firstgid).toBeUndefined();
    expect(zip.read(posix.join("tiled", tileset.image))).toEqual(zip.read("tiles/grass-water.png"));
    expect(text(`${stem}.tsx`)).toContain('<image source="../tiles/grass-water.png" width="128" height="128"/>');
  });

  it("links equivalent TMX and TMJ layers to atlas IDs, Wang colors, and editable objects", async () => {
    const atlas = raster("terrain", "tiles/field.png", 10, 10);
    const tree = raster("tree", "maps/tree.png", 12, 16);
    const shadow = raster("shadow", "maps/shadow.png", 9, 6);
    const manifest = Manifest.parse({ schemaVersion: 1, profile: "portable-v1", projectId: "test", files: [atlas.spec, tree.spec, shadow.spec], entries: [terrainEntry, propEntry, mapEntry] });
    const { zip, text } = await bundle(manifest, [atlas.file, tree.file, shadow.file], [mapEntry.revisionId, propEntry.revisionId]);
    const map = JSON.parse(text("tiled/map-pond.tmj"));
    const tmx = text("tiled/map-pond.tmx");
    expect(map).toMatchObject({ type: "map", orientation: "orthogonal", width: 2, height: 1, tilewidth: 5, tileheight: 7, nextlayerid: 7, nextobjectid: 9 });
    expect(map.tilesets).toEqual([{ firstgid: 1, source: "tileset-field_lake.tsj" }, { firstgid: 5, source: "prop-tree.tsj" }]);
    expect(tmx).toContain('<tileset firstgid="1" source="tileset-field_lake.tsx"/>');
    expect(tmx).toContain('<tileset firstgid="5" source="prop-tree.tsx"/>');
    expect(tmx).toContain('<data encoding="csv">4,0</data>');
    expect(map.layers).toMatchObject([
      { name: "Terrain", data: [4, 0] },
      { name: "Objects", objects: [{ gid: 6, x: 0, y: 2.5 }, { gid: 5, name: 'Oak "A"', x: 1, y: -6.5, width: 7, height: 12 }] },
      { name: "Collisions", objects: [{ x: 5, y: 0, width: 5, height: 7 }, { x: 3, y: 2, polygon: [{ x: 0, y: 0 }, { x: 1, y: 4 }, { x: -4, y: 4 }] }] },
      { name: "Terrain Collision", objects: [{ x: 0, y: 0 }, { x: 5, y: 0 }] },
      { name: "Regions", objects: [{ type: "spawn", x: 5, y: 0, width: 5, height: 7 }] },
      { name: "Entrances", objects: [{ point: true, x: 2.5, y: 3.5, properties: expect.arrayContaining([{ name: "side", type: "string", value: "W" }]) }] },
    ]);
    expect(tmx).toContain('name="Oak &quot;A&quot;"');
    expect(tmx).toContain('<polygon points="0,0 1,4 -4,4"/>');
    const native = JSON.parse(text(posix.join("tiled", map.tilesets[0].source)));
    expect(native).toMatchObject({ tilecount: 4, columns: 2, tilerendersize: "grid", margin: 1, spacing: 1 });
    expect(native.tiles[1]).toMatchObject({ id: 3, probability: 5, animation: [{ tileid: 3, duration: 43 }, { tileid: 2, duration: 217 }] });
    expect(native.wangsets[0]).toMatchObject({ type: "corner", colors: [{ name: "Grass & <moss>", color: "#128800" }, { name: "Water", color: "#004488", tile: 0 }], wangtiles: [{ tileid: 0, wangid: [0, 2, 0, 2, 0, 2, 0, 2] }, { tileid: 3, wangid: [0, 2, 0, 2, 0, 2, 0, 2] }] });
    expect(text("tiled/tileset-field_lake.tsx")).toContain('name="Grass &amp; &lt;moss&gt;"');
    expect(text("tiled/tileset-field_lake.tsx")).toContain('<frame tileid="2" duration="217"/>');
    const prop = JSON.parse(text(posix.join("tiled", map.tilesets[1].source)));
    expect(prop).toMatchObject({ columns: 0, objectalignment: "topleft", tilecount: 2 });
    expect(prop.tiles[0]).toMatchObject({ id: 0, image: "../maps/tree.png", x: 2, y: 3, width: 7, height: 12, objectgroup: { objects: [{ x: 2, y: 9, width: 3, height: 2 }] } });
    expect(zip.read(posix.join("tiled", prop.tiles[0].image))).toEqual(tree.file.bytes);
  });

  it("preserves side resolutions and variants even when the atlas isn't a uniform grid", async () => {
    const sides = {
      family: "tileset", kind: "sidescroller", assetId: "sides", revisionId: "sides-r1", dependencies: [],
      payload: {
        projection: "side", cellSize: [4, 4], atlas: { fileId: "side", margin: 0, spacing: 0 },
        platformMaterial: "Stone", surfaceMaterial: "Grass", walkableLineY: 1,
        requiredConfigurations: ["surface_middle"], complete: true,
        tiles: [
          { tileKey: "alt", configuration: "surface_middle", variant: 1, weight: 2, rect: [0, 0, 4, 4], frames: [] },
          { tileKey: "base", configuration: "surface_middle", variant: 0, weight: 1, rect: [0, 0, 4, 4], frames: [{ rect: [5, 1, 4, 4], durationMs: 51 }] },
        ],
      },
    } satisfies ManifestEntry;
    const platform = {
      ...mapEntry, name: "Platform", dependencies: [{ revisionId: "sides-r1", role: "tileset" }],
      payload: { ...mapEntry.payload, projection: "side", objects: [], terrain: { mode: "side", tilesetRevisionId: "sides-r1", rule: "side-v1", solid: [1, 1], resolved: ["surface_middle", "surface_right"] } },
    } satisfies ManifestEntry;
    const image = raster("side", "tiles/side.png", 9, 5);
    const manifest = Manifest.parse({ schemaVersion: 1, profile: "portable-v1", projectId: "test", files: [image.spec], entries: [sides, platform] });
    const { text } = await bundle(manifest, [image.file], [platform.revisionId]);
    const map = JSON.parse(text("tiled/map-platform.tmj"));
    expect(map.layers[0].data).toEqual([2, 0]);
    const variants = JSON.parse(text(posix.join("tiled", map.tilesets[0].source)));
    expect(variants).toMatchObject({ columns: 0, tilecount: 3 });
    expect(variants.tiles).toMatchObject([
      { id: 0, image: "../tiles/side.png", x: 0, y: 0, width: 4, height: 4, probability: 2 },
      { id: 1, animation: [{ tileid: 2, duration: 51 }] },
      { id: 2, image: "../tiles/side.png", x: 5, y: 1, width: 4, height: 4 },
    ]);
    expect(text("tiled/tileset-sides_r1.tsx")).toContain('<tile id="2" x="5" y="1" width="4" height="4">');
  });

  it("rejects isometric geometry during preflight instead of flattening it", () => {
    const iso = {
      ...mapEntry,
      payload: { ...mapEntry.payload, projection: "isometric", objects: [], terrain: { mode: "isometric", rule: "iso-v1", tilesetRevisionId: "iso-r1", cells: [{ pieceKey: "block", elevation: 2 }, { pieceKey: null, elevation: 0 }] } },
    } satisfies ManifestEntry;
    expect(tiledTarget.problem(iso)).toMatchObject({ en: expect.stringContaining("isometric"), "pt-BR": expect.stringContaining("isométrica") });
    expect(tiledTarget.problem({ ...propEntry, payload: { ...propEntry.payload, projection: "isometric" } })).not.toBeNull();
    expect(tiledTarget.problem({ ...mapEntry, payload: { ...mapEntry.payload, projection: "top_down" } })).toBeNull();
  });
});
