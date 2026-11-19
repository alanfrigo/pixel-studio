/**
 * Fonte de PRÉVIA embutida (3×5 com zona de acento e cedilha, avanço 4 px,
 * altura de linha 8 px). Serve para medir e desenhar legendas na bancada sem
 * depender de uma fonte do jogo; não é exportada nem substitui a fonte pixel
 * gerada (cartão D1). Minúsculas usam o desenho das maiúsculas.
 */

export const PREVIEW_FONT = { advance: 4, glyphWidth: 3, glyphHeight: 5, lineHeight: 8 } as const;

/** Glifos base em 5 linhas de 3 colunas ("#" = pixel). */
const BASE: Record<string, string> = {
  A: ".#.|#.#|###|#.#|#.#",
  B: "##.|#.#|##.|#.#|##.",
  C: ".##|#..|#..|#..|.##",
  D: "##.|#.#|#.#|#.#|##.",
  E: "###|#..|##.|#..|###",
  F: "###|#..|##.|#..|#..",
  G: ".##|#..|#.#|#.#|.##",
  H: "#.#|#.#|###|#.#|#.#",
  I: "###|.#.|.#.|.#.|###",
  J: "..#|..#|..#|#.#|.#.",
  K: "#.#|#.#|##.|#.#|#.#",
  L: "#..|#..|#..|#..|###",
  M: "#.#|###|###|#.#|#.#",
  N: "##.|#.#|#.#|#.#|#.#",
  O: ".#.|#.#|#.#|#.#|.#.",
  P: "##.|#.#|##.|#..|#..",
  Q: ".#.|#.#|#.#|##.|.##",
  R: "##.|#.#|##.|#.#|#.#",
  S: ".##|#..|.#.|..#|##.",
  T: "###|.#.|.#.|.#.|.#.",
  U: "#.#|#.#|#.#|#.#|###",
  V: "#.#|#.#|#.#|#.#|.#.",
  W: "#.#|#.#|###|###|#.#",
  X: "#.#|#.#|.#.|#.#|#.#",
  Y: "#.#|#.#|.#.|.#.|.#.",
  Z: "###|..#|.#.|#..|###",
  "0": "###|#.#|#.#|#.#|###",
  "1": ".#.|##.|.#.|.#.|###",
  "2": "##.|..#|.#.|#..|###",
  "3": "##.|..#|.#.|..#|##.",
  "4": "#.#|#.#|###|..#|..#",
  "5": "###|#..|##.|..#|##.",
  "6": ".##|#..|###|#.#|###",
  "7": "###|..#|.#.|.#.|.#.",
  "8": "###|#.#|###|#.#|###",
  "9": "###|#.#|###|..#|##.",
  " ": "...|...|...|...|...",
  ".": "...|...|...|...|.#.",
  ",": "...|...|...|.#.|#..",
  "!": ".#.|.#.|.#.|...|.#.",
  "?": "##.|..#|.#.|...|.#.",
  ":": "...|.#.|...|.#.|...",
  ";": "...|.#.|...|.#.|#..",
  "-": "...|...|###|...|...",
  "+": "...|.#.|###|.#.|...",
  "=": "...|###|...|###|...",
  "'": ".#.|.#.|...|...|...",
  '"': "#.#|#.#|...|...|...",
  "(": "..#|.#.|.#.|.#.|..#",
  ")": "#..|.#.|.#.|.#.|#..",
  "/": "..#|..#|.#.|#..|#..",
  "%": "#.#|..#|.#.|#..|#.#",
  "_": "...|...|...|...|###",
  "<": "..#|.#.|#..|.#.|..#",
  ">": "#..|.#.|..#|.#.|#..",
  "#": "#.#|###|#.#|###|#.#",
  "*": "...|#.#|.#.|#.#|...",
  "&": ".#.|#.#|.#.|#.#|.##",
  "…": "...|...|...|...|#.#",
  "—": "...|...|###|...|...",
  "–": "...|...|###|...|...",
};

/** Diacríticos nas duas linhas acima do glifo. */
const MARKS: Record<string, string> = {
  acute: "..#|.#.",
  grave: "#..|.#.",
  circumflex: ".#.|#.#",
  tilde: ".##|##.",
  diaeresis: "...|#.#",
};

const ACCENTED: Record<string, [string, keyof typeof MARKS]> = {
  á: ["A", "acute"],
  à: ["A", "grave"],
  â: ["A", "circumflex"],
  ã: ["A", "tilde"],
  ä: ["A", "diaeresis"],
  é: ["E", "acute"],
  è: ["E", "grave"],
  ê: ["E", "circumflex"],
  ë: ["E", "diaeresis"],
  í: ["I", "acute"],
  ì: ["I", "grave"],
  î: ["I", "circumflex"],
  ï: ["I", "diaeresis"],
  ó: ["O", "acute"],
  ò: ["O", "grave"],
  ô: ["O", "circumflex"],
  õ: ["O", "tilde"],
  ö: ["O", "diaeresis"],
  ú: ["U", "acute"],
  ù: ["U", "grave"],
  û: ["U", "circumflex"],
  ü: ["U", "diaeresis"],
  ñ: ["N", "tilde"],
};

const MISSING = "###|#.#|#.#|#.#|###";

/**
 * Bitmap de 3×8 de um caractere: linhas 0–1 = acento, 2–6 = glifo, 7 = cedilha.
 * Caractere desconhecido vira caixa (glifo ausente visível, não substituição silenciosa).
 */
export function previewGlyph(ch: string): { rows: string[]; known: boolean } {
  const lower = ch.toLowerCase();
  const accent = ACCENTED[lower];
  const cedilla = lower === "ç";
  const baseKey = accent ? accent[0] : cedilla ? "C" : ch.toUpperCase();
  const base = BASE[baseKey];
  const glyph = (base ?? MISSING).split("|");
  const marks = accent ? MARKS[accent[1]]!.split("|") : ["...", "..."];
  return { rows: [...marks, ...glyph, cedilla ? ".#." : "..."], known: base !== undefined };
}

/** Largura em pixels de uma linha na fonte de prévia. */
export function previewTextWidth(text: string): number {
  const n = [...text].length;
  return n === 0 ? 0 : n * PREVIEW_FONT.advance - (PREVIEW_FONT.advance - PREVIEW_FONT.glyphWidth);
}

/** Caracteres sem glifo na fonte de prévia (diagnóstico visível). */
export function previewMissingGlyphs(text: string): string[] {
  return [...new Set([...text].filter((c) => c !== "\n" && !previewGlyph(c).known))];
}
