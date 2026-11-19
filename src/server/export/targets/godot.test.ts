import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { ManifestEntry } from "@/contracts";
import { validateManifest } from "@/domain/manifest/validate";
import { emptyCornerMap } from "@/domain/world/map";
import { buildClareira } from "@/fixtures/clareira";
import type { TargetInput } from "../target";
import { godotTarget } from "./godot";

function targetInput(workDir: string, includeSide: boolean): TargetInput {
  const { manifest, packageFiles } = buildClareira();
  const base = manifest.entries.find((e) => e.family === "character" && e.kind === "base")!;
  const corner = manifest.entries.find((e) => e.family === "tileset" && e.kind === "corner")!;
  const clip: ManifestEntry = {
    assetId: "layered", revisionId: "layered-v1", family: "character", kind: "clip", dependencies: [],
    payload: {
      rigRevisionId: null, motionRevisionId: null, action: "play", state: null, stance: null, direction: "S",
      logicalSize: [16, 16], pivot: [6, 13], margins: { left: 0, right: 0, top: 0, bottom: 0 }, playback: "ping_pong",
      frames: [30, 80, 120].map((durationMs, i) => ({
        frameId: `frame-${i}`, durationMs, sockets: [], rootOffset: [i, 0],
        layers: [
          { partId: "base", fileId: "potion-sheet", rect: [i, 0, 8, 8], offset: [3, 4] },
          ...(i === 1 ? [] : [{ partId: "front", fileId: "potion-sheet", rect: [16, i, 5, 5] as [number, number, number, number], offset: [8, i] as [number, number] }]),
        ],
      })),
      events: [],
    },
  };
  const map: ManifestEntry = {
    assetId: "field", revisionId: "field-v1", family: "map", kind: "tilemap",
    dependencies: [{ revisionId: corner.revisionId, role: "tileset" }],
    payload: {
      ...emptyCornerMap({ size: [3, 2], cellSize: [32, 32], tilesetRevisionId: corner.revisionId, tileset: corner.payload }),
      collisions: [{ collisionId: "wall", kind: "cells", cells: [[2, 0]] }, { collisionId: "ramp", kind: "polygon", points: [[0, 0], [32, 0], [32, 32]] }],
      regions: [{ regionId: "start", kind: "spawn", name: "Start", rect: [1, 1, 2, 1] }],
      entrances: [{ entranceId: "east", name: "East", side: "E", cell: [2, 1] }],
    },
  };
  const side: ManifestEntry = {
    assetId: "side", revisionId: "side-v1", family: "tileset", kind: "sidescroller", dependencies: [],
    payload: {
      projection: "side", cellSize: [16, 16], atlas: { fileId: "potion-sheet", margin: 0, spacing: 0 },
      surfaceMaterial: "Moss", platformMaterial: "Stone", walkableLineY: 4, complete: true, requiredConfigurations: ["surface_middle"],
      tiles: [{
        tileKey: "moss", configuration: "surface_middle", variant: 0, weight: 1, rect: [0, 0, 16, 16],
        frames: [{ rect: [16, 0, 16, 16], durationMs: 100 }, { rect: [0, 0, 16, 16], durationMs: 240 }, { rect: [4, 0, 16, 16], durationMs: 90 }],
      }],
    },
  };
  const sideMap: ManifestEntry = {
    assetId: "platform", revisionId: "platform-v1", family: "map", kind: "tilemap",
    dependencies: [{ revisionId: side.revisionId, role: "tileset" }],
    payload: {
      projection: "side", size: [1, 2], cellSize: [16, 16], seed: 1, units: { cell: "cell", offset: "px", polygon: "px" },
      terrain: { mode: "side", tilesetRevisionId: side.revisionId, rule: "side-v1", solid: [0, 1], resolved: [null, "surface_middle"] },
      objects: [], collisions: [], regions: [], entrances: [], passages: [],
    },
  };
  manifest.entries.push(clip, map, ...(includeSide ? [side, sideMap] : []));
  expect(validateManifest(manifest).ok).toBe(true);
  return {
    manifest, sourceFiles: packageFiles.map((f) => ({ ...f, compress: false })),
    selected: new Set([base.revisionId, "potion-v1", clip.revisionId, map.revisionId, ...(includeSide ? [sideMap.revisionId] : [])]),
    projectName: "Clareira", workDir, python: join(process.cwd(), "python", ".venv", "bin", "python"),
    timeoutMs: 10_000, signal: new AbortController().signal,
  };
}

test("builds a Godot project with pivoted representations and native map cells from an unselected tileset", async () => {
  const input = targetInput("", false);
  const files = await godotTarget.build(input);
  const paths = new Set(files.map((file) => file.path));
  expect(paths.size).toBe(files.length);
  expect(files.every((file) => file.path.startsWith("godot/"))).toBe(true);
  const decoder = new TextDecoder();
  const project = decoder.decode(files.find((file) => file.path === "godot/project.godot")!.bytes);
  expect(project).toContain('run/main_scene="res://gallery.tscn"');
  const map = decoder.decode(files.find((file) => file.path.endsWith("-field-v1.tscn"))!.bytes);
  const cells = Buffer.from(map.match(/tile_map_data = PackedByteArray\("([^"]+)"\)/)![1]!, "base64");
  expect(cells.length).toBe(2 + 6 * 12);
  expect(cells.readUInt16LE(2 + 5 * 12)).toBe(2);
  expect(cells.readUInt16LE(4 + 5 * 12)).toBe(1);
  expect(map).toContain('groups=["spawn_points"]');
  expect(map).toContain('type="CollisionPolygon2D"');
  const item = decoder.decode(files.find((file) => file.path.endsWith("-potion-v1-world-default.tscn"))!.bytes);
  expect(item).toContain("position = Vector2(-8, -15)");
  expect(item).toContain("texture_filter = 1");
  for (const file of files.filter((f) => f.compress)) {
    const text = decoder.decode(file.bytes);
    for (const [, path] of text.matchAll(/res:\/\/([^"]+)/g)) expect(paths.has(`godot/${path}`)).toBe(true);
  }
});

// Optional native consumer check: PIXEL_STUDIO_TEST_GODOT=/path/to/godot
// npm test -- src/server/export/targets/godot.test.ts
const godot = process.env.PIXEL_STUDIO_TEST_GODOT;
test.skipIf(!godot)("opens the gallery in Godot and samples animation frames, tile data, and physics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "godot-export-"));
  try {
    const input = targetInput(join(cwd, "work"), true);
    const files = await godotTarget.build(input);
    await Promise.all(files.map(async (file) => {
      const path = join(cwd, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes);
    }));
    const project = join(cwd, "godot");
    const probe = `extends SceneTree

func _initialize() -> void:
    call_deferred("check_gallery")

func check_gallery() -> void:
    var gallery = load("res://gallery.tscn").instantiate()
    root.add_child(gallery)
    var clip: Node2D
    var field: Node2D
    var platform: Node2D
    for child in gallery.get_node("Assets").get_children():
        match child.get_meta("revision_id", "-"):
            "layered-v1": clip = child
            "field-v1": field = child
            "platform-v1": platform = child
    assert(is_instance_valid(clip) and is_instance_valid(field) and is_instance_valid(platform))
    var animation: AnimationPlayer = clip.get_node("AnimationPlayer")
    assert(is_equal_approx(animation.current_animation_length, 0.31))
    animation.pause()
    for sample in [[0.01, 1], [0.05, 2], [0.15, 3], [0.27, 2]]:
        animation.seek(sample[0], true)
        for i in range(1, 4):
            assert(clip.get_node("Frame_%d" % i).visible == (i == sample[1]))
    assert(clip.get_node("Frame_1/Layer_2_front").texture.region == Rect2(16, 0, 5, 5))
    assert(clip.get_node("Frame_3/Layer_2_front").texture.region == Rect2(16, 2, 5, 5))
    assert(clip.get_node("Frame_1/Layer_1_base").position == Vector2(-3, -9))
    var floor: TileMapLayer = field.get_node("Terrain")
    assert(floor.get_used_cells().size() == 6)
    assert(floor.get_cell_tile_data(Vector2i(2, 1)).get_custom_data("tile_key") == "grass-water-0")
    assert(field.get_node("Regions/Region_1_start/Spawn").is_in_group("spawn_points"))
    assert(field.get_node("Collisions/Collision_1_wall/Cell_1").position == Vector2(80, 16))
    assert(field.get_node("Entrances/Entrance_1_east").get_meta("side") == "E")
    var side: TileMapLayer = platform.get_node("Terrain")
    var cell = Vector2i(0, 1)
    var coords = side.get_cell_atlas_coords(cell)
    var tiles: TileSetAtlasSource = side.tile_set.get_source(side.get_cell_source_id(cell))
    assert(tiles.get_tile_animation_frames_count(coords) == 3)
    assert(is_equal_approx(tiles.get_tile_animation_frame_duration(coords, 1), 0.24))
    assert(platform.get_node("TerrainCollision/Span_1").shape.size == Vector2(16, 12))
    print("Godot gallery verified")
    quit()
`;
    await writeFile(join(project, "probe.gd"), probe);
    const run = promisify(execFile);
    const imported = await run(godot!, ["--headless", "--path", project, "--import"], { timeout: 12_000 });
    expect(imported.stderr).not.toContain("ERROR");
    const checked = await run(godot!, ["--headless", "--path", project, "--script", "res://probe.gd", "--quit-after", "25"], { timeout: 12_000 });
    expect(checked.stderr).not.toContain("ERROR");
    expect(checked.stdout).toContain("Godot gallery verified");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
