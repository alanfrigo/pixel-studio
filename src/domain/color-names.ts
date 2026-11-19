/**
 * Nome aproximado de uma cor para prompts. Códigos hexadecimais no prompt
 * fazem modelos de imagem desenharem o texto (observado na qualificação de
 * 2026-11-18); nomes descrevem a intenção sem esse efeito.
 */

const HUES: { max: number; pt: string; en: string }[] = [
  { max: 15, pt: "vermelho", en: "red" },
  { max: 40, pt: "laranja", en: "orange" },
  { max: 65, pt: "amarelo", en: "yellow" },
  { max: 90, pt: "verde-limão", en: "lime" },
  { max: 160, pt: "verde", en: "green" },
  { max: 195, pt: "ciano", en: "cyan" },
  { max: 250, pt: "azul", en: "blue" },
  { max: 280, pt: "roxo", en: "purple" },
  { max: 335, pt: "magenta", en: "magenta" },
  { max: 360, pt: "vermelho", en: "red" },
];

export function colorName(hex: string, language: "pt-BR" | "en"): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  const pt = language === "pt-BR";
  if (s < 0.15 || max - min < 0.08) {
    if (l < 0.15) return pt ? "quase preto" : "near black";
    if (l > 0.9) return pt ? "branco" : "white";
    if (l > 0.75) return pt ? "creme claro" : "light cream";
    return pt ? (l < 0.45 ? "cinza escuro" : "cinza") : l < 0.45 ? "dark gray" : "gray";
  }
  let h = 0;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  const hue = HUES.find((x) => h <= x.max)!;
  const base = pt ? hue.pt : hue.en;
  if (h > 15 && h <= 40 && l < 0.45) return pt ? "marrom" : "brown";
  if (l < 0.3) return pt ? `${base} escuro` : `dark ${base}`;
  if (l > 0.75) return pt ? `${base} claro` : `light ${base}`;
  return base;
}
