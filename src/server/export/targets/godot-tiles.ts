import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Rect, Size } from "@/contracts/common";
import type { CornerTilesetPayload, SideTilesetPayload } from "@/contracts/world";
import type { TargetInput } from "../target";

export type GodotTile = (CornerTilesetPayload | SideTilesetPayload)["tiles"][number];
export type AtlasTile = { tile: GodotTile; coords: Size; columns: number };
interface AtlasPage {
  margin: number;
  spacing: number;
  tiles: AtlasTile[];
  bytes?: Uint8Array;
}

// Bounded pages keep repacked textures within the Studio source-image limits.
// Use one isolated Pillow process for all pages, with no provider credentials.
const repack = promisify(execFile);
const PACK = `
import json
from PIL import Image

with open('layout.json', encoding='utf-8') as spec, Image.open('source.png') as image:
    for i, page in enumerate(json.load(spec)):
        w, h = page['size']
        cw, ch = page['cell']
        packed = Image.new('RGBA', (w, h))
        for col, row, columns, rects in page['tiles']:
            for j, (x, y, rw, rh) in enumerate(rects):
                xx = col + (j % columns if columns else j)
                yy = row + (j // columns if columns else 0)
                packed.paste(image.crop((x, y, x + rw, y + rh)).convert('RGBA'), (xx*cw, yy*ch))
        packed.save(f'page-{i}.png')
`;

const LIMIT = 4096;

// One animation must fit in a single native atlas source. Static tiles do not
// need repacking when the original atlas already matches Godot's regular grid.
export function godotAtlasFits(payload: CornerTilesetPayload | SideTilesetPayload): boolean {
  const [w, h] = payload.cellSize;
  return w <= LIMIT && h <= LIMIT && payload.tiles.every((tile) => tile.frames.length <= Math.floor(LIMIT / w) * Math.floor(LIMIT / h));
}

function nativeGrid(payload: CornerTilesetPayload | SideTilesetPayload): AtlasPage | null {
  const { margin, spacing } = payload.atlas;
  const [w, h] = payload.cellSize;
  const occupied = new Set<string>();
  const tiles: AtlasTile[] = [];
  for (const tile of payload.tiles) {
    if (tile.frames.length > 1) return null;
    const [left, top] = tile.frames[0]?.rect ?? tile.rect;
    const x = (left - margin) / (w + spacing);
    const y = (top - margin) / (h + spacing);
    if (x < 0 || y < 0 || x > 32767 || y > 32767 || !Number.isInteger(x) || !Number.isInteger(y)) return null;
    const key = `${x}:${y}`;
    if (occupied.has(key)) return null;
    occupied.add(key);
    tiles.push({ tile, coords: [x, y], columns: 0 });
  }
  return { margin, spacing, tiles };
}

export async function godotAtlasPages(
  input: TargetInput,
  name: string,
  payload: CornerTilesetPayload | SideTilesetPayload,
  bytes: Uint8Array,
): Promise<AtlasPage[]> {
  const original = nativeGrid(payload);
  if (original) return [original];
  if (!godotAtlasFits(payload)) throw new Error("Godot atlas animation exceeds one texture page");
  const [w, h] = payload.cellSize;
  const totalFrames = payload.tiles.reduce((sum, tile) => sum + Math.max(tile.frames.length, 1), 0);
  const maxCols = Math.floor(LIMIT / w);
  const maxRows = Math.floor(LIMIT / h);
  const cols = Math.min(maxCols, Math.max(Math.ceil(Math.sqrt(totalFrames * h / w)), Math.ceil(Math.min(totalFrames, maxCols * maxRows) / maxRows)));
  const pages: AtlasPage[] = [];
  const layout: { size: Size; cell: Size; tiles: [number, number, number, Rect[]][] }[] = [];
  let page: AtlasTile[] = [];
  let spec: [number, number, number, Rect[]][] = [];
  let cursor = 0;
  let usedCols = 0;
  function finishPage() {
    pages.push({ margin: 0, spacing: 0, tiles: page });
    layout.push({ size: [usedCols * w, Math.ceil(cursor / cols) * h], cell: payload.cellSize, tiles: spec });
    page = [];
    spec = [];
    cursor = 0;
    usedCols = 0;
  }
  for (const tile of payload.tiles) {
    const rects = tile.frames.length ? tile.frames.map(({ rect }) => rect) : [tile.rect];
    // A run that wraps rows must start at x=0 for Godot's animation_columns.
    const start = cursor % cols + rects.length > cols ? Math.ceil(cursor / cols) * cols : cursor;
    if (start + rects.length > cols * maxRows) finishPage();
    else cursor = start;
    const coords: Size = [cursor % cols, Math.floor(cursor / cols)];
    const columns = rects.length > cols ? cols : 0;
    page.push({ tile, coords, columns });
    spec.push([coords[0], coords[1], columns, rects]);
    usedCols = Math.max(usedCols, columns || coords[0] + rects.length);
    cursor += rects.length;
  }
  if (page.length) finishPage();

  const cwd = join(input.workDir, name);
  await mkdir(cwd, { recursive: true });
  await Promise.all([writeFile(join(cwd, "layout.json"), JSON.stringify(layout)), writeFile(join(cwd, "source.png"), bytes)]);
  await repack(input.python, ["-I", "-c", PACK], {
    cwd,
    env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "" },
    signal: input.signal,
    timeout: input.timeoutMs,
    killSignal: "SIGKILL",
  });
  for (const [i, result] of pages.entries()) result.bytes = await readFile(join(cwd, `page-${i}.png`));
  return pages;
}
