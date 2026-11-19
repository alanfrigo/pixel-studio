import { createHash } from "node:crypto";
import type { ClipPayload, GridPoint, ManifestEntry, ManifestFile, Offset, Rect, TilemapPayload } from "@/contracts";
import { objectAnchor } from "@/domain/world/map";
import { type LocalizedText, tx } from "@/i18n/locales";
import { DomainFailure } from "../../errors";
import type { PackageFile } from "../package";
import type { ExportTarget, TargetInput } from "../target";
import { unityEditorSource, unityInstructions, unityTimedTileSource } from "./unity-editor";

const root = "unity/Assets/PixelStudio";
const pixelsPerUnit = 32;
const maxTileSteps = 8192;

type ClipEntry = Extract<ManifestEntry, { family: "character"; kind: "clip" }>;
type TilesetEntry = Extract<ManifestEntry, { family: "tileset"; kind: "corner" | "sidescroller" }>;
type ObjectEntry = Extract<ManifestEntry, { family: "map"; kind: "object" }>;
type MapEntry = Extract<ManifestEntry, { family: "map"; kind: "tilemap" }>;
type Png = Extract<ManifestFile, { mime: "image/png" }>;

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function slug(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36);
}

function assetKey(entry: ManifestEntry) {
  return `${slug(entry.name ?? entry.kind) || "asset"}-${digest(entry.revisionId).slice(0, 20)}`;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function animatedTileProblem({ payload }: TilesetEntry): LocalizedText | null {
  for (const tile of payload.tiles) {
    if (!tile.frames.length) continue;
    const step = tile.frames.reduce((divisor, frame) => gcd(divisor, frame.durationMs), 0);
    if (tile.frames.reduce((sum, frame) => sum + frame.durationMs / step, 0) > maxTileSteps) {
      return tx(`O tile ${tile.tileKey} exige mais de ${maxTileSteps} passos para manter as durações no Unity.`, `Tile ${tile.tileKey} needs more than ${maxTileSteps} steps to preserve its timings in Unity.`);
    }
  }
  return null;
}

function problem(entry: ManifestEntry): LocalizedText | null {
  switch (entry.family) {
    case "character":
      if (entry.kind === "base") return null;
      if (entry.kind === "clip") {
        return entry.payload.frames.some((frame) => frame.layers.length > 4095)
          ? tx("O quadro tem mais camadas do que o Unity pode ordenar.", "A frame has more layers than Unity can sort.")
          : null;
      }
      break;
    case "item":
      return null;
    case "tileset":
      if (entry.kind !== "isometric") return animatedTileProblem(entry);
      break;
    case "map":
      if (entry.kind === "object" || entry.kind === "tilemap") {
        return entry.payload.projection !== "isometric" ? null : tx("Este importador Unity não aceita projeção isométrica.", "This Unity importer does not support isometric projection.");
      }
      break;
  }
  return tx(`Unity não importa ${entry.family}/${entry.kind} como recurso nativo.`, `Unity cannot import ${entry.family}/${entry.kind} as a native asset.`);
}

interface SpriteSlice {
  id: number;
  name: string;
  guid: string;
  // Source rectangle and pivot in Unity's bottom-left pixel coordinates.
  x: number;
  y: number;
  width: number;
  height: number;
  pivotX: number;
  pivotY: number;
}

interface Image {
  source: Png;
  path: string;
  slices: Map<string, SpriteSlice>;
}

interface SpriteRef {
  sprite: number;
  // Offset from the logical pivot to the imported sprite pivot, in Unity axes.
  x: number;
  y: number;
}

interface RootInfo {
  key: string;
  revisionId: string;
  name: string;
}

interface StaticRoot extends RootInfo {
  variants: (SpriteRef & { name: string; slug: string })[];
}

interface ClipRoot extends RootInfo {
  action: ClipPayload["action"];
  direction: ClipPayload["direction"];
  playback: ClipPayload["playback"];
  durationMs: number;
  frames: {
    id: string;
    startMs: number;
    durationMs: number;
    moveX: number;
    moveY: number;
    sockets: ClipPayload["frames"][number]["sockets"];
    layers: (SpriteRef & { part: string })[];
  }[];
  events: ClipPayload["events"];
}

interface TilesetRoot extends RootInfo {
  cellWidth: number;
  cellHeight: number;
  tiles: {
    id: string;
    rule: string;
    variant: number;
    weight: number;
    name: string;
    sprite: number;
    frames: { sprite: number; durationMs: number }[];
  }[];
}

interface Point {
  x: number;
  y: number;
}

interface Box extends Point {
  width: number;
  height: number;
}

interface ObjectRoot extends RootInfo {
  selected: boolean;
  shadow: SpriteRef | null;
  bottom: SpriteRef | null;
  top: SpriteRef | null;
  collision: Box[];
}

interface MapRoot extends RootInfo {
  projection: TilemapPayload["projection"];
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  tileset: string;
  cells: number[];
  blocked: number[];
  polygons: { id: string; points: Point[] }[];
  regions: (Box & { id: string; name: string; kind: string })[];
  entrances: (Point & { id: string; name: string; side: string })[];
  passages: TilemapPayload["passages"];
  objects: (Point & { id: string; name: string; objectKey: string })[];
}

type Slice = (fileId: string, rect: Rect, offset: Offset, pivot: GridPoint, label: string) => SpriteRef;

function spriteSlicer(input: TargetInput, folder: string) {
  const files = new Map(input.manifest.files.map((file) => [file.fileId, file]));
  const sources = new Map(input.sourceFiles.map((file) => [file.path, file.bytes]));
  const images = new Map<string, Image>();
  let nextId = 1;

  const slice: Slice = (fileId, rect, offset, pivot, label) => {
    const file = files.get(fileId);
    if (file?.mime !== "image/png") throw new Error(`Unity export requires a PNG for ${fileId}`);
    if (Math.max(file.width, file.height) > 16384) {
      throw new DomainFailure("validation_failed", tx(`A imagem ${file.path} excede o limite de textura do Unity (16384 px).`, `Image ${file.path} exceeds Unity's texture size limit (16384 px).`));
    }
    let image = images.get(fileId);
    if (!image) {
      image = { source: file, path: `Textures/source-${digest(fileId).slice(0, 24)}.png`, slices: new Map() };
      images.set(fileId, image);
    }

    const [x, y, width, height] = rect;
    const px = Math.min(width, Math.max(0, pivot[0] - offset[0]));
    const py = Math.min(height, Math.max(0, pivot[1] - offset[1]));
    const key = `${x},${y},${width},${height},${px},${py}`;
    let spec = image.slices.get(key);
    if (!spec) {
      const guid = digest(`${fileId}\n${key}`).slice(0, 32);
      spec = { id: nextId++, name: `${slug(label) || "sprite"}-${guid.slice(0, 12)}`, guid, x, y: file.height - y - height, width, height, pivotX: px, pivotY: height - py };
      image.slices.set(key, spec);
    }
    return { sprite: spec.id, x: offset[0] + px - pivot[0], y: pivot[1] - offset[1] - py };
  };

  return {
    slice,
    assets() {
      return [...images.values()].map(({ source, path, slices }) => {
        const bytes = sources.get(source.path);
        if (!bytes) throw new Error(`Absent Unity export source: ${source.path}`);
        return {
          image: { path, width: source.width, height: source.height, slices: [...slices.values()] },
          file: { path: `${folder}/${path}`, bytes, compress: false },
        };
      });
    },
  };
}

function makeTileset(entry: TilesetEntry, slice: Slice): TilesetRoot {
  const failed = animatedTileProblem(entry);
  if (failed) throw new DomainFailure("validation_failed", failed, { revisionId: entry.revisionId });
  const { payload } = entry;
  const cut = (rect: Rect, label: string) => slice(payload.atlas.fileId, rect, [0, 0], [rect[2] / 2, rect[3] / 2], label).sprite;
  return {
    key: assetKey(entry), revisionId: entry.revisionId, name: entry.name ?? entry.revisionId,
    cellWidth: payload.cellSize[0], cellHeight: payload.cellSize[1],
    tiles: payload.tiles.map((tile) => {
      const rule = "mask" in tile ? `mask-${tile.mask}` : tile.configuration;
      return {
        id: tile.tileKey, rule, variant: tile.variant, weight: tile.weight,
        name: `tile-${slug(rule)}-${tile.variant}-${digest(tile.tileKey).slice(0, 12)}`,
        sprite: cut(tile.rect, tile.tileKey),
        frames: tile.frames.map((frame, i) => ({ sprite: cut(frame.rect, `${tile.tileKey}-${i}`), durationMs: frame.durationMs })),
      };
    }),
  };
}

function makeObject(entry: ObjectEntry, slice: Slice, selected: boolean): ObjectRoot {
  const { payload: p } = entry;
  const [x, y, width, height] = p.rect;
  const line = p.occlusionAboveY ?? 0;
  const shadow = p.shadow;
  return {
    key: assetKey(entry), revisionId: entry.revisionId, name: entry.name ?? entry.revisionId, selected,
    shadow: shadow ? slice(shadow.fileId, shadow.rect, shadow.offset, p.supportPoint, "shadow") : null,
    bottom: line < height ? slice(p.fileId, [x, y + line, width, height - line], [0, line], p.supportPoint, "object") : null,
    top: line > 0 ? slice(p.fileId, [x, y, width, line], [0, 0], p.supportPoint, "occlusion") : null,
    collision: p.collision.map(([rx, ry, w, h]) => ({ x: rx - p.supportPoint[0] + w / 2, y: p.supportPoint[1] - ry - h / 2, width: w, height: h })),
  };
}

function terrainBlockers(map: TilemapPayload) {
  const [width, height] = map.size;
  const { terrain } = map;
  const blocked = new Set<number>();
  if (terrain.mode === "side") {
    terrain.solid.forEach((solid, i) => { if (solid) blocked.add(i); });
  } else if (terrain.mode === "corner") {
    const { vertices, walkable } = terrain;
    const stride = width + 1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const nw = y * stride + x;
      const closed = Number(!walkable[vertices[nw]!]) + Number(!walkable[vertices[nw + 1]!])
        + Number(!walkable[vertices[nw + stride]!]) + Number(!walkable[vertices[nw + stride + 1]!]);
      if (closed >= 2) blocked.add(y * width + x);
    }
  }
  for (const group of map.collisions) {
    if (group.kind === "cells") for (const [x, y] of group.cells) blocked.add(y * width + x);
  }
  return [...blocked].sort((a, b) => a - b);
}

function makeMap(entry: MapEntry, getTileset: (id: string) => TilesetRoot, getObject: (id: string) => ObjectEntry): MapRoot {
  const { payload: p } = entry;
  if (p.terrain.mode === "isometric") throw new Error("Not an orthogonal Unity map");
  const tileset = getTileset(p.terrain.tilesetRevisionId);
  const tileIds = new Map<string, number>();
  if (p.terrain.mode === "corner") {
    tileset.tiles.forEach((tile, i) => tileIds.set(tile.id, i + 1));
  } else {
    // Pixel Studio's side-v1 resolver chooses the lowest variant of each configuration.
    const variants = new Map<string, number>();
    tileset.tiles.forEach((tile, i) => {
      if (tile.variant < (variants.get(tile.rule) ?? Infinity)) {
        variants.set(tile.rule, tile.variant);
        tileIds.set(tile.rule, i + 1);
      }
    });
  }
  const [cellWidth, cellHeight] = p.cellSize;
  if (cellWidth !== tileset.cellWidth || cellHeight !== tileset.cellHeight) {
    throw new DomainFailure("validation_failed", tx("A célula do mapa não coincide com a do tileset Unity.", "The map cell size does not match its Unity tileset."), { revisionId: entry.revisionId });
  }
  const corner = p.terrain.mode === "corner";
  const cells = p.terrain.resolved.map((key) => {
    const tile = key === null ? undefined : tileIds.get(key);
    if (corner && key !== null && tile === undefined) {
      throw new DomainFailure("validation_failed", tx(`O mapa cita o tile desconhecido ${key}.`, `The map references unknown tile ${key}.`), { revisionId: entry.revisionId });
    }
    return tile ?? 0;
  });
  return {
    key: assetKey(entry), revisionId: entry.revisionId, name: entry.name ?? entry.revisionId, projection: p.projection,
    width: p.size[0], height: p.size[1], cellWidth, cellHeight, tileset: tileset.key, cells,
    blocked: terrainBlockers(p),
    polygons: p.collisions.flatMap((c) => c.kind === "polygon" ? [{ id: c.collisionId, points: c.points.map(([x, y]) => ({ x, y: -y })) }] : []),
    regions: p.regions.map((r) => {
      const [x, y, w, h] = r.rect;
      return { id: r.regionId, name: r.name, kind: r.kind, x: (x + w / 2) * cellWidth, y: -(y + h / 2) * cellHeight, width: w * cellWidth, height: h * cellHeight };
    }),
    entrances: p.entrances.map((e) => ({ id: e.entranceId, name: e.name, side: e.side, x: (e.cell[0] + 0.5) * cellWidth, y: -(e.cell[1] + 0.5) * cellHeight })),
    passages: p.passages,
    objects: p.objects.map((placement) => {
      if (placement.objectRevisionId === null) throw new Error(`Orthogonal map placement ${placement.objectId} has no object revision`);
      const obj = getObject(placement.objectRevisionId);
      const [x, y] = objectAnchor(placement, obj.payload.footprintCells, p.cellSize);
      return { id: placement.objectId, name: placement.label ?? obj.name ?? obj.revisionId, objectKey: assetKey(obj), x, y: -y };
    }),
  };
}

function makeClip(entry: ClipEntry, slice: Slice): ClipRoot {
  const p = entry.payload;
  const forward = p.frames.map((frame) => ({
    id: frame.frameId, durationMs: frame.durationMs, moveX: frame.rootOffset[0], moveY: -frame.rootOffset[1], sockets: frame.sockets,
    layers: frame.layers.map((layer) => ({ ...slice(layer.fileId, layer.rect, layer.offset, p.pivot, layer.partId), part: layer.partId })),
  }));
  // The portable ping-pong cycle does not repeat either endpoint.
  const order = p.playback === "ping_pong" ? [...forward, ...forward.slice(1, -1).reverse()] : forward;
  let durationMs = 0;
  const frames = order.map((frame) => {
    const startMs = durationMs;
    durationMs += frame.durationMs;
    return { ...frame, startMs };
  });
  return {
    key: assetKey(entry), revisionId: entry.revisionId, name: entry.name ?? entry.revisionId,
    action: p.action, direction: p.direction, playback: p.playback, durationMs, frames, events: p.events,
  };
}

function textFile(path: string, value: string): PackageFile {
  return { path, bytes: new TextEncoder().encode(value), compress: true };
}

export const unityTarget: ExportTarget = {
  problem,
  build(input) {
    const entries = new Map(input.manifest.entries.map((entry) => [entry.revisionId, entry]));
    const selected = [...input.selected].sort();
    const bundle = `job-${digest(JSON.stringify([input.manifest, selected, input.projectName])).slice(0, 24)}`;
    const folder = `${root}/Bundles/${bundle}`;
    const { slice, assets } = spriteSlicer(input, folder);
    const tilesets = new Map<string, TilesetRoot>();
    const objects = new Map<string, ObjectRoot>();
    const maps: MapRoot[] = [];
    const clips: ClipRoot[] = [];
    const sprites: StaticRoot[] = [];

    const getTileset = (id: string) => {
      const existing = tilesets.get(id);
      if (existing) return existing;
      const entry = entries.get(id);
      if (entry?.family !== "tileset" || entry.kind === "isometric") throw new Error(`Missing orthogonal Unity tileset ${id}`);
      const asset = makeTileset(entry, slice);
      tilesets.set(id, asset);
      return asset;
    };
    const getObject = (id: string) => {
      const entry = entries.get(id);
      if (entry?.family !== "map" || entry.kind !== "object") throw new Error(`Missing Unity map object ${id}`);
      if (!objects.has(id)) {
        const reason = problem(entry);
        if (reason) throw new DomainFailure("validation_failed", reason, { revisionId: id });
        objects.set(id, makeObject(entry, slice, input.selected.has(id)));
      }
      return entry;
    };
    for (const id of selected) {
      input.signal.throwIfAborted();
      const entry = entries.get(id);
      if (!entry) throw new Error(`Selected Unity revision not in the portable manifest: ${id}`);
      const reason = problem(entry);
      if (reason) throw new DomainFailure("validation_failed", reason, { revisionId: id });
      const name = entry.name ?? id;
      if (entry.family === "character" && entry.kind === "base") {
        const { payload } = entry;
        const variants = payload.views.map((v) => ({ name: v.direction, slug: v.direction.toLowerCase(), ...slice(v.fileId, v.rect, v.sourceOffset, payload.groundOrigin, v.direction) }));
        sprites.push({ key: assetKey(entry), revisionId: id, name, variants });
      } else if (entry.family === "character" && entry.kind === "clip") {
        clips.push(makeClip(entry, slice));
      } else if (entry.family === "item") {
        const variants = entry.payload.representations.map((r) => {
          const label = `${r.role}-${r.state}`;
          return { name: label, slug: slug(label), ...slice(r.fileId, r.rect, r.sourceOffset, r.pivot, label) };
        });
        sprites.push({ key: assetKey(entry), revisionId: id, name, variants });
      } else if (entry.family === "tileset") {
        getTileset(id);
      } else if (entry.family === "map" && entry.kind === "object") {
        getObject(id);
      } else if (entry.family === "map" && entry.kind === "tilemap") {
        maps.push(makeMap(entry, getTileset, getObject));
      } else {
        throw new Error(`No Unity converter for ${entry.family}/${entry.kind}`);
      }
    }
    const textures = assets();
    const descriptor = {
      version: 1, project: input.projectName, pixelsPerUnit, selected,
      textures: textures.map((texture) => texture.image), sprites, clips, tilesets: [...tilesets.values()], objects: [...objects.values()], maps,
    };
    return [
      textFile("unity/README.txt", unityInstructions(bundle)),
      textFile(`${root}/Editor/PixelStudioImporter.cs`, unityEditorSource),
      textFile(`${root}/Runtime/PixelStudioTimedTile.cs`, unityTimedTileSource),
      textFile(`${folder}/PixelStudio.job.json`, `${JSON.stringify(descriptor, null, 2)}\n`),
      ...textures.map((texture) => texture.file),
    ];
  },
};
