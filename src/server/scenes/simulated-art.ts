import { createHash } from "node:crypto";
import type { Capability, PlanOperation } from "@/contracts";
import { isFloor, roomGrid } from "@/domain/scenes/room";
import { createImage, encodePng, getPixel, type Rgba, type RgbaImage, setPixel } from "@/lib/media/png";
import type { ProviderImage, ProviderSubmitRequest } from "../providers/types";

/**
 * Respostas do provedor SIMULADO para o cartão T2, identificadas como
 * simuladas na interface: cena plana, plano de paralaxe, sala pintada sobre a
 * guia da planta (com uma mesa e sombra para o recorte local) e prop.
 */

interface RoomJob {
  theme: string;
  floorPlan: { size: [number, number]; cells: boolean[] };
  doors: { doorId: string; cell: [number, number]; side: "N" | "E" | "S" | "W" }[];
  projection: "top_down" | "isometric" | "oblique";
  tileSize: number;
  backgroundKey: string;
  pictureSize: [number, number];
}

export interface SimulatedSceneJob {
  operation: PlanOperation;
  prompt: string;
  params: Record<string, unknown>;
  room?: RoomJob;
}

const SIMULATED_SCENE_OPS: PlanOperation[] = ["generate_scene", "generate_room", "generate_map_object"];

export function isSimulatedSceneOperation(operation: PlanOperation): boolean {
  return SIMULATED_SCENE_OPS.includes(operation);
}

/** Mesmas capacidades de uma rota genérica de imagem com alfa, para ensaiar fila, publicação e revisão sem custo. */
export function simulatedSceneCapabilities(operation: PlanOperation): Capability[] {
  switch (operation) {
    case "generate_scene":
      return ["text_to_image", "image_references", "alpha_output"];
    case "generate_room":
      return ["text_to_image", "image_references"];
    case "generate_map_object":
      return ["text_to_image", "alpha_output"];
    default:
      return [];
  }
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Prepara o job simulado no envio (a sala guarda a planta e a guia declaradas no plano). */
export function simulatedSceneJob(request: Pick<ProviderSubmitRequest, "operation" | "prompt" | "params">): SimulatedSceneJob {
  const p = request.params;
  if (request.operation === "generate_room") {
    const guide = p.guide as { pictureSize: [number, number]; backgroundKey: string };
    const room: RoomJob = {
      theme: String(p.theme),
      floorPlan: p.floorPlan as RoomJob["floorPlan"],
      doors: p.doors as RoomJob["doors"],
      projection: p.projection as RoomJob["projection"],
      tileSize: Number(p.tileSize),
      backgroundKey: guide.backgroundKey,
      pictureSize: guide.pictureSize,
    };
    return { operation: request.operation, prompt: request.prompt, params: p, room };
  }
  return { operation: request.operation, prompt: request.prompt, params: p };
}

const png = (img: RgbaImage): ProviderImage => ({ bytes: encodePng(img), mime: "image/png" });

export function simulatedSceneResult(job: SimulatedSceneJob): ProviderImage[] {
  const p = job.params;
  switch (job.operation) {
    case "generate_scene": {
      const size = p.logicalSize as [number, number];
      const layer = p.layer as { depth: string; transparent: boolean; repeatX: boolean } | undefined;
      const key = (p.backgroundKey as string | null | undefined) ?? null;
      return [png(scale(layer ? sceneLayer(job.prompt, size, layer, key) : flatScene(job.prompt, size), 2))];
    }
    case "generate_room":
      return [png(scale(drawRoom(job.room!), 2))];
    case "generate_map_object": {
      const size = p.logicalSize as [number, number];
      const key = (p.backgroundKey as string | null) ?? null;
      return [png(scale(mapObject(job.prompt, size, key), 2))];
    }
    default:
      return [];
  }
}

function scale(img: RgbaImage, k: number): RgbaImage {
  if (k === 1) return img;
  const out = createImage(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) setPixel(out, x, y, getPixel(img, Math.floor(x / k), Math.floor(y / k)));
  return out;
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const mix = (a: Rgba, b: Rgba, t: number): Rgba => [clamp(a[0] + (b[0] - a[0]) * t), clamp(a[1] + (b[1] - a[1]) * t), clamp(a[2] + (b[2] - a[2]) * t), 255];

function hexRgba(hex: string): Rgba {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
}

/** Ruído periódico em x (período = largura): repete sem emenda por construção. */
function periodic(seed: number, x: number, w: number, harmonics = 3): number {
  let v = 0;
  for (let k = 1; k <= harmonics; k++) v += Math.sin((2 * Math.PI * k * x) / w + seed * (k + 1)) / k;
  return v;
}

// ---------------------------------------------------------------------------
// Cena plana e planos
// ---------------------------------------------------------------------------

function flatScene(prompt: string, [w, h]: [number, number]): RgbaImage {
  const d = digest(prompt);
  const img = createImage(w, h);
  const top: Rgba = [70, 50, 110, 255];
  const horizon: Rgba = [240, 150, 80, 255];
  const groundY = Math.floor(h * 0.72);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, mix(top, horizon, Math.min(1, y / groundY)));
  // Árvores ao fundo (silhueta), rio, margens e ponte.
  for (let x = 0; x < w; x++) {
    const crown = Math.floor(h * 0.45 + 8 * periodic(d[0]! / 40, x, w, 4));
    for (let y = crown; y < groundY; y++) setPixel(img, x, y, [40, 60, 50, 255]);
  }
  for (let y = groundY; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const river = Math.abs(x - w / 2) < w * 0.18;
      setPixel(img, x, y, river ? mix([50, 80, 140, 255], [200, 120, 90, 255], ((x + y) % 7) / 20) : [60, 90, 50, 255]);
    }
  }
  const deck = groundY - 4;
  for (let x = Math.floor(w * 0.28); x < Math.ceil(w * 0.72); x++) {
    for (let y = deck; y < deck + 3; y++) setPixel(img, x, y, [120, 80, 50, 255]);
    if (x % 6 === 0) for (let y = deck - 6; y < deck; y++) setPixel(img, x, y, [100, 66, 40, 255]);
  }
  return img;
}

function sceneLayer(prompt: string, [w, h]: [number, number], layer: { depth: string; transparent: boolean }, key: string | null): RgbaImage {
  const d = digest(prompt);
  const img = createImage(w, h);
  const empty: Rgba = layer.transparent ? (key ? hexRgba(key) : [0, 0, 0, 0]) : [0, 0, 0, 0];
  const seed = d[0]! / 30;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let c: Rgba | null = null;
      if (layer.depth === "sky") {
        // Ruído por pixel (não só faixas do degradê): a grade de pixel art aparece para o unzoom.
        const n = ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 5) * 8;
        c = mix([60 + n, 50 + n, 110 + n, 255], [245, 160 + n, 90 + n, 255], y / h);
        if (Math.abs(y - h * 0.25 - 3 * periodic(seed, x, w, 2)) < 2) c = mix(c, [255, 220, 200, 255], 0.5);
      } else if (layer.depth === "far") {
        if (y > h * 0.4 + h * 0.12 * periodic(seed, x, w, 2)) c = [90, 70, 120, 255];
      } else if (layer.depth === "mid") {
        if (y > h * 0.55 + h * 0.08 * periodic(seed, x, w, 5)) c = [50, 80, 60, 255];
      } else {
        const top = Math.floor(h * 0.8);
        if (y >= top) c = y === top ? [90, 150, 60, 255] : mix([110, 80, 50, 255], [80, 60, 40, 255], ((x * 7 + y * 3) % 11) / 11);
      }
      setPixel(img, x, y, c ?? (layer.transparent ? empty : [60, 50, 110, 255]));
    }
  }
  return img;
}

function mapObject(prompt: string, [w, h]: [number, number], key: string | null): RgbaImage {
  const d = digest(prompt);
  const img = createImage(w, h);
  const bg: Rgba = key ? hexRgba(key) : [0, 0, 0, 0];
  const body: Rgba = [100 + (d[0]! % 80), 70 + (d[1]! % 60), 40, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x > w * 0.2 && x < w * 0.8 && y > h * 0.25 && y < h * 0.95;
      const edge = inside && (x < w * 0.2 + 2 || x > w * 0.8 - 3 || y < h * 0.25 + 2 || y > h * 0.95 - 3);
      setPixel(img, x, y, inside ? (edge ? [30, 20, 20, 255] : body) : bg);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// Sala simulada
// ---------------------------------------------------------------------------

/** Sala pintada na grade da guia: rocha na cor-chave, piso, paredes, portas e uma mesa com sombra. */
function drawRoom(room: RoomJob): RgbaImage {
  const grid = roomGrid(room.projection, room.tileSize, room.floorPlan.size);
  const size = room.pictureSize;
  const img = createImage(size[0], size[1]);
  const rock = hexRgba(room.backgroundKey);
  for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) setPixel(img, x, y, rock);
  const d = digest(room.theme);
  const wood: Rgba = [140 + (d[0]! % 40), 100 + (d[1]! % 30), 60, 255];
  const wall: Rgba = [90, 80, 96, 255];
  const [cols, rows] = room.floorPlan.size;
  const [cw, ch] = grid.cellPx;
  const [ox, oy] = grid.gridOrigin;
  const fill = (x0: number, y0: number, w: number, h: number, c: Rgba | ((x: number, y: number) => Rgba)) => {
    for (let y = Math.max(0, y0); y < Math.min(size[1], y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(size[0], x0 + w); x++) setPixel(img, x, y, typeof c === "function" ? c(x, y) : c);
  };
  const plank = (x: number, y: number): Rgba => mix(wood, [70, 50, 30, 255], (y % 8 === 0 ? 0.5 : 0) + ((x * 3 + Math.floor(y / 8) * 11) % 13) / 60);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isFloor(room.floorPlan, c, r)) continue;
      if (room.projection === "isometric") {
        for (let y = 0; y < ch; y++) {
          const half = Math.floor(((y < ch / 2 ? y + 0.5 : ch - y - 0.5) * cw) / ch);
          const tx = ox + ((c - r) * cw) / 2;
          const ty = oy + ((c + r) * ch) / 2;
          fill(Math.round(tx - half), Math.round(ty + y), 2 * half, 1, plank);
        }
        if (!isFloor(room.floorPlan, c, r - 1)) for (let k = 0; k < cw / 2; k++) fill(Math.round(ox + ((c - r) * cw) / 2 + k), Math.round(oy + ((c + r) * ch) / 2 + k / 2 - 3 * ch), 1, 3 * ch, wall);
        if (!isFloor(room.floorPlan, c - 1, r)) for (let k = 0; k < cw / 2; k++) fill(Math.round(ox + ((c - r) * cw) / 2 - k - 1), Math.round(oy + ((c + r) * ch) / 2 + k / 2 - 3 * ch), 1, 3 * ch, wall);
        continue;
      }
      const x0 = ox + c * cw;
      const y0 = oy + r * ch;
      fill(x0, y0, cw, ch, plank);
      if (!isFloor(room.floorPlan, c, r - 1)) fill(x0 - cw / 2, y0 - ch, cw * 2, ch, (x, y) => mix(wall, [60, 54, 66, 255], (y - (y0 - ch)) / ch));
      if (!isFloor(room.floorPlan, c - 1, r)) fill(x0 - cw / 2, y0 - (room.projection === "oblique" ? ch / 2 : 0), cw / 2, ch, wall);
      if (!isFloor(room.floorPlan, c + 1, r)) fill(x0 + cw, y0, cw / 2, ch, wall);
      if (!isFloor(room.floorPlan, c, r + 1)) fill(x0 - cw / 2, y0 + ch, cw * 2, cw / 2, [70, 62, 74, 255]);
    }
  }
  for (const door of room.doors) {
    if (room.projection === "isometric") continue;
    const [c, r] = door.cell;
    const x0 = ox + c * cw;
    const y0 = oy + r * ch;
    if (door.side === "N") fill(x0 + cw / 4, y0 - ch + 4, cw / 2, ch - 4, [60, 36, 24, 255]);
    else if (door.side === "S") fill(x0, y0 + ch, cw, cw / 2, plank);
    else if (door.side === "W") fill(x0 - cw / 2, y0, cw / 2, 2 * ch, plank);
    else fill(x0 + cw, y0, cw / 2, 2 * ch, plank);
  }
  if (room.projection !== "oblique") {
    // Mesa na célula de piso mais próxima do centro, com sombra pintada embaixo/à direita.
    const floor = room.floorPlan.cells.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const center = [(cols - 1) / 2, (rows - 1) / 2];
    const best = floor.sort((a, b) => Math.hypot((a % cols) - center[0]!, Math.floor(a / cols) - center[1]!) - Math.hypot((b % cols) - center[0]!, Math.floor(b / cols) - center[1]!))[0]!;
    const [c, r] = [best % cols, Math.floor(best / cols)];
    const tw = Math.round(cw * 0.8);
    const th = Math.round(ch * 0.55);
    const table = createImage(tw, th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) setPixel(table, x, y, y < 3 ? [150, 90, 50, 255] : x < 2 || x >= tw - 2 ? [70, 40, 25, 255] : y < th - 2 ? [110, 66, 38, 255] : [0, 0, 0, 0]);
    const cx = room.projection === "isometric" ? ox + ((c - r) * cw) / 2 : ox + c * cw + cw / 2;
    const cy = room.projection === "isometric" ? oy + ((c + r) * ch) / 2 + ch / 2 : oy + r * ch + ch * 0.75;
    const tx = Math.round(cx - tw / 2);
    const ty = Math.round(cy - th);
    const sx = tx + 2;
    const sy = ty + th - 2;
    for (let y = 0; y < 3; y++) for (let x = 0; x < tw; x++) if (sx + x < size[0] && sy + y < size[1]) setPixel(img, sx + x, sy + y, mix(getPixel(img, sx + x, sy + y), [0, 0, 0, 255], 0.38));
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) if (getPixel(table, x, y)[3] > 0) setPixel(img, tx + x, ty + y, getPixel(table, x, y));
  }
  return img;
}
