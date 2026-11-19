import { createImage, fillRect, setPixel, type Rgba, type RgbaImage } from "@/lib/media/png";
import { encodeWavPcm16 } from "@/lib/media/wav";

/**
 * Arte sintética da clareira (README · cena de teste). Pixels conhecidos e
 * assimétricos, sem material de terceiros. Tudo é determinístico.
 */

export const C = {
  clear: [0, 0, 0, 0],
  outline: [20, 20, 28, 255],
  skin: [224, 172, 105, 255],
  tunic: [60, 90, 160, 255],
  boots: [70, 45, 30, 255],
  steel: [200, 200, 212, 255],
  wood: [150, 90, 40, 255],
  mail: [140, 140, 152, 255],
  mailDark: [100, 100, 112, 255],
  spark: [255, 230, 90, 255],
  sparkSoft: [255, 230, 90, 128],
  sparkFaint: [255, 230, 90, 64],
  glass: [180, 230, 200, 255],
  potion: [60, 200, 90, 255],
  shadow: [0, 0, 0, 96],
  grass: [70, 150, 60, 255],
  grassDark: [55, 125, 48, 255],
  water: [50, 100, 200, 255],
  waterLight: [90, 140, 225, 255],
  metal: [52, 56, 66, 255],
  copper: [184, 115, 51, 255],
  hover: [72, 78, 92, 255],
  pressed: [38, 40, 48, 255],
  disabled: [90, 90, 90, 255],
  focus: [255, 214, 0, 255],
  track: [30, 18, 18, 255],
  fill: [200, 40, 40, 255],
  white: [255, 255, 255, 255],
} as const satisfies Record<string, Rgba>;

// ---------------------------------------------------------------------------
// Guerreiro (vista S, célula 64×64, chão em y = 60)
// ---------------------------------------------------------------------------

function drawBody(img: RgbaImage, ox: number, lean: number) {
  fillRect(img, ox + 26 + lean, 10, 12, 12, C.skin); // cabeça
  fillRect(img, ox + 24 + lean, 22, 16, 20, C.tunic); // tronco
  fillRect(img, ox + 25, 42, 6, 16, C.tunic); // perna esquerda (tela)
  fillRect(img, ox + 33, 42, 6, 16, C.tunic); // perna direita (tela)
  fillRect(img, ox + 25, 58, 6, 2, C.boots);
  fillRect(img, ox + 33, 58, 6, 2, C.boots);
  fillRect(img, ox + 18 + lean, 24, 6, 14, C.skin); // braço com escudo
  fillRect(img, ox + 40 + lean, 24, 6, 12, C.skin); // braço da espada
  // Escudo só de um lado: arte assimétrica de propósito (não espelhar).
  fillRect(img, ox + 12 + lean, 26, 8, 12, C.wood);
  setPixel(img, ox + 15 + lean, 31, C.outline);
}

export function warriorBase(): RgbaImage {
  const img = createImage(64, 64);
  drawBody(img, 0, 0);
  fillRect(img, 42, 14, 2, 20, C.steel); // espada em repouso
  return img;
}

/** Ataque com escudo: windup, advance, contact, recover (140/80/60/160 ms). */
export const ATTACK_FRAMES = [
  { frameId: "windup", durationMs: 140, lean: -1, sword: [44, 6, 2, 22], hand: [43, 28] },
  { frameId: "advance", durationMs: 80, lean: 0, sword: [44, 16, 12, 2], hand: [42, 30] },
  { frameId: "contact", durationMs: 60, lean: 1, sword: [46, 34, 16, 2], hand: [39, 34] },
  { frameId: "recover", durationMs: 160, lean: 0, sword: [42, 34, 2, 18], hand: [41, 33] },
] as const;

export function warriorAttackStrip(): RgbaImage {
  const img = createImage(64 * ATTACK_FRAMES.length, 64);
  ATTACK_FRAMES.forEach((f, i) => {
    const ox = i * 64;
    drawBody(img, ox, f.lean);
    const [x, y, w, h] = f.sword;
    fillRect(img, ox + x, y, w, h, C.steel);
  });
  return img;
}

/** Cota: torso 20×16 por frame (linha 0) e manga próxima 8×12 (linha 1, sem o frame `contact`). */
export const MAIL = {
  torso: { size: [20, 16] as const, offset: [22, 22] as const },
  sleeve: { size: [8, 12] as const, offset: [40, 24] as const, frames: ["windup", "advance", "recover"] as const },
};

export function chainmailAtlas(): RgbaImage {
  const img = createImage(80, 28);
  ATTACK_FRAMES.forEach((_, i) => {
    fillRect(img, i * 20, 0, 20, 16, C.mail);
    for (let y = 1; y < 16; y += 3) for (let x = 1 + (y % 2); x < 20; x += 3) setPixel(img, i * 20 + x, y, C.mailDark);
    setPixel(img, i * 20 + i, 15, C.outline); // marca do frame
  });
  MAIL.sleeve.frames.forEach((_, i) => {
    fillRect(img, i * 8, 16, 8, 12, C.mail);
    setPixel(img, i * 8 + 1, 17, C.mailDark);
  });
  return img;
}

// ---------------------------------------------------------------------------
// Faísca (02a §exemplo mínimo): atlas 16×8, faísca em (3,3); depois (11,2) e (12,3)
// ---------------------------------------------------------------------------

export function sparkAtlas(): RgbaImage {
  const img = createImage(16, 8);
  setPixel(img, 3, 3, C.spark);
  setPixel(img, 11, 2, C.sparkSoft); // alfa parcial 128
  setPixel(img, 12, 3, C.sparkFaint); // alfa parcial 64
  return img;
}

// ---------------------------------------------------------------------------
// Poção: ícone 16×16 em x = 0 e representação no chão 16×16 em x = 16
// ---------------------------------------------------------------------------

export function potionSheet(): RgbaImage {
  const img = createImage(32, 16);
  // Ícone
  fillRect(img, 6, 1, 4, 3, C.glass);
  fillRect(img, 4, 4, 8, 10, C.glass);
  fillRect(img, 5, 7, 6, 6, C.potion);
  setPixel(img, 6, 8, C.white);
  // Chão (menor, com sombra)
  fillRect(img, 19, 14, 10, 2, C.shadow);
  fillRect(img, 23, 5, 2, 2, C.glass);
  fillRect(img, 21, 7, 6, 7, C.glass);
  fillRect(img, 22, 9, 4, 4, C.potion);
  return img;
}

// ---------------------------------------------------------------------------
// Tileset grama ↔ água por cantos: 16 tiles 32×32, máscara m em (m % 4, m / 4)
// ---------------------------------------------------------------------------

export const CORNER_QUADRANTS = [
  { bit: 1, x: 0, y: 0 }, // NO
  { bit: 2, x: 16, y: 0 }, // NE
  { bit: 4, x: 16, y: 16 }, // SE
  { bit: 8, x: 0, y: 16 }, // SO
] as const;

export function grassWaterAtlas(): RgbaImage {
  const img = createImage(128, 128);
  for (let mask = 0; mask < 16; mask++) {
    const ox = (mask % 4) * 32;
    const oy = Math.floor(mask / 4) * 32;
    for (const q of CORNER_QUADRANTS) {
      const water = (mask & q.bit) !== 0;
      fillRect(img, ox + q.x, oy + q.y, 16, 16, water ? C.water : C.grass);
      // Textura determinística: pontos internos que nunca tocam a borda do tile.
      for (let i = 2; i < 14; i += 5) setPixel(img, ox + q.x + i, oy + q.y + ((i * 7) % 12) + 2, water ? C.waterLight : C.grassDark);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// UI: botão 32×16 (normal, hover, pressed, disabled, foco sobreposto)
// ---------------------------------------------------------------------------

export const BUTTON_CELLS = ["normal", "hover", "pressed", "disabled", "focus"] as const;

function drawButton(img: RgbaImage, ox: number, fill: Rgba) {
  fillRect(img, ox, 0, 32, 16, C.outline);
  fillRect(img, ox + 1, 1, 30, 14, fill);
  // Cantos chanfrados 4×4: transparentes na diagonal, filete de cobre.
  for (const [cx, cy, sx, sy] of [
    [0, 0, 1, 1],
    [31, 0, -1, 1],
    [0, 15, 1, -1],
    [31, 15, -1, -1],
  ] as const) {
    setPixel(img, ox + cx, cy, C.clear);
    setPixel(img, ox + cx + sx, cy, C.clear);
    setPixel(img, ox + cx, cy + sy, C.clear);
    setPixel(img, ox + cx + sx, cy + sy, C.copper);
    setPixel(img, ox + cx + 2 * sx, cy + sy, C.copper);
    setPixel(img, ox + cx + sx, cy + 2 * sy, C.copper);
  }
}

export function buttonAtlas(): RgbaImage {
  const img = createImage(32 * BUTTON_CELLS.length, 16);
  drawButton(img, 0, C.metal);
  drawButton(img, 32, C.hover);
  drawButton(img, 64, C.pressed);
  drawButton(img, 96, C.disabled);
  // Foco: só contorno, centro transparente (sobreposição sobre o estado atual).
  const ox = 128;
  fillRect(img, ox + 2, 0, 28, 1, C.focus);
  fillRect(img, ox + 2, 15, 28, 1, C.focus);
  fillRect(img, ox, 2, 1, 12, C.focus);
  fillRect(img, ox + 31, 2, 1, 12, C.focus);
  return img;
}

// ---------------------------------------------------------------------------
// Barra de vida 68×10: trilho, moldura e preenchimento 64×6 (área útil em [2,2])
// ---------------------------------------------------------------------------

export function meterAtlas(): RgbaImage {
  const img = createImage(68, 26);
  fillRect(img, 0, 0, 68, 10, C.track);
  fillRect(img, 0, 10, 68, 10, C.outline);
  fillRect(img, 2, 12, 64, 6, C.clear);
  setPixel(img, 0, 10, C.clear);
  setPixel(img, 67, 19, C.clear);
  fillRect(img, 0, 20, 64, 6, C.fill);
  for (let x = 0; x < 64; x += 8) setPixel(img, x, 20, C.white);
  return img;
}

// ---------------------------------------------------------------------------
// Fonte mínima: células 6×10, baseline em y = 8 (topo da célula 8 px acima)
// ---------------------------------------------------------------------------

export const FONT_CELL = [6, 10] as const;

export const FONT_GLYPHS: { char: string; rows: string[] }[] = [
  { char: "U", rows: [".....", "#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###.", ".....", "....."] },
  { char: "s", rows: [".....", ".....", ".....", ".####", "#....", ".###.", "....#", "####.", ".....", "....."] },
  { char: "a", rows: [".....", ".....", ".....", ".###.", "....#", ".####", "#...#", ".####", ".....", "....."] },
  { char: "r", rows: [".....", ".....", ".....", "#.##.", "##..#", "#....", "#....", "#....", ".....", "....."] },
  { char: "ç", rows: [".....", ".....", ".....", ".####", "#....", "#....", "#....", ".####", "..#..", ".##.."] },
  { char: "ã", rows: [".....", ".##.#", "#.##.", ".###.", "....#", ".####", "#...#", ".####", ".....", "....."] },
  { char: "?", rows: [".....", ".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#..", ".....", "....."] },
];

export function fontAtlas(): RgbaImage {
  const img = createImage(FONT_CELL[0] * FONT_GLYPHS.length, FONT_CELL[1]);
  FONT_GLYPHS.forEach((glyph, gi) => {
    glyph.rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === "#") setPixel(img, gi * FONT_CELL[0] + x, y, C.white);
      });
    });
  });
  return img;
}

// ---------------------------------------------------------------------------
// Som de impacto: 22 050 Hz, mono, 100 ms (2205 frames), onda quadrada decrescente
// ---------------------------------------------------------------------------

export const HIT_SFX = { sampleRate: 22_050, channels: 1, frameCount: 2205 } as const;

export function hitSfx(): Uint8Array {
  const { sampleRate, channels, frameCount } = HIT_SFX;
  const samples = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const sign = Math.floor(i / 25) % 2 === 0 ? 1 : -1;
    samples[i] = Math.trunc((sign * 12_000 * (frameCount - i)) / frameCount);
  }
  return encodeWavPcm16(samples, sampleRate, channels);
}
