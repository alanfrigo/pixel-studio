import type { Direction, StylePayload } from "@/contracts";
import { facingPhrase } from "@/domain/animation/directions";
import { colorName } from "@/domain/color-names";

/**
 * Prompts de animação e vistas (03a §movimento, §rotações). O texto descreve a
 * tarefa e o papel de cada imagem numerada; geometria, tempos, poses e grade
 * vão como dados do plano. Cores sempre por nome: código hex no prompt vira
 * texto desenhado na imagem (achado da avaliação A1).
 */

type Lang = "pt-BR" | "en";

export function lightPhrase(style: StylePayload, lang: Lang): string {
  return lang === "en" ? `light coming from the ${style.lighting.lightFrom} of the screen` : `luz vinda de ${style.lighting.lightFrom} na tela`;
}

export function background(key: string | null, lang: Lang): string {
  if (!key) return lang === "en" ? "Transparent background." : "Fundo transparente.";
  const name = colorName(key, lang);
  return lang === "en" ? `Flat solid ${name} background across the whole image, no shadow on it.` : `Fundo chapado ${name} em toda a imagem, sem sombra sobre ele.`;
}

/** Folha de quadros pedida a uma rota genérica (texto ou guia de poses). */
export function compileSheetAnimationPrompt(o: {
  lang: Lang;
  subject: string;
  motion: string;
  frameIds: string[];
  columns: number;
  rows: number;
  direction: Direction;
  style: StylePayload;
  backgroundKey: string | null;
  poseGuide: boolean;
}): string {
  const n = o.frameIds.length;
  const empty = o.columns * o.rows - n;
  const order = o.frameIds.map((id, i) => `${i + 1} ${id}`).join(", ");
  if (o.lang === "en") {
    return [
      `Pixel art animation sheet with ${n} frames in a grid of ${o.columns} columns by ${o.rows} rows, read left to right and top to bottom${empty > 0 ? `; the last ${empty} cell(s) stay empty` : ""}.`,
      `Every frame shows the full character from image 1 (${o.subject}) with the same identity, outfit, colors, proportions and scale, ${facingPhrase(o.direction, "en")}.`,
      `Motion: ${o.motion}. Frames in order: ${order}.`,
      ...(o.poseGuide
        ? ["Image 2 is a pose guide with the same grid: in each cell a stick figure (red = the character's right side, blue = the left side) shows that frame's pose. Follow each cell's pose and do not draw the stick figures."]
        : []),
      "Same size and same ground line in every frame, each figure centered in its own cell and never cut off.",
      `Dark outline of ${o.style.outline.widthPx} px, ${lightPhrase(o.style, "en")} in every frame.`,
      `${background(o.backgroundKey, "en")} No grid lines, borders, numbers or text.`,
    ].join(" ");
  }
  return [
    `Folha de animação em pixel art com ${n} quadros numa grade de ${o.columns} colunas por ${o.rows} linhas, lida da esquerda para a direita e de cima para baixo${empty > 0 ? `; a(s) última(s) ${empty} célula(s) ficam vazias` : ""}.`,
    `Cada quadro mostra o personagem inteiro da imagem 1 (${o.subject}) com a mesma identidade, roupa, cores, proporções e escala, ${facingPhrase(o.direction, "pt-BR")}.`,
    `Movimento: ${o.motion}. Quadros em ordem: ${order}.`,
    ...(o.poseGuide
      ? ["A imagem 2 é uma guia de poses com a mesma grade: em cada célula um boneco de traço (vermelho = lado direito do personagem, azul = lado esquerdo) mostra a pose daquele quadro. Siga a pose de cada célula e não desenhe os bonecos de traço."]
      : []),
    "Mesmo tamanho e mesma linha de chão em todos os quadros, cada figura centralizada na sua célula, sem cortar.",
    `Contorno escuro de ${o.style.outline.widthPx} px e ${lightPhrase(o.style, "pt-BR")} em todos os quadros.`,
    `${background(o.backgroundKey, "pt-BR")} Sem linhas de grade, molduras, números ou texto.`,
  ].join(" ");
}

/** Nova vista por imagem + referência: arte nova da direção, sem espelhar nem girar. */
export function compileSheetViewPrompt(o: {
  lang: Lang;
  subject: string;
  from: Direction;
  to: Direction;
  asymmetries: string[];
  isometric: boolean;
  style: StylePayload;
  backgroundKey: string | null;
}): string {
  if (o.lang === "en") {
    return [
      `Draw the character from image 1 (${o.subject}) ${facingPhrase(o.to, "en")}. Image 1 shows it ${facingPhrase(o.from, "en")}.`,
      "This is new art for the new direction: draw the sides that become visible; do not mirror, flip or rotate the drawing.",
      ...(o.asymmetries.length ? [`Keep on the correct anatomical side: ${o.asymmetries.join("; ")}.`] : []),
      `Same identity, colors, proportions and scale; full body, standing, centered, never cut off${o.isometric ? ", in isometric camera" : ""}.`,
      `Pixel art with a dark outline of ${o.style.outline.widthPx} px and ${lightPhrase(o.style, "en")} (the light does not turn with the character).`,
      `${background(o.backgroundKey, "en")} No frame, label or text.`,
    ].join(" ");
  }
  return [
    `Desenhe o personagem da imagem 1 (${o.subject}) ${facingPhrase(o.to, "pt-BR")}. A imagem 1 o mostra ${facingPhrase(o.from, "pt-BR")}.`,
    "É arte nova da nova direção: desenhe os lados que passam a aparecer; não espelhe, não inverta e não gire o desenho.",
    ...(o.asymmetries.length ? [`Mantenha no lado anatômico correto: ${o.asymmetries.join("; ")}.`] : []),
    `Mesma identidade, cores, proporções e escala; corpo inteiro, de pé, centralizado, sem cortar${o.isometric ? ", em câmera isométrica" : ""}.`,
    `Pixel art com contorno escuro de ${o.style.outline.widthPx} px e ${lightPhrase(o.style, "pt-BR")} (a luz não gira com o personagem).`,
    `${background(o.backgroundKey, "pt-BR")} Sem moldura, rótulo ou texto.`,
  ].join(" ");
}
