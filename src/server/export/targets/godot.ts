import type { ManifestEntry } from "@/contracts";
import type { Rect } from "@/contracts/common";
import { objectAnchor } from "@/domain/world/map";
import { tx } from "@/i18n/locales";
import { DomainFailure } from "../../errors";
import type { PackageFile } from "../package";
import type { ExportTarget, TargetInput } from "../target";
import { godotAtlasFits, godotAtlasPages } from "./godot-tiles";

type Point = readonly [number, number];
type Entry<F extends ManifestEntry["family"], K extends string> = Extract<ManifestEntry, { family: F; kind: K }>;
type TileSetEntry = Entry<"tileset", "corner" | "sidescroller">;
type ObjectEntry = Entry<"map", "object">;
type Preview = { path: string; label: string; bounds: Rect };
type Tile = { source: number; coords: Point };
type TileSet = { path: string; tiles: Map<string, Tile>; configurations: Map<string, string> };

const quote = (text: string) => JSON.stringify(text.replaceAll("\0", "\uFFFD"));
const vec = ([x, y]: Point) => `Vector2(${x}, ${y})`;
const veci = ([x, y]: Point) => `Vector2i(${x}, ${y})`;
const meta = (key: string, value: unknown) => `metadata/${key} = ${JSON.stringify(value)}`;
const nodeName = (id: string) => id.replace(/[^a-z0-9_-]/gi, "_");
const pointFilter = "texture_filter = 1";
const encoder = new TextEncoder();

// Godot text resources share external dependencies and list subresources in
// dependency order before writing the native scene tree or resource body.
class Document {
  private external = new Map<string, { type: string; ref: string }>();
  private internal: string[] = [];
  private textures = new Map<string, string>();
  private shapes = new Map<string, string>();
  readonly nodes: string[] = [];

  ext(type: string, path: string) {
    const existing = this.external.get(path);
    if (existing) return `ExtResource(${existing.ref})`;
    const ref = quote(`ext_${this.external.size + 1}`);
    this.external.set(path, { type, ref });
    return `ExtResource(${ref})`;
  }

  sub(type: string, properties: string[]) {
    const ref = quote(`${type}_${this.internal.length + 1}`);
    this.internal.push(`[sub_resource type=${quote(type)} id=${ref}]\n${properties.join("\n")}`);
    return `SubResource(${ref})`;
  }

  texture(path: string, rect: Rect) {
    const key = `${path}:${rect.join(",")}`;
    let ref = this.textures.get(key);
    if (!ref) {
      ref = this.sub("AtlasTexture", [`atlas = ${this.ext("Texture2D", path)}`, `region = Rect2(${rect.join(", ")})`, "filter_clip = true"]);
      this.textures.set(key, ref);
    }
    return ref;
  }

  node(name: string, type: string, parent: string | null, props: string[], groups?: string) {
    const where = parent === null ? "" : ` parent=${quote(parent)}`;
    this.nodes.push(`[node name=${quote(name)} type=${quote(type)}${where}${groups ? ` groups=[${quote(groups)}]` : ""}]\n${props.join("\n")}`);
  }

  instance(name: string, parent: string, path: string, props: string[]) {
    this.nodes.push(`[node name=${quote(name)} parent=${quote(parent)} instance=${this.ext("PackedScene", path)}]\n${props.join("\n")}`);
  }

  rectShape(name: string, parent: string, [x, y, w, h]: Rect) {
    const key = `${w}:${h}`;
    let ref = this.shapes.get(key);
    if (!ref) {
      ref = this.sub("RectangleShape2D", [`size = ${vec([w, h])}`]);
      this.shapes.set(key, ref);
    }
    this.node(name, "CollisionShape2D", parent, [`position = ${vec([x + w / 2, y + h / 2])}`, `shape = ${ref}`]);
  }

  serialize(type?: string, properties: string[] = []) {
    const steps = this.external.size + this.internal.length + 1;
    const header = type ? `gd_resource type=${quote(type)}` : "gd_scene";
    return [
      `[${header}${steps > 1 ? ` load_steps=${steps}` : ""} format=3]`,
      ...Array.from(this.external, ([path, { type, ref }]) => `[ext_resource type=${quote(type)} path=${quote(`res://${path}`)} id=${ref}]`),
      ...this.internal,
      ...(type ? [`[resource]\n${properties.join("\n")}`] : this.nodes),
    ].join("\n\n") + "\n";
  }
}

// TileMapLayer format 0 (Godot 4.3+): LE u16 header then six u16s per cell.
function tileMapData(cells: readonly (Tile | undefined)[], cols: number) {
  const count = cells.reduce((n, tile) => n + Number(tile !== undefined), 0);
  if (!count) return "PackedByteArray()";
  const bytes = Buffer.alloc(2 + count * 12);
  let offset = 2;
  cells.forEach((tile, i) => {
    if (!tile) return;
    bytes.writeUInt16LE(i % cols, offset);
    bytes.writeUInt16LE(Math.floor(i / cols), offset + 2);
    bytes.writeUInt16LE(tile.source, offset + 4);
    bytes.writeUInt16LE(tile.coords[0], offset + 6);
    bytes.writeUInt16LE(tile.coords[1], offset + 8);
    offset += 12;
  });
  return `PackedByteArray("${bytes.toString("base64")}")`;
}

class GodotProject {
  readonly files: PackageFile[] = [];
  readonly previews: Preview[] = [];
  private entries = new Map<string, { entry: ManifestEntry; stem: string }>();
  private images = new Map<string, { sourcePath: string; path: string }>();
  private source: Map<string, Uint8Array>;
  private copied = new Set<string>();
  private tilesets = new Map<string, TileSet>();
  private objects = new Map<string, Preview>();

  constructor(private input: TargetInput) {
    this.source = new Map(input.sourceFiles.map((file) => [file.path, file.bytes]));
    input.manifest.entries.forEach((entry, i) => this.entries.set(entry.revisionId, { entry, stem: `${i + 1}-${nodeName(entry.revisionId)}` }));
    input.manifest.files.forEach((file, i) => {
      if (file.mime === "image/png") this.images.set(file.fileId, { sourcePath: file.path, path: `media/source/${i + 1}-${nodeName(file.fileId)}.png` });
    });
  }

  add(path: string, contents: string | Uint8Array) {
    this.files.push({ path: `godot/${path}`, bytes: typeof contents === "string" ? encoder.encode(contents) : contents, compress: typeof contents === "string" });
  }

  private image(fileId: string) {
    const file = this.images.get(fileId);
    const bytes = file && this.source.get(file.sourcePath);
    if (!file || !bytes) throw new Error(`Missing Godot raster: ${fileId}`);
    return { path: file.path, bytes };
  }

  private copyImage(path: string, bytes: Uint8Array) {
    if (this.copied.has(path)) return;
    this.copied.add(path);
    this.add(path, bytes);
  }

  sprite(doc: Document, name: string, parent: string, fileId: string, rect: Rect, position: Point, props: string[] = []) {
    const { path, bytes } = this.image(fileId);
    this.copyImage(path, bytes);
    doc.node(name, "Sprite2D", parent, ["centered = false", `position = ${vec(position)}`, `texture = ${doc.texture(path, rect)}`, ...props]);
  }

  private document(entry: ManifestEntry, name: string, metadata: string[]) {
    const doc = new Document();
    doc.node(name, "Node2D", null, [pointFilter, meta("revision_id", entry.revisionId), ...metadata]);
    return doc;
  }

  still(entry: ManifestEntry, name: string, stamp: { fileId: string; rect: Rect; sourceOffset: Point }, size: Point, pivot: Point, props: string[]) {
    const { stem } = this.entries.get(entry.revisionId)!;
    const doc = this.document(entry, nodeName(name), [`metadata/logical_size = ${veci(size)}`, `metadata/pivot = ${veci(pivot)}`, ...props]);
    const [x, y] = stamp.sourceOffset;
    this.sprite(doc, "Art", ".", stamp.fileId, stamp.rect, [x - pivot[0], y - pivot[1]]);
    const path = `scenes/${stem}-${name}.tscn`;
    this.add(path, doc.serialize());
    this.previews.push({ path, label: `${entry.name ?? entry.assetId} · ${name}`, bounds: [-pivot[0], -pivot[1], ...size] });
  }

  clip(entry: Entry<"character", "clip">) {
    const { stem } = this.entries.get(entry.revisionId)!;
    const clip = entry.payload;
    const doc = this.document(entry, "Clip", [
      `metadata/logical_size = ${veci(clip.logicalSize)}`, `metadata/pivot = ${veci(clip.pivot)}`,
      meta("playback", clip.playback), meta("events", clip.events), meta("direction", clip.direction),
    ]);
    const [px, py] = clip.pivot;
    const [w, h] = clip.logicalSize;
    let minX = 0, minY = 0, maxX = w, maxY = h;
    clip.frames.forEach((frame, i) => {
      const name = `Frame_${i + 1}`;
      const [ox, oy] = frame.rootOffset;
      minX = Math.min(minX, ox);
      minY = Math.min(minY, oy);
      maxX = Math.max(maxX, ox + w);
      maxY = Math.max(maxY, oy + h);
      doc.node(name, "Node2D", ".", [
        `visible = ${i === 0}`, `position = ${vec(frame.rootOffset)}`,
        meta("frame_id", frame.frameId), meta("sockets", frame.sockets),
      ]);
      frame.layers.forEach((layer, li) => this.sprite(doc, `Layer_${li + 1}_${nodeName(layer.partId)}`, name, layer.fileId, layer.rect, [layer.offset[0] - px, layer.offset[1] - py], [meta("part_id", layer.partId)]));
    });

    // Step visibility switches the whole authored stack atomically. Godot 4.3
    // has no SpriteFrames ping-pong; repeat interior frames in reverse so that
    // the two endpoints keep exactly their authored duration per cycle.
    const order = clip.frames.map((_, i) => i);
    if (clip.playback === "ping_pong") for (let i = order.length - 2; i > 0; i--) order.push(i);
    const keys = clip.frames.map((_, i) => ({ times: [0], values: [i === 0] }));
    let elapsed = 0;
    order.forEach((i, step) => {
      if (step > 0) {
        const hidden = keys[order[step - 1]!]!;
        hidden.times.push(elapsed / 1000);
        hidden.values.push(false);
        keys[i]!.times.push(elapsed / 1000);
        keys[i]!.values.push(true);
      }
      elapsed += clip.frames[i]!.durationMs;
    });
    const animation = doc.sub("Animation", [
      `resource_name = ${quote(clip.action)}`, `length = ${elapsed / 1000}`, `loop_mode = ${clip.playback === "once" ? 0 : 1}`, "step = 0.001",
      ...keys.flatMap(({ times, values }, i) => [
        `tracks/${i}/type = "value"`, `tracks/${i}/path = NodePath("Frame_${i + 1}:visible")`,
        `tracks/${i}/interp = 0`, `tracks/${i}/loop_wrap = false`,
        `tracks/${i}/keys = {"times": PackedFloat32Array(${times.join(", ")}), "update": 0, "values": [${values.join(", ")}]}`,
      ]),
    ]);
    const library = doc.sub("AnimationLibrary", [`_data = {&${quote(clip.action)}: ${animation}}`]);
    doc.node("AnimationPlayer", "AnimationPlayer", ".", [`libraries = {&"": ${library}}`, `autoplay = ${quote(clip.action)}`]);
    const path = `scenes/${stem}.tscn`;
    this.add(path, doc.serialize());
    this.previews.push({ path, label: entry.name ?? entry.assetId, bounds: [minX - px, minY - py, maxX - minX, maxY - minY] });
  }

  async tileSet(entry: TileSetEntry) {
    const cached = this.tilesets.get(entry.revisionId);
    if (cached) return cached;
    const { stem } = this.entries.get(entry.revisionId)!;
    const payload = entry.payload;
    this.input.signal.throwIfAborted();
    const original = this.image(payload.atlas.fileId);
    const pages = await godotAtlasPages(this.input, stem, payload, original.bytes);
    const doc = new Document();
    const tiles = new Map<string, Tile>();
    const configurations = new Map<string, string>();
    if (entry.kind === "sidescroller") {
      for (const tile of [...entry.payload.tiles].sort((a, b) => a.variant - b.variant)) {
        if (!configurations.has(tile.configuration)) configurations.set(tile.configuration, tile.tileKey);
      }
    }
    const props = [`tile_size = ${veci(payload.cellSize)}`, meta("revision_id", entry.revisionId)];
    if (entry.kind === "corner") {
      props.push("terrain_set_0/mode = 1", meta("diagonals", entry.payload.diagonals));
      entry.payload.terrains.forEach((terrain, i) => {
        const rgb = [1, 3, 5].map((start) => parseInt(terrain.color.slice(start, start + 2), 16) / 255);
        props.push(`terrain_set_0/terrain_${i}/name = ${quote(terrain.name)}`, `terrain_set_0/terrain_${i}/color = Color(${rgb.join(", ")}, 1)`);
      });
    } else {
      props.push(meta("walkable_line_y", entry.payload.walkableLineY), meta("platform_material", entry.payload.platformMaterial), meta("surface_material", entry.payload.surfaceMaterial));
    }
    props.push('custom_data_layer_0/name = "tile_key"', "custom_data_layer_0/type = 4", 'custom_data_layer_1/name = "variant"', "custom_data_layer_1/type = 2");
    if (entry.kind === "sidescroller") props.push('custom_data_layer_2/name = "configuration"', "custom_data_layer_2/type = 4");
    pages.forEach(({ bytes, tiles: page, margin, spacing }, source) => {
      const path = bytes ? `media/tiles/${stem}-${source}.png` : original.path;
      this.copyImage(path, bytes ?? original.bytes);
      const data = [
        "use_texture_padding = false", `texture = ${doc.ext("Texture2D", path)}`, `texture_region_size = ${veci(payload.cellSize)}`,
        `margins = ${veci([margin, margin])}`, `separation = ${veci([spacing, spacing])}`,
      ];
      for (const { tile, coords, columns } of page) {
        const id = coords.join(":");
        data.push(`${id}/0 = 0`, `${id}/0/custom_data_0 = ${quote(tile.tileKey)}`, `${id}/0/custom_data_1 = ${tile.variant}`, `${id}/0/probability = ${tile.weight}`);
        if ("mask" in tile) {
          const corners = ["top_left_corner", "top_right_corner", "bottom_right_corner", "bottom_left_corner"];
          const bits = corners.map((_, bit) => (tile.mask >> bit) & 1);
          const center = Number(bits.reduce((a, b) => a + b, 0) >= 2);
          data.push(`${id}/0/terrain_set = 0`, `${id}/0/terrain = ${center}`, ...corners.map((corner, bit) => `${id}/0/terrains_peering_bit/${corner} = ${bits[bit]}`));
        } else {
          data.push(`${id}/0/custom_data_2 = ${quote(tile.configuration)}`);
        }
        if (tile.frames.length) {
          if (columns) data.push(`${id}/animation_columns = ${columns}`);
          data.push(`${id}/animation_frames_count = ${tile.frames.length}`);
          tile.frames.forEach((frame, i) => data.push(`${id}/animation_frame_${i}/duration = ${frame.durationMs / 1000}`));
        }
        tiles.set(tile.tileKey, { source, coords });
      }
      props.push(`sources/${source} = ${doc.sub("TileSetAtlasSource", data)}`);
    });
    const path = `tilesets/${stem}.tres`;
    this.add(path, doc.serialize("TileSet", props));
    const result = { path, tiles, configurations };
    this.tilesets.set(entry.revisionId, result);
    return result;
  }

  tilesPreview(entry: TileSetEntry, tileset: TileSet) {
    const { stem } = this.entries.get(entry.revisionId)!;
    const cols = Math.ceil(Math.sqrt(tileset.tiles.size));
    const [w, h] = entry.payload.cellSize;
    const doc = this.document(entry, "TilesetPreview", []);
    doc.node("Tiles", "TileMapLayer", ".", [
      `tile_set = ${doc.ext("TileSet", tileset.path)}`, `tile_map_data = ${tileMapData([...tileset.tiles.values()], cols)}`,
    ]);
    const path = `scenes/${stem}-tiles.tscn`;
    this.add(path, doc.serialize());
    this.previews.push({ path, label: entry.name ?? entry.assetId, bounds: [0, 0, cols * w, Math.ceil(tileset.tiles.size / cols) * h] });
  }

  object(entry: ObjectEntry) {
    const cached = this.objects.get(entry.revisionId);
    if (cached) return cached;
    const { stem } = this.entries.get(entry.revisionId)!;
    const obj = entry.payload;
    const [px, py] = obj.supportPoint;
    const [x, y, w, h] = obj.rect;
    const cut = obj.occlusionAboveY ?? 0;
    let bounds: Rect = [-px, -py, w, h];
    const doc = this.document(entry, "MapObject", [
      `metadata/footprint_cells = ${veci(obj.footprintCells)}`, `metadata/support_point = ${veci(obj.supportPoint)}`,
      meta("occlusion_above_y", obj.occlusionAboveY), meta("projection", obj.projection),
    ]);
    if (obj.shadow) {
      const [sx, sy] = obj.shadow.offset;
      this.sprite(doc, "Shadow", ".", obj.shadow.fileId, obj.shadow.rect, [sx - px, sy - py]);
      const left = Math.min(0, sx), top = Math.min(0, sy);
      bounds = [left - px, top - py, Math.max(w, sx + obj.shadow.rect[2]) - left, Math.max(h, sy + obj.shadow.rect[3]) - top];
    }
    if (cut < h) this.sprite(doc, "Art", ".", obj.fileId, [x, y + cut, w, h - cut], [-px, cut - py]);
    if (cut > 0) this.sprite(doc, "Foreground", ".", obj.fileId, [x, y, w, cut], [-px, -py], ["z_index = 1"]);
    if (obj.collision.length) {
      doc.node("Collision", "StaticBody2D", ".", []);
      obj.collision.forEach(([rx, ry, rw, rh], i) => doc.rectShape(`Shape_${i + 1}`, "Collision", [rx - px, ry - py, rw, rh]));
    }
    const path = `scenes/${stem}.tscn`;
    this.add(path, doc.serialize());
    const result = { path, label: entry.name ?? entry.assetId, bounds };
    this.objects.set(entry.revisionId, result);
    return result;
  }

  async tilemap(entry: Entry<"map", "tilemap">) {
    const map = entry.payload;
    const terrain = map.terrain;
    if (terrain.mode === "isometric") throw new Error("Godot tilemap expects orthogonal terrain");
    const source = this.entries.get(terrain.tilesetRevisionId)?.entry;
    if (source?.family !== "tileset" || source.kind === "isometric") throw new Error(`Missing Godot tileset: ${terrain.tilesetRevisionId}`);
    const tileset = await this.tileSet(source);
    const [cols, rows] = map.size;
    const [cw, ch] = map.cellSize;
    const cells = terrain.resolved.map((id) => {
      if (id === null) return undefined;
      const tile = tileset.tiles.get(terrain.mode === "corner" ? id : tileset.configurations.get(id) ?? "");
      // Side configurations absent from the tileset are intentional gaps.
      if (!tile && terrain.mode === "corner") throw new Error(`Missing resolved Godot tile: ${id}`);
      return tile;
    });
    const doc = this.document(entry, "TileMap", [
      `metadata/grid_size = ${veci(map.size)}`, meta("projection", map.projection), meta("passages", map.passages),
      meta("terrain_rule", terrain.rule), meta("seed", map.seed),
    ]);
    doc.node("Terrain", "TileMapLayer", ".", [
      `tile_set = ${doc.ext("TileSet", tileset.path)}`, `tile_map_data = ${tileMapData(cells, cols)}`,
    ]);

    // Tile visuals are independent from the map's authored walkability. Merge
    // adjacent blocked cells per row without losing their exact occupied area.
    const terrainRects: Rect[] = [];
    for (let y = 0; y < rows; y++) {
      let start = 0;
      let lastInset = -1;
      for (let x = 0; x <= cols; x++) {
        const i = y * cols + x;
        let inset = -1;
        if (x < cols && terrain.mode === "side") {
          if (terrain.solid[i]) inset = source.kind === "sidescroller" && (y === 0 || !terrain.solid[i - cols]) ? source.payload.walkableLineY : 0;
        } else if (x < cols && terrain.mode === "corner") {
          const v = y * (cols + 1) + x;
          const closed = Number(!terrain.walkable[terrain.vertices[v]!]) + Number(!terrain.walkable[terrain.vertices[v + 1]!])
            + Number(!terrain.walkable[terrain.vertices[v + cols + 1]!]) + Number(!terrain.walkable[terrain.vertices[v + cols + 2]!]);
          if (closed >= 2) inset = 0;
        }
        if (inset === lastInset) continue;
        if (lastInset >= 0) terrainRects.push([start * cw, y * ch + lastInset, (x - start) * cw, ch - lastInset]);
        start = x;
        lastInset = inset;
      }
    }
    if (terrainRects.length) {
      doc.node("TerrainCollision", "StaticBody2D", ".", []);
      terrainRects.forEach((rect, i) => doc.rectShape(`Span_${i + 1}`, "TerrainCollision", rect));
    }
    if (map.collisions.length) {
      doc.node("Collisions", "Node2D", ".", []);
      map.collisions.forEach((collision, i) => {
        const name = `Collision_${i + 1}_${nodeName(collision.collisionId)}`;
        doc.node(name, "StaticBody2D", "Collisions", [meta("collision_id", collision.collisionId)]);
        const parent = `Collisions/${name}`;
        if (collision.kind === "cells") {
          collision.cells.forEach(([x, y], j) => doc.rectShape(`Cell_${j + 1}`, parent, [x * cw, y * ch, cw, ch]));
        } else {
          doc.node("Polygon", "CollisionPolygon2D", parent, [`polygon = PackedVector2Array(${collision.points.flat().join(", ")})`]);
        }
      });
    }
    if (map.objects.length) {
      doc.node("Objects", "Node2D", ".", ["y_sort_enabled = true"]);
      map.objects.forEach((placement, i) => {
        const obj = placement.objectRevisionId && this.entries.get(placement.objectRevisionId)?.entry;
        if (!obj || obj.family !== "map" || obj.kind !== "object") throw new Error(`Missing Godot map object: ${placement.objectRevisionId}`);
        const { path } = this.object(obj);
        doc.instance(`Object_${i + 1}_${nodeName(placement.objectId)}`, "Objects", path, [
          `position = ${vec(objectAnchor(placement, obj.payload.footprintCells, map.cellSize))}`,
          meta("object_id", placement.objectId), ...(placement.label ? [meta("label", placement.label)] : []),
        ]);
      });
    }
    if (map.regions.length) {
      doc.node("Regions", "Node2D", ".", []);
      map.regions.forEach((region, i) => {
        const [x, y, w, h] = region.rect;
        const name = `Region_${i + 1}_${nodeName(region.regionId)}`;
        doc.node(name, "Area2D", "Regions", [
          `position = ${vec([(x + w / 2) * cw, (y + h / 2) * ch])}`, "collision_layer = 0", "collision_mask = 0",
          "monitoring = false", "monitorable = false", meta("region_id", region.regionId), meta("label", region.name), meta("kind", region.kind),
        ]);
        doc.rectShape("Bounds", `Regions/${name}`, [-w * cw / 2, -h * ch / 2, w * cw, h * ch]);
        if (region.kind === "spawn") doc.node("Spawn", "Marker2D", `Regions/${name}`, [], "spawn_points");
      });
    }
    if (map.entrances.length) {
      doc.node("Entrances", "Node2D", ".", []);
      map.entrances.forEach((entrance, i) => doc.node(`Entrance_${i + 1}_${nodeName(entrance.entranceId)}`, "Marker2D", "Entrances", [
        `position = ${vec([(entrance.cell[0] + 0.5) * cw, (entrance.cell[1] + 0.5) * ch])}`,
        meta("entrance_id", entrance.entranceId), meta("label", entrance.name), meta("side", entrance.side),
      ]));
    }
    const { stem } = this.entries.get(entry.revisionId)!;
    const path = `scenes/${stem}.tscn`;
    this.add(path, doc.serialize());
    this.previews.push({ path, label: entry.name ?? entry.assetId, bounds: [0, 0, cols * cw, rows * ch] });
  }

  gallery() {
    this.add("project.godot", `config_version=5\n\n[application]\nconfig/name=${quote(this.input.projectName)}\nrun/main_scene="res://gallery.tscn"\nconfig/features=PackedStringArray("4.3", "GL Compatibility")\n\n[display]\nwindow/size/viewport_width=920\nwindow/size/viewport_height=640\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\ntextures/default_filters/use_nearest_mipmap_filter=false\nenvironment/defaults/default_clear_color=Color(0.12, 0.14, 0.17, 1)\n`);
    const doc = new Document();
    doc.node("Gallery", "ScrollContainer", null, ["anchors_preset = 15", "anchor_right = 1.0", "anchor_bottom = 1.0", "horizontal_scroll_mode = 0", pointFilter]);
    doc.node("Assets", "Control", ".", [`custom_minimum_size = ${vec([880, Math.ceil(this.previews.length / 2) * 308 + 20])}`]);
    this.previews.forEach(({ path, label, bounds: [left, top, w, h] }, i) => {
      const x = 16 + (i % 2) * 440;
      const y = 12 + Math.floor(i / 2) * 308;
      const fit = Math.min(400 / w, 258 / h, 4);
      const scale = fit >= 1 ? Math.floor(fit) : fit;
      doc.node(`Title_${i + 1}`, "Label", "Assets", [`offset_left = ${x}`, `offset_top = ${y}`, `offset_right = ${x + 410}`, `text = ${quote(label)}`, "text_overrun_behavior = 3"]);
      doc.instance(`Preview_${i + 1}`, "Assets", path, [`position = ${vec([x - left * scale, y + 28 - top * scale])}`, `scale = ${vec([scale, scale])}`]);
    });
    this.add("gallery.tscn", doc.serialize());
  }
}

function problem(entry: ManifestEntry) {
  if (entry.family === "item" || (entry.family === "character" && (entry.kind === "base" || entry.kind === "clip"))) return null;
  if (entry.family === "tileset" && entry.kind !== "isometric") {
    return godotAtlasFits(entry.payload) ? null : tx("A célula ou animação do tile excede uma página de atlas de 4096 px no Godot", "The tile cell or animation exceeds a 4096 px Godot atlas page");
  }
  if (entry.family === "map" && (entry.kind === "tilemap" || entry.kind === "object")) {
    return entry.payload.projection === "isometric" ? tx("Godot aceita apenas mapas e objetos ortogonais", "Godot supports only orthogonal maps and map objects") : null;
  }
  return tx(`Godot não converte ${entry.family}/${entry.kind} para um recurso nativo`, `Godot does not convert ${entry.family}/${entry.kind} to a native resource`);
}

export const godotTarget: ExportTarget = {
  problem,
  async build(input) {
    const project = new GodotProject(input);
    for (const entry of input.manifest.entries) {
      if (!input.selected.has(entry.revisionId)) continue;
      input.signal.throwIfAborted();
      const issue = problem(entry);
      if (issue) throw new DomainFailure("coverage_incomplete", issue, { revisionId: entry.revisionId });
      if (entry.family === "character" && entry.kind === "base") {
        const payload = entry.payload;
        for (const view of payload.views) project.still(entry, view.direction, view, payload.logicalSize, payload.groundOrigin, [
          meta("direction", view.direction), meta("state", payload.state), ...(payload.orientation ? [meta("orientation", payload.orientation)] : []),
        ]);
      } else if (entry.family === "character" && entry.kind === "clip") {
        project.clip(entry);
      } else if (entry.family === "item") {
        for (const rep of entry.payload.representations) project.still(entry, `${rep.role}-${rep.state}`, rep, rep.logicalSize, rep.pivot, [
          meta("item_key", entry.payload.itemKey), meta("role", rep.role), meta("state", rep.state),
        ]);
      } else if (entry.family === "tileset" && entry.kind !== "isometric") {
        project.tilesPreview(entry, await project.tileSet(entry));
      } else if (entry.family === "map" && entry.kind === "object") {
        project.previews.push(project.object(entry));
      } else if (entry.family === "map" && entry.kind === "tilemap") {
        await project.tilemap(entry);
      }
    }
    project.gallery();
    return project.files;
  },
};
