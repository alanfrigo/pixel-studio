import type { Direction, StylePayload } from "@/contracts";
import { facingPhrase } from "@/domain/animation/directions";
import { colorName } from "@/domain/color-names";
import { background, lightPhrase } from "./prompts";

/**
 * Prompts das rotas genéricas do cartão S3 (03a §interpolação, edição de trecho
 * e correção; §estados e animação de objetos). O texto descreve a tarefa e o
 * papel de cada imagem numerada; grade, contagem, tempos e células vão como
 * dados do plano. Cores sempre por nome, nunca por código hexadecimal.
 */

type Lang = "pt-BR" | "en";

function grid(n: number, columns: number, rows: number, lang: Lang): string {
  const empty = columns * rows - n;
  return lang === "en"
    ? `a grid of ${columns} columns by ${rows} rows, read left to right and top to bottom${empty > 0 ? `; the last ${empty} cell(s) stay empty` : ""}`
    : `uma grade de ${columns} colunas por ${rows} linhas, lida da esquerda para a direita e de cima para baixo${empty > 0 ? `; a(s) última(s) ${empty} célula(s) ficam vazias` : ""}`;
}

function finish(style: StylePayload, key: string | null, lang: Lang): string {
  return lang === "en"
    ? `Pixel art with a dark outline of ${style.outline.widthPx} px and ${lightPhrase(style, "en")}. ${background(key, "en")} No grid lines, borders, numbers or text.`
    : `Pixel art com contorno escuro de ${style.outline.widthPx} px e ${lightPhrase(style, "pt-BR")}. ${background(key, "pt-BR")} Sem linhas de grade, molduras, números ou texto.`;
}

/** Estado: redesenha cada vista da folha de referência com a mudança, na mesma direção e apoio. */
export function compileStatePrompt(o: { lang: Lang; subject: string; isObject: boolean; directions: Direction[]; columns: number; rows: number; change: string; stateKey: string; style: StylePayload; backgroundKey: string | null }): string {
  const cells = o.directions.map((d, i) => `${i + 1} ${facingPhrase(d, o.lang)}`).join("; ");
  if (o.lang === "en") {
    return [
      `Image 1 shows the ${o.isObject ? "object" : "character"} ${o.subject} in ${grid(o.directions.length, o.columns, o.rows, "en")}, one view per cell: ${cells}.`,
      `Redraw every cell in a new visual state "${o.stateKey}": ${o.change}.`,
      "This is a state of the same identity, not a new design: keep materials, colors, proportions, scale, the direction of each cell and the ground position; only the described change happens.",
      "Keep the same grid, the same cell order and each figure centered in its own cell, never cut off.",
      finish(o.style, o.backgroundKey, "en"),
    ].join(" ");
  }
  return [
    `A imagem 1 mostra o ${o.isObject ? "objeto" : "personagem"} ${o.subject} em ${grid(o.directions.length, o.columns, o.rows, "pt-BR")}, uma vista por célula: ${cells}.`,
    `Redesenhe cada célula num novo estado visual "${o.stateKey}": ${o.change}.`,
    "É um estado da mesma identidade, não um desenho novo: mantenha materiais, cores, proporções, escala, a direção de cada célula e a posição no chão; só acontece a mudança descrita.",
    "Mantenha a mesma grade, a mesma ordem das células e cada figura centralizada na sua célula, sem cortar.",
    finish(o.style, o.backgroundKey, "pt-BR"),
  ].join(" ");
}

/** Animação de objeto por folha: quadros novos a partir da vista aprovada (e do alvo, no modo interpolação). */
export function compileObjectAnimationPrompt(o: { lang: Lang; subject: string; motion: string; frames: number; columns: number; rows: number; direction: Direction; endFrame: boolean; style: StylePayload; backgroundKey: string | null }): string {
  if (o.lang === "en") {
    return [
      `Pixel art animation sheet of the object from image 1 (${o.subject}) with ${o.frames} frames in ${grid(o.frames, o.columns, o.rows, "en")}, ${facingPhrase(o.direction, "en")}.`,
      `Motion: ${o.motion}.${o.endFrame ? " Image 2 is the final pose: the frames progress from image 1 toward image 2." : ""}`,
      "Image 1 is the starting pose and is not repeated as a frame: the first cell is the first change after it.",
      "Same object, materials, colors and scale in every frame; it stays on the same ground spot and never gets cut off. No human skeleton: only the parts of the object move.",
      finish(o.style, o.backgroundKey, "en"),
    ].join(" ");
  }
  return [
    `Folha de animação em pixel art do objeto da imagem 1 (${o.subject}) com ${o.frames} quadros em ${grid(o.frames, o.columns, o.rows, "pt-BR")}, ${facingPhrase(o.direction, "pt-BR")}.`,
    `Movimento: ${o.motion}.${o.endFrame ? " A imagem 2 é a pose final: os quadros avançam da imagem 1 para a imagem 2." : ""}`,
    "A imagem 1 é a pose inicial e não se repete como quadro: a primeira célula já é a primeira mudança depois dela.",
    "Mesmo objeto, materiais, cores e escala em todos os quadros; fica no mesmo ponto do chão e nunca é cortado. Sem esqueleto humano: só as partes do objeto se movem.",
    finish(o.style, o.backgroundKey, "pt-BR"),
  ].join(" ");
}

/** Interpolação por folha: só os intermediários, nunca os extremos. */
export function compileInterpolationPrompt(o: { lang: Lang; subject: string; transition: string; count: number; columns: number; rows: number; style: StylePayload; backgroundKey: string | null }): string {
  if (o.lang === "en") {
    return [
      `Image 1 is the start keyframe and image 2 the end keyframe of ${o.subject}.`,
      `Draw ${o.count} in-between frame(s) in ${grid(o.count, o.columns, o.rows, "en")}, in order from the start toward the end: ${o.transition}.`,
      "Do not draw image 1 or image 2 themselves: only the frames between them. Same identity, size, camera and ground position as the keyframes.",
      finish(o.style, o.backgroundKey, "en"),
    ].join(" ");
  }
  return [
    `A imagem 1 é o keyframe inicial e a imagem 2 o keyframe final de ${o.subject}.`,
    `Desenhe ${o.count} quadro(s) intermediário(s) em ${grid(o.count, o.columns, o.rows, "pt-BR")}, em ordem do início para o fim: ${o.transition}.`,
    "Não desenhe a imagem 1 nem a imagem 2: só os quadros entre elas. Mesma identidade, tamanho, câmera e posição no chão dos keyframes.",
    finish(o.style, o.backgroundKey, "pt-BR"),
  ].join(" ");
}

/** Edição de trecho por folha: a mesma mudança coerente em cada quadro selecionado. */
export function compileEditPrompt(o: { lang: Lang; subject: string; change: string; frameIds: string[]; columns: number; rows: number; style: StylePayload; backgroundKey: string | null }): string {
  const order = o.frameIds.map((id, i) => `${i + 1} ${id}`).join(", ");
  if (o.lang === "en") {
    return [
      `Image 1 is an animation excerpt of ${o.subject} with ${o.frameIds.length} frames in ${grid(o.frameIds.length, o.columns, o.rows, "en")} (frames in order: ${order}).`,
      `Apply this change consistently to every frame: ${o.change}.`,
      "Keep each frame's pose, position in the cell, size and timing; change only what the instruction asks. Return the same grid with the same frames.",
      finish(o.style, o.backgroundKey, "en"),
    ].join(" ");
  }
  return [
    `A imagem 1 é um trecho de animação de ${o.subject} com ${o.frameIds.length} quadros em ${grid(o.frameIds.length, o.columns, o.rows, "pt-BR")} (quadros em ordem: ${order}).`,
    `Aplique esta mudança de forma coerente em todos os quadros: ${o.change}.`,
    "Mantenha a pose de cada quadro, a posição na célula e o tamanho; mude só o que a instrução pede. Devolva a mesma grade com os mesmos quadros.",
    finish(o.style, o.backgroundKey, "pt-BR"),
  ].join(" ");
}

/** Roupa por folha: candidato vestido achatado (não separa a peça em camadas). */
export function compileOutfitPrompt(o: { lang: Lang; subject: string; frames: number; columns: number; rows: number; instructions: string | null; style: StylePayload; backgroundKey: string | null }): string {
  if (o.lang === "en") {
    return [
      `Image 1 is an animation of ${o.subject} with ${o.frames} frames in ${grid(o.frames, o.columns, o.rows, "en")}. Image 2 shows an outfit.`,
      "Dress the character in every frame with the outfit from image 2, following the volume and twist of each pose.",
      "Keep the head, skin, pose, position in the cell and size of every frame; hands that cross the body stay in front of the outfit.",
      ...(o.instructions ? [o.instructions] : []),
      finish(o.style, o.backgroundKey, "en"),
    ].join(" ");
  }
  return [
    `A imagem 1 é uma animação de ${o.subject} com ${o.frames} quadros em ${grid(o.frames, o.columns, o.rows, "pt-BR")}. A imagem 2 mostra uma roupa.`,
    "Vista o personagem em todos os quadros com a roupa da imagem 2, seguindo o volume e a torção de cada pose.",
    "Mantenha cabeça, pele, pose, posição na célula e tamanho de cada quadro; mãos que cruzam o corpo ficam à frente da roupa.",
    ...(o.instructions ? [o.instructions] : []),
    finish(o.style, o.backgroundKey, "pt-BR"),
  ].join(" ");
}

/** Correção de um quadro: alvo, guia com a região pintada e vizinhos só como contexto. */
export function compileCorrectionPrompt(o: { lang: Lang; instruction: string; markColor: string; fullMask: boolean; neighbors: number; style: StylePayload; backgroundKey: string | null }): string {
  const mark = colorName(o.markColor, o.lang);
  const neighborsEn = o.neighbors ? ` Image${o.neighbors > 1 ? "s 3 and 4 are" : " 3 is"} the neighboring frame${o.neighbors > 1 ? "s" : ""} of the animation, for context only: do not copy them.` : "";
  const neighborsPt = o.neighbors ? ` A${o.neighbors > 1 ? "s imagens 3 e 4 são os quadros vizinhos" : " imagem 3 é o quadro vizinho"} da animação, só como contexto: não os copie.` : "";
  if (o.lang === "en") {
    return [
      "Edit image 1, one pixel art animation frame.",
      o.fullMask ? `Image 2 is fully painted ${mark}: redraw the whole frame following this instruction: ${o.instruction}.` : `Image 2 is the same frame with the region to change painted flat ${mark}. Change only that region: ${o.instruction}.`,
      `${neighborsEn} Everything outside the region stays identical to image 1: same framing, size, pixel grid, colors and ${lightPhrase(o.style, "en")}.`,
      `Return the full frame, with no ${mark} left. ${background(o.backgroundKey, "en")} No frame and no text.`,
    ].join(" ");
  }
  return [
    "Edite a imagem 1, um quadro de animação em pixel art.",
    o.fullMask ? `A imagem 2 está toda pintada de ${mark}: redesenhe o quadro inteiro seguindo esta instrução: ${o.instruction}.` : `A imagem 2 é o mesmo quadro com a região a mudar pintada de ${mark} chapado. Mude só essa região: ${o.instruction}.`,
    `${neighborsPt} Tudo fora da região fica idêntico à imagem 1: mesmo enquadramento, tamanho, grade de pixels, cores e ${lightPhrase(o.style, "pt-BR")}.`,
    `Devolva o quadro inteiro, sem sobrar ${mark}. ${background(o.backgroundKey, "pt-BR")} Sem moldura e sem texto.`,
  ].join(" ");
}
