import type { ManifestEntry, ManifestFile, Rect, TilemapPayload } from "@/contracts";
import { tiledWangId, vertexIndex } from "@/domain/world/corner";
import { cellReferencePoint, objectAnchor } from "@/domain/world/map";
import { type LocalizedText, tx } from "@/i18n/locales";
import { DomainFailure } from "../../errors";
import { slugify } from "../../util";
import type { PackageFile } from "../package";
import type { ExportTarget, TargetInput } from "../target";

type TerrainEntry = Extract<ManifestEntry, { family: "tileset"; kind: "corner" | "sidescroller" }>;
type PropEntry = Extract<ManifestEntry, { family: "map"; kind: "object" }>;
type MapEntry = Extract<ManifestEntry, { family: "map"; kind: "tilemap" }>;
type Raster = Extract<ManifestFile, { mime: "image/png" }>;
type RasterLookup = (fileId: string) => Raster;
type Value = string | number | boolean;
interface Property {
  name: string;
  type: "string" | "int" | "bool" | "object";
  value: Value;
}

interface TiledObject {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  gid?: number;
  point?: true;
  polygon?: { x: number; y: number }[];
  properties: Property[];
}

interface LayerFields {
  id: number;
  name: string;
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
}

interface ObjectLayer extends LayerFields {
  type: "objectgroup";
  draworder: "index";
  objects: TiledObject[];
}

interface TileLayer extends LayerFields {
  type: "tilelayer";
  width: number;
  height: number;
  data: number[];
}

interface ImageFields {
  image: string;
  imagewidth: number;
  imageheight: number;
}

interface Tile extends Partial<ImageFields> {
  id: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  type?: string;
  probability?: number;
  properties?: Property[];
  animation?: { tileid: number; duration: number }[];
  objectgroup?: ObjectLayer;
}

interface WangSet {
  name: string;
  type: "corner";
  tile: number;
  colors: { name: string; color: string; tile: number; probability: number; properties: Property[] }[];
  wangtiles: { tileid: number; wangid: number[] }[];
}

interface Tileset extends Partial<ImageFields> {
  name: string;
  tilewidth: number;
  tileheight: number;
  columns: number;
  tilecount: number;
  margin?: number;
  spacing?: number;
  tilerendersize?: "grid";
  objectalignment?: "topleft";
  properties: Property[];
  tiles: Tile[];
  wangsets?: WangSet[];
}

interface NativeTileset {
  stem: string;
  tilecount: number;
}

interface NativeTerrain extends NativeTileset {
  resolvedIds: Map<string, number>;
}

interface TiledMap {
  orientation: "orthogonal";
  renderorder: "right-down";
  infinite: false;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  nextlayerid: number;
  nextobjectid: number;
  properties: Property[];
  layers: (TileLayer | ObjectLayer)[];
}

const FOLDER = "tiled";
// Atlas sub-images and rendering to the map grid are available from Tiled 1.9.1.
const VERSION = "1.10";
const MAX_INT = 0x7fff_ffff;
const MAX_GID = 0x0fff_ffff;
const encoder = new TextEncoder();

function problem(entry: ManifestEntry): LocalizedText | null {
  if (entry.family === "tileset" || (entry.family === "map" && (entry.kind === "tilemap" || entry.kind === "object"))) {
    if (entry.payload.projection === "isometric") {
      return tx(
        "Este perfil Tiled não exporta geometria isométrica do Studio: elevação, pontos de apoio e ordenação por profundidade não têm equivalência fiel neste perfil.",
        "This Tiled profile does not export Studio isometric geometry: elevation, support points, and depth sorting have no faithful equivalent in this profile.",
      );
    }
    if (entry.family === "map" && entry.kind === "tilemap") {
      const { size: [cols, rows], cellSize: [w, h] } = entry.payload;
      if (cols * w > MAX_INT || rows * h > MAX_INT) {
        return tx("As dimensões em pixels do mapa excedem o limite do Tiled.", "The map's pixel dimensions exceed Tiled's limit.");
      }
    }
    return null;
  }
  return tx(
    "O perfil Tiled aceita apenas tilesets por cantos ou laterais, mapas de tiles e objetos de mapa não isométricos.",
    "The Tiled profile accepts only corner or side tilesets, tilemaps, and non-isometric map objects.",
  );
}

function fail(message: LocalizedText, revisionId: string): never {
  throw new DomainFailure("coverage_incomplete", message, { revisionId });
}

function props(values: Record<string, Value>): Property[] {
  return Object.entries(values).map(([name, value]) => {
    if (typeof value === "boolean") return { name, type: "bool", value };
    if (typeof value === "number" && Number.isInteger(value) && value >= -MAX_INT - 1 && value <= MAX_INT) return { name, type: "int", value };
    return { name, type: "string", value: String(value) };
  });
}

function imageFields(file: Raster): ImageFields {
  return { image: `../${file.path}`, imagewidth: file.width, imageheight: file.height };
}

function imageTile(id: number, fields: ImageFields, [x, y, width, height]: Rect): Tile {
  return { id, ...fields, x, y, width, height };
}

function terrainTileset(entry: TerrainEntry, raster: RasterLookup): { tileset: Tileset; resolvedIds: Map<string, number> } {
  const payload = entry.payload;
  const file = raster(payload.atlas.fileId);
  const image = imageFields(file);
  const [tilewidth, tileheight] = payload.cellSize;
  const { margin, spacing } = payload.atlas;
  const dx = tilewidth + spacing;
  const dy = tileheight + spacing;
  // Tiled starts at margin on the left/top and stops only when the next tile no longer fits.
  const packedWidth = file.width - margin + spacing;
  const packedHeight = file.height - margin + spacing;
  const columns = Math.floor(packedWidth / dx);
  const rows = Math.floor(packedHeight / dy);
  const onGrid = ([x, y]: Rect) => x >= margin && y >= margin && (x - margin) % dx === 0 && (y - margin) % dy === 0;
  const gridId = ([x, y]: Rect) => ((y - margin) / dy) * columns + (x - margin) / dx;
  const rectKey = (r: Rect) => r.join(",");
  const usedGridIds = new Set<number>();
  // Two authored tiles may share artwork yet differ in terrain, weight, or animation.
  // Use an image collection for those and for manual rectangles outside the atlas grid.
  const grid = Math.max(packedWidth, packedHeight, dx, dy) <= MAX_INT && columns > 0 && rows > 0 && columns * rows <= MAX_GID && payload.tiles.every((tile) => {
    if (!onGrid(tile.rect) || !tile.frames.every((frame) => onGrid(frame.rect))) return false;
    const id = gridId(tile.rect);
    if (usedGridIds.has(id)) return false;
    usedGridIds.add(id);
    return true;
  });
  const tiles: Tile[] = [];
  const resolvedIds = new Map<string, number>();
  const lowestVariant = new Map<string, number>();
  const byRect = new Map<string, number>();
  const representatives = new Map<number, { id: number; variant: number }>();
  const wangtiles: WangSet["wangtiles"] = [];
  for (const [index, tile] of payload.tiles.entries()) {
    const id = grid ? gridId(tile.rect) : index;
    if (!grid) byRect.set(rectKey(tile.rect), id);
    const info = grid ? { id } : imageTile(id, image, tile.rect);
    const traits = { tileKey: tile.tileKey, variant: tile.variant, weight: tile.weight };
    if ("mask" in tile) {
      resolvedIds.set(tile.tileKey, id);
      const representative = representatives.get(tile.mask);
      if (!representative || tile.variant < representative.variant) representatives.set(tile.mask, { id, variant: tile.variant });
      wangtiles.push({ tileid: id, wangid: tiledWangId(tile.mask) });
      tiles.push({ ...info, probability: tile.weight, properties: props({ ...traits, mask: tile.mask }) });
    } else {
      const lowest = lowestVariant.get(tile.configuration);
      if (lowest === undefined || tile.variant < lowest) {
        resolvedIds.set(tile.configuration, id);
        lowestVariant.set(tile.configuration, tile.variant);
      }
      tiles.push({ ...info, probability: tile.weight, properties: props({ ...traits, configuration: tile.configuration }) });
    }
  }
  function frameId(rect: Rect): number {
    if (grid) return gridId(rect);
    const key = rectKey(rect);
    const existing = byRect.get(key);
    if (existing !== undefined) return existing;
    const id = tiles.length;
    tiles.push(imageTile(id, image, rect));
    byRect.set(key, id);
    return id;
  }
  payload.tiles.forEach((tile, index) => {
    if (tile.frames.length) tiles[index]!.animation = tile.frames.map((frame) => ({ tileid: frameId(frame.rect), duration: frame.durationMs }));
  });
  const properties = props({ revisionId: entry.revisionId, projection: payload.projection, complete: payload.complete });
  let wangsets: WangSet[] | undefined;
  if (entry.kind === "corner") {
    const { terrains, diagonals } = entry.payload;
    properties.push(...props({ mask5: diagonals.mask5, mask10: diagonals.mask10 }));
    wangsets = [{
      name: `${terrains[0].name} / ${terrains[1].name}`,
      type: "corner",
      tile: representatives.get(0)?.id ?? tiles[0]!.id,
      colors: terrains.map(({ terrainId, name, color }, i) => ({ name, color, tile: representatives.get(i === 0 ? 0 : 15)?.id ?? -1, probability: 1, properties: props({ terrainId }) })),
      wangtiles,
    }];
  } else {
    const { platformMaterial, surfaceMaterial, walkableLineY, requiredConfigurations } = entry.payload;
    properties.push(...props({ platformMaterial, surfaceMaterial, walkableLineY, requiredConfigurations: JSON.stringify(requiredConfigurations) }));
  }
  const tileset: Tileset = {
    name: entry.name ?? entry.revisionId, tilewidth, tileheight,
    ...(grid ? { ...image, columns, tilecount: columns * rows, margin, spacing } : { columns: 0, tilecount: tiles.length }),
    // Studio scales terrain to fill the map cell when its dimensions differ from the source.
    tilerendersize: "grid", tiles, properties, wangsets,
  };
  return { tileset, resolvedIds };
}

function layerFields(id: number, name: string, visible = true): LayerFields {
  return { id, name, x: 0, y: 0, opacity: 1, visible };
}

function objectLayer(id: number, name: string, objects: TiledObject[], visible = true): ObjectLayer {
  return { ...layerFields(id, name, visible), type: "objectgroup", draworder: "index", objects };
}

function mapObject(id: number, name: string, type: string, [x, y, width, height]: Rect, properties: Property[]): TiledObject {
  return { id, name, type, x, y, width, height, rotation: 0, visible: true, properties };
}

function propTileset(entry: PropEntry, raster: RasterLookup): Tileset {
  const p = entry.payload;
  const properties = props({ revisionId: entry.revisionId, projection: p.projection });
  const tileProperties = props({ supportX: p.supportPoint[0], supportY: p.supportPoint[1], footprintWidth: p.footprintCells[0], footprintHeight: p.footprintCells[1] });
  if (p.occlusionAboveY !== null) tileProperties.push(...props({ occlusionAboveY: p.occlusionAboveY }));
  const tile = imageTile(0, imageFields(raster(p.fileId)), p.rect);
  tile.type = "Prop";
  tile.properties = tileProperties;
  if (p.collision.length) {
    tile.objectgroup = objectLayer(1, "Collision", p.collision.map((r, i) => mapObject(i + 1, "", "Collision", r, [])));
  }
  const tiles = [tile];
  let [tilewidth, tileheight] = p.logicalSize;
  if (p.shadow) {
    const shadow = imageTile(1, imageFields(raster(p.shadow.fileId)), p.shadow.rect);
    shadow.type = "PropShadow";
    shadow.properties = props({ parentTileId: 0, offsetX: p.shadow.offset[0], offsetY: p.shadow.offset[1] });
    tiles.push(shadow);
    tilewidth = Math.max(tilewidth, p.shadow.rect[2]);
    tileheight = Math.max(tileheight, p.shadow.rect[3]);
  }
  return { name: entry.name ?? entry.revisionId, tilewidth, tileheight, tilecount: tiles.length, columns: 0, objectalignment: "topleft", properties, tiles };
}

function terrainCollision(map: TilemapPayload, add: (name: string, type: string, rect: Rect, properties: Property[]) => TiledObject): TiledObject[] {
  const terrain = map.terrain;
  if (terrain.mode !== "corner" || terrain.walkable.every(Boolean)) return [];
  const [width, height] = map.size;
  const [cw, ch] = map.cellSize;
  const objects: TiledObject[] = [];
  // Match the Studio's corner-terrain passage rule; explicit collisions are separate.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = vertexIndex(width, x, y);
      const v = terrain.vertices;
      const walkable = terrain.walkable;
      const closed = Number(!walkable[v[i]!]) + Number(!walkable[v[i + 1]!]) + Number(!walkable[v[i + width + 1]!]) + Number(!walkable[v[i + width + 2]!]);
      if (closed >= 2) objects.push(add("", "TerrainCollision", [x * cw, y * ch, cw, ch], []));
    }
  }
  return objects;
}

function nativeMap(
  entry: MapEntry,
  terrain: NativeTerrain,
  getProp: (revisionId: string) => { entry: PropEntry; tileset: NativeTileset },
): { map: TiledMap; tilesets: { firstgid: number; stem: string }[] } {
  const p = entry.payload;
  const [width, height] = p.size;
  const [tilewidth, tileheight] = p.cellSize;
  const t = p.terrain;
  if (t.mode === "isometric") fail(problem(entry)!, entry.revisionId);
  const data = t.resolved.map((resolved) => {
    if (resolved === null) return 0;
    const id = terrain.resolvedIds.get(resolved);
    if (id !== undefined) return id + 1;
    if (t.mode === "side") return 0; // A documented side terrain gap in the authored map.
    return fail(tx(`O mapa cita um tile inexistente: ${resolved}.`, `The map refers to a missing tile: ${resolved}.`), entry.revisionId);
  });
  const layers: (TileLayer | ObjectLayer)[] = [{ ...layerFields(1, "Terrain"), type: "tilelayer", width, height, data }];
  const tilesets = [{ firstgid: 1, stem: terrain.stem }];
  let firstFreeGid = 1 + terrain.tilecount;
  let nextobjectid = 1;
  const add = (name: string, type: string, rect: Rect, properties: Property[]) => mapObject(nextobjectid++, name, type, rect, properties);
  const propGids = new Map<string, number>();
  const placed = p.objects.map((placement) => {
    if (placement.objectRevisionId === null) fail(tx("A colocação não aponta para um objeto de mapa.", "The placement does not reference a map object."), entry.revisionId);
    const prop = getProp(placement.objectRevisionId);
    let gid = propGids.get(placement.objectRevisionId);
    if (gid === undefined) {
      gid = firstFreeGid;
      firstFreeGid += prop.tileset.tilecount;
      propGids.set(placement.objectRevisionId, gid);
      tilesets.push({ firstgid: gid, stem: prop.tileset.stem });
    }
    return { placement, prop: prop.entry, gid, anchor: objectAnchor(placement, prop.entry.payload.footprintCells, p.cellSize) };
  }).sort((a, b) => a.anchor[1] - b.anchor[1]);
  if (firstFreeGid - 1 > MAX_GID) fail(tx("IDs de tiles excedem o limite do Tiled.", "Tile IDs exceed Tiled's limit."), entry.revisionId);
  const objects: TiledObject[] = [];
  for (const { placement, prop, gid, anchor } of placed) {
    const payload = prop.payload;
    const name = placement.label ?? prop.name ?? placement.objectId;
    const x = anchor[0] - payload.supportPoint[0];
    const y = anchor[1] - payload.supportPoint[1];
    const object = add(name, "Prop", [x, y, ...payload.logicalSize], props({
      objectId: placement.objectId,
      objectRevisionId: prop.revisionId,
      cellX: placement.cell[0], cellY: placement.cell[1], offsetX: placement.offsetPx[0], offsetY: placement.offsetPx[1],
    }));
    object.gid = gid;
    if (payload.shadow) {
      const { offset: [sx, sy], rect: [, , sw, sh] } = payload.shadow;
      const shadow = add(`${name} — shadow`, "PropShadow", [x + sx, y + sy, sw, sh], [{ name: "prop", type: "object", value: object.id }]);
      shadow.gid = gid + 1;
      objects.push(shadow);
    }
    objects.push(object);
  }
  if (objects.length) layers.push(objectLayer(layers.length + 1, "Objects", objects));

  const collisions: TiledObject[] = [];
  for (const collision of p.collisions) {
    const properties = props({ collisionId: collision.collisionId, kind: collision.kind });
    if (collision.kind === "cells") {
      for (const [x, y] of collision.cells) collisions.push(add(collision.collisionId, "Collision", [x * tilewidth, y * tileheight, tilewidth, tileheight], properties));
    } else {
      const [x, y] = collision.points[0]!;
      const object = add(collision.collisionId, "Collision", [x, y, 0, 0], properties);
      object.polygon = collision.points.map(([px, py]) => ({ x: px - x, y: py - y }));
      collisions.push(object);
    }
  }
  if (collisions.length) layers.push(objectLayer(layers.length + 1, "Collisions", collisions, false));
  const blocked = terrainCollision(p, add);
  if (blocked.length) layers.push(objectLayer(layers.length + 1, "Terrain Collision", blocked, false));
  if (p.regions.length) layers.push(objectLayer(layers.length + 1, "Regions", p.regions.map(({ regionId, name, kind, rect: [x, y, w, h] }) =>
    add(name, kind, [x * tilewidth, y * tileheight, w * tilewidth, h * tileheight], props({ regionId }))), false));
  if (p.entrances.length) layers.push(objectLayer(layers.length + 1, "Entrances", p.entrances.map(({ entranceId, name, cell, side }) => ({
    ...add(name, "Entrance", [...cellReferencePoint(p, cell), 0, 0], props({ entranceId, side, cellX: cell[0], cellY: cell[1] })),
    point: true,
  })), false));

  const properties = props({
    revisionId: entry.revisionId, name: entry.name ?? entry.revisionId, projection: p.projection, seed: p.seed, terrainRule: t.rule,
    passages: JSON.stringify(p.passages),
    ...(t.mode === "corner" ? { walkableA: t.walkable[0], walkableB: t.walkable[1] } : { solid: t.solid.join("") }),
  });
  return { map: { orientation: "orthogonal", renderorder: "right-down", infinite: false, width, height, tilewidth, tileheight, nextlayerid: layers.length + 1, nextobjectid, layers, properties }, tilesets };
}

const XML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\t": "&#9;", "\n": "&#10;", "\r": "&#13;" };

function esc(value: Value): string {
  // Escape metacharacters and attribute whitespace; replace code points forbidden by XML 1.0.
  return String(value).replace(/[<>&"]|[^\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, (c) => XML_ENTITIES[c] ?? "\ufffd");
}

function element(name: string, attrs: Record<string, Value | undefined> = {}, body = ""): string {
  let open = `<${name}`;
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) open += ` ${key}="${esc(typeof value === "boolean" ? Number(value) : value)}"`;
  }
  return body ? `${open}>${body}</${name}>\n` : `${open}/>\n`;
}

function xmlProperties(properties?: Property[]): string {
  if (!properties?.length) return "";
  // Tiled values serialize bool as 'true'/'false', unlike visibility attributes.
  return element("properties", {}, properties.map(({ name, type, value }) => element("property", { name, type, value: String(value) })).join(""));
}

function xmlObjects({ objects, id, name, x, y, opacity, visible, draworder }: ObjectLayer): string {
  const body = objects.map(({ properties, point, polygon, ...attrs }) => element("object", attrs, xmlProperties(properties)
    + (point ? element("point") : polygon ? element("polygon", { points: polygon.map(({ x, y }) => `${x},${y}`).join(" ") }) : ""))).join("");
  return element("objectgroup", { id, name, x, y, opacity, visible, draworder }, body);
}

function xmlImage(image?: string, width?: number, height?: number): string {
  return image ? element("image", { source: image, width, height }) : "";
}

function xmlTileset({ image, imagewidth, imageheight, properties, tiles, wangsets, ...attrs }: Tileset): string {
  const tileXml = tiles.map(({ image, imagewidth, imageheight, properties, animation, objectgroup, ...fields }) => element("tile", fields,
    xmlProperties(properties) + xmlImage(image, imagewidth, imageheight) + (objectgroup ? xmlObjects(objectgroup) : "")
    + (animation ? element("animation", {}, animation.map((frame) => element("frame", frame)).join("")) : ""))).join("");
  const wangXml = wangsets ? element("wangsets", {}, wangsets.map(({ colors, wangtiles, ...attrs }) => element("wangset", attrs,
    colors.map(({ properties, ...attrs }) => element("wangcolor", attrs, xmlProperties(properties))).join("")
    + wangtiles.map(({ tileid, wangid }) => element("wangtile", { tileid, wangid: wangid.join(",") })).join(""))).join("")) : "";
  return element("tileset", { version: VERSION, ...attrs }, xmlProperties(properties) + xmlImage(image, imagewidth, imageheight) + tileXml + wangXml);
}

function xmlMap({ properties, layers, ...attrs }: TiledMap, tilesets: { source: string; firstgid: number }[]): string {
  const body = layers.map((layer) => {
    if (layer.type === "objectgroup") return xmlObjects(layer);
    const { id, name, x, y, opacity, visible, width, height, data } = layer;
    return element("layer", { id, name, x, y, opacity, visible, width, height }, element("data", { encoding: "csv" }, data.join(",")));
  }).join("");
  return element("map", { version: VERSION, ...attrs }, xmlProperties(properties) + tilesets.map((ref) => element("tileset", ref)).join("") + body);
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

function build({ manifest, sourceFiles, selected, signal }: TargetInput): PackageFile[] {
  const entries = new Map(manifest.entries.map((e) => [e.revisionId, e]));
  const rasters = new Map(manifest.files.flatMap((f) => f.mime === "image/png" ? [[f.fileId, f] as const] : []));
  const used = new Set(sourceFiles.map((f) => f.path.toLowerCase()));
  for (const file of manifest.files) used.add(file.path.toLowerCase());
  const files: PackageFile[] = [];
  const add = (stem: string, ext: string, content: string) => files.push({ path: `${FOLDER}/${stem}.${ext}`, bytes: encoder.encode(content), compress: true });
  function reserve(prefix: string, entry: ManifestEntry, extensions: readonly [string, string]): string {
    const base = `${prefix}-${slugify(entry.name ?? entry.revisionId)}`;
    let stem = base;
    for (let n = 2; extensions.some((ext) => used.has(`${FOLDER}/${stem}.${ext}`)); n++) stem = `${base}-${n}`;
    for (const ext of extensions) used.add(`${FOLDER}/${stem}.${ext}`);
    return stem;
  }
  function lookup(revisionId: string): ManifestEntry {
    const entry = entries.get(revisionId);
    if (!entry) fail(tx("Revisão do Tiled ausente no manifesto.", "Tiled revision is missing from the manifest."), revisionId);
    const unsupported = problem(entry);
    if (unsupported) fail(unsupported, revisionId);
    return entry;
  }
  const raster = (entry: ManifestEntry): RasterLookup => (fileId) => rasters.get(fileId) ?? fail(tx(`PNG do Tiled ausente: ${fileId}.`, `Tiled PNG is missing: ${fileId}.`), entry.revisionId);
  const terrains = new Map<string, NativeTerrain>();
  const propSets = new Map<string, { entry: PropEntry; tileset: NativeTileset }>();
  function writeTileset(stem: string, tileset: Tileset) {
    add(stem, "tsx", XML_HEADER + xmlTileset(tileset));
    add(stem, "tsj", `${JSON.stringify({ version: VERSION, type: "tileset", ...tileset })}\n`);
  }
  function getTerrain(revisionId: string): NativeTerrain {
    const cached = terrains.get(revisionId);
    if (cached) return cached;
    const entry = lookup(revisionId);
    if (entry.family !== "tileset" || entry.kind === "isometric") fail(tx("A referência do terreno não é um tileset compatível.", "The terrain reference is not a compatible tileset."), revisionId);
    const stem = reserve("tileset", entry, ["tsx", "tsj"]);
    const { tileset, resolvedIds } = terrainTileset(entry, raster(entry));
    writeTileset(stem, tileset);
    const built = { stem, tilecount: tileset.tilecount, resolvedIds };
    terrains.set(revisionId, built);
    return built;
  }
  function getProp(revisionId: string) {
    const cached = propSets.get(revisionId);
    if (cached) return cached;
    const entry = lookup(revisionId);
    if (entry.family !== "map" || entry.kind !== "object") fail(tx("A referência da colocação não é um objeto de mapa.", "The placement reference is not a map object."), revisionId);
    const stem = reserve("prop", entry, ["tsx", "tsj"]);
    const tileset = propTileset(entry, raster(entry));
    writeTileset(stem, tileset);
    const built = { entry, tileset: { stem, tilecount: tileset.tilecount } };
    propSets.set(revisionId, built);
    return built;
  }
  for (const revisionId of selected) {
    signal.throwIfAborted();
    const entry = lookup(revisionId);
    if (entry.family === "tileset") getTerrain(revisionId);
    else if (entry.family === "map" && entry.kind === "object") getProp(revisionId);
    else if (entry.family === "map" && entry.kind === "tilemap") {
      const { map, tilesets } = nativeMap(entry, getTerrain(entry.payload.terrain.tilesetRevisionId), getProp);
      const stem = reserve("map", entry, ["tmx", "tmj"]);
      add(stem, "tmx", XML_HEADER + xmlMap(map, tilesets.map(({ firstgid, stem }) => ({ firstgid, source: `${stem}.tsx` }))));
      add(stem, "tmj", `${JSON.stringify({ version: VERSION, type: "map", ...map, tilesets: tilesets.map(({ firstgid, stem }) => ({ firstgid, source: `${stem}.tsj` })) })}\n`);
    } else {
      fail(problem(entry)!, revisionId);
    }
  }
  return files;
}

export const tiledTarget: ExportTarget = { problem, build };
