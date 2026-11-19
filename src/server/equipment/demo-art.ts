import type { Direction, Rect } from "@/contracts";
import { createImage, type Rgba, type RgbaImage } from "@/lib/media/png";

/**
 * Arte sintética do caso do guerreiro (04 §caso de ponta a ponta), desenhada
 * em código para testes e para a demonstração: base limpa (mãos livres) em
 * quatro vistas, ataque com escudo (4 frames) e golpe de duas mãos (6 frames)
 * por vista, cota de malha em partes (torso e manga próxima), espada curta,
 * escudo e espada longa como vistas rígidas com empunhaduras. Determinística,
 * sem material de terceiros.
 */

export const PAL = {
  outline: [20, 20, 28, 255],
  skin: [224, 172, 105, 255],
  skinShade: [190, 138, 80, 255],
  hair: [96, 62, 34, 255],
  tunic: [60, 90, 160, 255],
  tunicDark: [42, 64, 120, 255],
  belt: [92, 58, 30, 255],
  boots: [70, 45, 30, 255],
  mail: [146, 146, 160, 255],
  mailDark: [98, 98, 112, 255],
  mailLight: [186, 186, 198, 255],
  steel: [208, 208, 220, 255],
  steelDark: [140, 140, 156, 255],
  gold: [214, 172, 64, 255],
  wood: [150, 92, 44, 255],
  woodDark: [106, 62, 28, 255],
  iron: [92, 96, 108, 255],
} as const satisfies Record<string, Rgba>;

export const CELL = 64;
export const GROUND = 60;

// ---------------------------------------------------------------------------
// Primitivas com recorte (nada estoura a imagem)
// ---------------------------------------------------------------------------

export function put(img: RgbaImage, x: number, y: number, c: Rgba) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0];
  img.data[i + 1] = c[1];
  img.data[i + 2] = c[2];
  img.data[i + 3] = c[3];
}

export function rect(img: RgbaImage, x: number, y: number, w: number, h: number, c: Rgba) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(img, xx, yy, c);
}

function alphaAt(img: RgbaImage, x: number, y: number): number {
  return x < 0 || y < 0 || x >= img.width || y >= img.height ? 0 : img.data[(y * img.width + x) * 4 + 3]!;
}

/** Contorno de 1 px em volta do que já foi desenhado (pixel art legível em 1×). */
export function outline(img: RgbaImage, c: Rgba = PAL.outline) {
  const marks: [number, number][] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (alphaAt(img, x, y) > 0) continue;
      if (alphaAt(img, x - 1, y) || alphaAt(img, x + 1, y) || alphaAt(img, x, y - 1) || alphaAt(img, x, y + 1)) marks.push([x, y]);
    }
  }
  for (const [x, y] of marks) put(img, x, y, c);
}

/** Segmento grosso (pincel quadrado) entre dois pontos. */
export function stroke(img: RgbaImage, a: readonly [number, number], b: readonly [number, number], c: Rgba, size = 3) {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
  const r = Math.floor(size / 2);
  for (let i = 0; i <= n; i++) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * i) / n);
    const y = Math.round(a[1] + ((b[1] - a[1]) * i) / n);
    rect(img, x - r, y - r, size, size, c);
  }
}

export function blit(dst: RgbaImage, src: RgbaImage, ox: number, oy: number) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      if (src.data[i + 3]! > 0) put(dst, ox + x, oy + y, [src.data[i]!, src.data[i + 1]!, src.data[i + 2]!, src.data[i + 3]!]);
    }
  }
}

/** Caixa do conteúdo (alfa > 0) como retângulo `[x, y, w, h]`, ou `null`. */
export function contentBox(img: RgbaImage): Rect | null {
  let [x0, y0, x1, y1] = [img.width, img.height, -1, -1];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (alphaAt(img, x, y) > 0) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

export function crop(img: RgbaImage, [x, y, w, h]: Rect): RgbaImage {
  const out = createImage(w, h);
  for (let yy = 0; yy < h; yy++) out.data.set(img.data.subarray(((y + yy) * img.width + x) * 4, ((y + yy) * img.width + x + w) * 4), yy * w * 4);
  return out;
}

/** Empacota imagens lado a lado numa linha; devolve o atlas e o retângulo de cada uma. */
export function packRow(images: readonly RgbaImage[]): { atlas: RgbaImage; rects: Rect[] } {
  const width = Math.max(1, images.reduce((n, i) => n + i.width, 0));
  const height = Math.max(1, ...images.map((i) => i.height));
  const atlas = createImage(width, height);
  const rects: Rect[] = [];
  let x = 0;
  for (const img of images) {
    blit(atlas, img, x, 0);
    rects.push([x, 0, img.width, img.height]);
    x += img.width;
  }
  return { atlas, rects };
}

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

export type Kind = "osh" | "th";
export type SwordView = "up" | "down" | "right" | "left";

export interface PoseFrame {
  frameId: string;
  durationMs: number;
  lean: number;
  crouch: number;
  /** Mãos anatômicas (índice de pixel na célula). */
  right: [number, number];
  left: [number, number];
  /** Vista rígida da arma e a posição na ordem de desenho (camadas da base: corpo 0, braço próximo 1). */
  weapon: SwordView;
  weaponDraw: number;
  /** Escudo (só no ataque com escudo): vista e ordem. */
  shield?: { view: "front" | "side"; draw: number };
  /** Manga próxima totalmente encoberta pela pose: célula vazia explícita. */
  sleeveHidden?: boolean;
  /** O braço próximo passa atrás da cabeça/tronco neste frame (vai para a camada do corpo). */
  nearArmBehind?: boolean;
}

export const OSH_FRAMES = [
  ["windup", 140],
  ["advance", 80],
  ["contact", 60],
  ["recover", 160],
] as const;
export const TH_FRAMES = [
  ["guard", 120],
  ["raise", 100],
  ["windup", 90],
  ["contact", 60],
  ["follow", 110],
  ["recover", 180],
] as const;

/** Distância da mão esquerda à direita no cabo da espada longa, por vista da arma. */
export const LONG_SPAN: Record<SwordView, [number, number]> = { up: [0, 3], down: [0, -3], right: [-3, 0], left: [3, 0] };

function th(frameId: string, durationMs: number, lean: number, crouch: number, right: [number, number], weapon: SwordView, weaponDraw: number, behind = false): PoseFrame {
  const span = LONG_SPAN[weapon];
  return { frameId, durationMs, lean, crouch, right, left: [right[0] + span[0], right[1] + span[1]], weapon, weaponDraw, ...(behind ? { sleeveHidden: true, nearArmBehind: true } : {}) };
}

function osh(frameId: string, durationMs: number, lean: number, crouch: number, right: [number, number], left: [number, number], weapon: SwordView, weaponDraw: number, shield: PoseFrame["shield"], behind = false): PoseFrame {
  return { frameId, durationMs, lean, crouch, right, left, weapon, weaponDraw, shield, ...(behind ? { sleeveHidden: true, nearArmBehind: true } : {}) };
}

const D = OSH_FRAMES;
const T = TH_FRAMES;

/**
 * Tabelas de pose por vista. S = de frente para a câmera (mão direita do
 * personagem à esquerda da tela); N = de costas; E/W = perfil. Mãos sempre
 * nomeadas pela anatomia, em todas as vistas.
 */
export const POSES: Record<Kind, Record<"N" | "E" | "S" | "W", PoseFrame[]>> = {
  osh: {
    S: [
      osh(D[0][0], D[0][1], -1, 0, [20, 21], [42, 36], "up", 0, { view: "front", draw: 2 }),
      osh(D[1][0], D[1][1], 0, 0, [21, 29], [42, 35], "up", 0, { view: "front", draw: 2 }),
      osh(D[2][0], D[2][1], 1, 1, [23, 38], [43, 35], "down", 0, { view: "front", draw: 2 }),
      osh(D[3][0], D[3][1], 0, 0, [22, 34], [42, 36], "up", 0, { view: "front", draw: 2 }),
    ],
    N: [
      // Golpe preparado atrás da cabeça: braço e manga encobertos (célula vazia explícita).
      osh(D[0][0], D[0][1], 1, 0, [36, 18], [21, 36], "up", -1, { view: "front", draw: -1 }, true),
      osh(D[1][0], D[1][1], 0, 0, [42, 27], [21, 35], "up", -1, { view: "front", draw: -1 }),
      osh(D[2][0], D[2][1], -1, 1, [40, 31], [20, 35], "up", -1, { view: "front", draw: -1 }),
      osh(D[3][0], D[3][1], 0, 0, [41, 34], [21, 36], "up", -1, { view: "front", draw: -1 }),
    ],
    E: [
      osh(D[0][0], D[0][1], -2, 0, [26, 21], [36, 34], "up", 0, { view: "side", draw: -1 }),
      osh(D[1][0], D[1][1], 0, 0, [35, 26], [37, 34], "up", 0, { view: "side", draw: -1 }),
      osh(D[2][0], D[2][1], 2, 1, [42, 33], [38, 34], "right", 0, { view: "side", draw: -1 }),
      osh(D[3][0], D[3][1], 1, 0, [36, 34], [37, 35], "up", 0, { view: "side", draw: -1 }),
    ],
    W: [
      osh(D[0][0], D[0][1], 2, 0, [37, 21], [27, 34], "up", -1, { view: "side", draw: 2 }),
      osh(D[1][0], D[1][1], 0, 0, [28, 26], [26, 34], "up", -1, { view: "side", draw: 2 }),
      osh(D[2][0], D[2][1], -2, 1, [21, 33], [25, 34], "left", -1, { view: "side", draw: 2 }),
      osh(D[3][0], D[3][1], -1, 0, [27, 34], [26, 35], "up", -1, { view: "side", draw: 2 }),
    ],
  },
  th: {
    S: [
      th(T[0][0], T[0][1], 0, 0, [29, 35], "up", 0),
      th(T[1][0], T[1][1], 0, -1, [27, 27], "up", 0),
      th(T[2][0], T[2][1], -1, 0, [23, 19], "up", 0),
      th(T[3][0], T[3][1], 1, 2, [30, 39], "down", 0),
      th(T[4][0], T[4][1], 2, 2, [35, 41], "down", 0),
      th(T[5][0], T[5][1], 0, 0, [29, 36], "up", 0),
    ],
    N: [
      th(T[0][0], T[0][1], 0, 0, [35, 34], "up", -1),
      th(T[1][0], T[1][1], 0, -1, [36, 27], "up", -1),
      th(T[2][0], T[2][1], 1, 0, [35, 16], "up", -1, true),
      th(T[3][0], T[3][1], -1, 2, [33, 30], "up", -1),
      th(T[4][0], T[4][1], -2, 2, [28, 33], "up", -1),
      th(T[5][0], T[5][1], 0, 0, [35, 35], "up", -1),
    ],
    E: [
      th(T[0][0], T[0][1], 0, 0, [37, 34], "up", 0),
      th(T[1][0], T[1][1], -1, -1, [33, 25], "up", 0),
      th(T[2][0], T[2][1], -2, 0, [27, 20], "up", 0),
      th(T[3][0], T[3][1], 2, 2, [41, 33], "right", 0),
      th(T[4][0], T[4][1], 3, 2, [43, 38], "down", 0),
      th(T[5][0], T[5][1], 1, 0, [38, 35], "up", 0),
    ],
    W: [
      th(T[0][0], T[0][1], 0, 0, [27, 34], "up", -1),
      th(T[1][0], T[1][1], 1, -1, [31, 25], "up", -1),
      th(T[2][0], T[2][1], 2, 0, [37, 20], "up", -1),
      th(T[3][0], T[3][1], -2, 2, [23, 33], "left", -1),
      th(T[4][0], T[4][1], -3, 2, [21, 38], "down", -1),
      th(T[5][0], T[5][1], -1, 0, [26, 35], "up", -1),
    ],
  },
};

// ---------------------------------------------------------------------------
// Corpo (base limpa): camada "body" (tudo menos o braço próximo) e "arm_near"
// ---------------------------------------------------------------------------

interface Geometry {
  torso: Rect;
  head: Rect;
  shoulderRight: [number, number];
  shoulderLeft: [number, number];
  /** Qual braço anatômico fica à frente nesta vista. */
  near: "right" | "left";
}

export function geometry(dir: Direction, pose: Pick<PoseFrame, "lean" | "crouch">): Geometry {
  const { lean, crouch } = pose;
  const profile = dir === "E" || dir === "W";
  const tw = profile ? 10 : 14;
  const tx = 32 - tw / 2 + lean;
  const ty = 24 + crouch;
  const torso: Rect = [tx, ty, tw, 17];
  const head: Rect = [32 - 5 + lean + (dir === "E" ? 1 : dir === "W" ? -1 : 0), 13 + crouch, 10, 10];
  let shoulderRight: [number, number];
  let shoulderLeft: [number, number];
  if (dir === "S") {
    shoulderRight = [tx + 1, ty + 2];
    shoulderLeft = [tx + tw - 2, ty + 2];
  } else if (dir === "N") {
    shoulderRight = [tx + tw - 2, ty + 2];
    shoulderLeft = [tx + 1, ty + 2];
  } else {
    shoulderRight = [32 + lean, ty + 2];
    shoulderLeft = [32 + lean + (dir === "E" ? 2 : -2), ty + 2];
  }
  const near = dir === "W" ? "left" : "right";
  return { torso, head, shoulderRight, shoulderLeft, near };
}

function elbow(shoulder: [number, number], hand: [number, number]): [number, number] {
  return [Math.round((shoulder[0] + hand[0]) / 2), Math.round((shoulder[1] + hand[1]) / 2) + 1];
}

function drawArm(img: RgbaImage, shoulder: [number, number], hand: [number, number]) {
  const e = elbow(shoulder, hand);
  stroke(img, shoulder, e, PAL.tunic, 3);
  stroke(img, e, hand, PAL.skin, 3);
  rect(img, hand[0] - 1, hand[1] - 1, 3, 3, PAL.skin);
  put(img, hand[0] + 1, hand[1] + 1, PAL.skinShade);
}

function drawTorsoHeadLegs(img: RgbaImage, dir: Direction, pose: Pick<PoseFrame, "lean" | "crouch">) {
  const g = geometry(dir, pose);
  const [tx, ty, tw, th] = g.torso;
  const profile = dir === "E" || dir === "W";
  // Pernas e botas (apoio fixo no chão: o pivô não "anda").
  const legTop = ty + th;
  const legs: [number, number][] = profile ? [[29, 5], [32, 5]] : [[26, 5], [33, 5]];
  for (const [lx, lw] of legs) {
    rect(img, lx, legTop, lw, GROUND - 2 - legTop, PAL.tunicDark);
    rect(img, lx - (profile && dir === "W" ? 1 : 0), GROUND - 2, lw + (profile ? 1 : 0), 2, PAL.boots);
  }
  // Tronco com cinto.
  rect(img, tx, ty, tw, th, PAL.tunic);
  rect(img, tx, ty + th - 4, tw, 2, PAL.belt);
  rect(img, tx + (dir === "N" ? 2 : tw - 3), ty + 2, 1, th - 7, PAL.tunicDark);
  // Cabeça: cabelo, rosto e olhos conforme a vista.
  const [hx, hy, hw, hh] = g.head;
  rect(img, hx, hy, hw, hh, PAL.skin);
  rect(img, hx, hy, hw, 3, PAL.hair);
  if (dir === "N") rect(img, hx, hy, hw, hh - 2, PAL.hair);
  if (dir === "S") {
    put(img, hx + 2, hy + 5, PAL.outline);
    put(img, hx + 7, hy + 5, PAL.outline);
  }
  if (dir === "E") {
    rect(img, hx, hy, 4, 7, PAL.hair);
    put(img, hx + 7, hy + 5, PAL.outline);
  }
  if (dir === "W") {
    rect(img, hx + hw - 4, hy, 4, 7, PAL.hair);
    put(img, hx + 2, hy + 5, PAL.outline);
  }
}

/** Camadas da base de um frame: `body` (com o braço distante) e `arm_near`. */
export function baseLayers(dir: Direction, pose: PoseFrame): { body: RgbaImage; arm: RgbaImage } {
  const g = geometry(dir, pose);
  const body = createImage(CELL, CELL);
  const far = g.near === "right" ? { shoulder: g.shoulderLeft, hand: pose.left } : { shoulder: g.shoulderRight, hand: pose.right };
  const near = g.near === "right" ? { shoulder: g.shoulderRight, hand: pose.right } : { shoulder: g.shoulderLeft, hand: pose.left };
  // Braço distante (e o próximo, quando passa atrás da cabeça) desenhado antes do tronco.
  drawArm(body, far.shoulder, far.hand);
  if (pose.nearArmBehind) drawArm(body, near.shoulder, near.hand);
  drawTorsoHeadLegs(body, dir, pose);
  outline(body);
  const arm = createImage(CELL, CELL);
  if (!pose.nearArmBehind) {
    drawArm(arm, near.shoulder, near.hand);
    outline(arm);
  }
  return { body, arm };
}

/** Vista parada da base limpa (mãos livres, junto ao corpo). */
export function baseView(dir: Direction): RgbaImage {
  const g = geometry(dir, { lean: 0, crouch: 0 });
  const rest: PoseFrame = {
    frameId: "rest",
    durationMs: 100,
    lean: 0,
    crouch: 0,
    right: [g.shoulderRight[0] + (dir === "S" ? -2 : dir === "N" ? 2 : 1), 38],
    left: [g.shoulderLeft[0] + (dir === "S" ? 2 : dir === "N" ? -2 : -1), 38],
    weapon: "up",
    weaponDraw: 0,
  };
  const { body, arm } = baseLayers(dir, rest);
  blit(body, arm, 0, 0);
  return body;
}

// ---------------------------------------------------------------------------
// Cota de malha: torso e manga próxima (célula inteira; recortadas depois)
// ---------------------------------------------------------------------------

function mailFill(img: RgbaImage, x: number, y: number, w: number, h: number) {
  rect(img, x, y, w, h, PAL.mail);
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x + ((yy - y) % 2); xx < x + w; xx += 2) put(img, xx, yy, (yy - y) % 4 < 2 ? PAL.mailDark : PAL.mailLight);
  }
}

export function mailTorso(dir: Direction, pose: PoseFrame): RgbaImage {
  const g = geometry(dir, pose);
  const [tx, ty, tw, th] = g.torso;
  const img = createImage(CELL, CELL);
  // Cobre do ombro até abaixo do cinto, 1 px mais larga que a túnica.
  mailFill(img, tx - 1, ty, tw + 2, th - 1);
  rect(img, tx - 1, ty + th - 2, tw + 2, 1, PAL.mailDark);
  outline(img);
  return img;
}

export function mailSleeve(dir: Direction, pose: PoseFrame): RgbaImage | null {
  if (pose.sleeveHidden) return null;
  const g = geometry(dir, pose);
  const shoulder = g.near === "right" ? g.shoulderRight : g.shoulderLeft;
  const hand = g.near === "right" ? pose.right : pose.left;
  const e = elbow(shoulder, hand);
  const img = createImage(CELL, CELL);
  stroke(img, shoulder, e, PAL.mail, 3);
  stroke(img, shoulder, [Math.round((shoulder[0] + e[0]) / 2), Math.round((shoulder[1] + e[1]) / 2)], PAL.mailLight, 1);
  outline(img);
  return img;
}

// ---------------------------------------------------------------------------
// Peças rígidas: vistas com empunhaduras (índice de pixel na imagem da vista)
// ---------------------------------------------------------------------------

export interface RigidArt {
  viewId: string;
  image: RgbaImage;
  grips: { socketId: string; at: [number, number] }[];
  mirrorAllowed?: boolean;
}

function rotateCW(img: RgbaImage): RgbaImage {
  const out = createImage(img.height, img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const o = (x * out.width + (out.width - 1 - y)) * 4;
      out.data.set(img.data.subarray(i, i + 4), o);
    }
  }
  return out;
}

function flipV(img: RgbaImage): RgbaImage {
  const out = createImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) out.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (img.height - 1 - y) * img.width * 4);
  return out;
}

/** Espada vertical, lâmina para cima: `length` de lâmina, guarda e cabo de `grip` px. */
function swordUp(blade: number, grip: number, width: number): RgbaImage {
  const w = width;
  const h = blade + 1 + grip + 1;
  const img = createImage(w, h);
  const cx = Math.floor(w / 2);
  rect(img, cx - 1, 1, 2, blade - 1, PAL.steel);
  rect(img, cx, 1, 1, blade - 1, PAL.steelDark);
  put(img, cx - 1, 0, PAL.steel);
  rect(img, 0, blade, w, 1, PAL.gold);
  rect(img, cx - 1, blade + 1, 2, grip, PAL.wood);
  rect(img, cx, blade + 1, 1, grip, PAL.woodDark);
  rect(img, cx - 1, blade + 1 + grip, 2, 1, PAL.gold);
  return img;
}

/**
 * Vistas de uma espada: `up`, `down` (arte desenhada à parte, não espelho),
 * `right` (horizontal) com espelho autorizado — a arte é simétrica no eixo da
 * lâmina, então `left` é o espelho de `right` (empunhadura em `W − 1 − x`).
 */
function swordViews(blade: number, grip: number, width: number, gripsUp: { socketId: string; dy: number }[]): RigidArt[] {
  // Margem de 1 px para o contorno; as empunhaduras andam junto.
  const raw = swordUp(blade, grip, width);
  const up = createImage(raw.width + 2, raw.height + 2);
  blit(up, raw, 1, 1);
  outline(up);
  const cx = Math.floor(width / 2) + 1;
  const upGrips = gripsUp.map((g) => ({ socketId: g.socketId, at: [cx - 1, blade + 2 + g.dy] as [number, number] }));
  const down = flipV(up);
  const downGrips = upGrips.map((g) => ({ socketId: g.socketId, at: [g.at[0], up.height - 1 - g.at[1]] as [number, number] }));
  const right = rotateCW(up);
  // Rotação horária: (x, y) → (H − 1 − y, x).
  const rightGrips = upGrips.map((g) => ({ socketId: g.socketId, at: [up.height - 1 - g.at[1], g.at[0]] as [number, number] }));
  return [
    { viewId: "up", image: up, grips: upGrips },
    { viewId: "down", image: down, grips: downGrips },
    { viewId: "right", image: right, grips: rightGrips, mirrorAllowed: true },
  ];
}

export function shortSwordViews(): RigidArt[] {
  return swordViews(12, 3, 5, [{ socketId: "hand_right", dy: 1 }]);
}

/** Espada longa: dupla empunhadura (mão direita perto da guarda, esquerda 3 px abaixo no cabo). */
export function longSwordViews(): RigidArt[] {
  return swordViews(20, 6, 7, [
    { socketId: "hand_right", dy: 1 },
    { socketId: "hand_left", dy: 4 },
  ]);
}

export function shieldViews(): RigidArt[] {
  const front = createImage(11, 13);
  rect(front, 1, 0, 9, 13, PAL.wood);
  rect(front, 0, 1, 11, 11, PAL.wood);
  for (let x = 2; x < 10; x += 3) rect(front, x, 1, 1, 11, PAL.woodDark);
  rect(front, 0, 6, 11, 1, PAL.iron);
  rect(front, 4, 5, 3, 3, PAL.iron);
  put(front, 5, 6, PAL.steel);
  outline(front);
  const side = createImage(4, 13);
  rect(side, 1, 0, 2, 13, PAL.wood);
  rect(side, 0, 5, 4, 3, PAL.iron);
  outline(side);
  return [
    { viewId: "front", image: front, grips: [{ socketId: "hand_left", at: [5, 6] }] },
    { viewId: "side", image: side, grips: [{ socketId: "hand_left", at: [1, 6] }] },
  ];
}

/** Vista da arma usada no frame: `left` = espelho autorizado de `right`. */
export function weaponPlacementView(view: SwordView): { viewId: "up" | "down" | "right"; mirrored: boolean } {
  return view === "left" ? { viewId: "right", mirrored: true } : { viewId: view, mirrored: false };
}
