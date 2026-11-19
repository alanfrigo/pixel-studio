import type { StylePayload, VisemeId } from "@/contracts";
import { colorName } from "@/domain/color-names";
import { tx } from "@/i18n/locales";
import { lightWords, paletteNames } from "../world/core";

/**
 * Núcleo do cartão D1 sem dependência das rotas HTTP: rótulos honestos de
 * cada rota e receitas de prompt. Nenhum provedor real declara retrato,
 * visemes ou fonte pixel nativos: tudo passa pela rota genérica (imagem +
 * referências ordenadas, guias raster) com a estrutura conferida localmente.
 */

export const DIALOGUE_ROUTE_LABELS = {
  portrait: tx(
    "Retrato por imagem + referência da vista aprovada do personagem (rota genérica): paleta, escala e regiões do rosto conferidas localmente e revisadas; não é operação nativa de retrato",
    "Portrait by image + reference of the approved character view (generic route): palette, scale and face regions checked locally and reviewed; not a native portrait operation",
  ),
  portraitReview: tx("Âncora facial e regiões do rosto/boca revisadas pelo artista (a imagem não muda)", "Face anchor and face/mouth regions reviewed by the artist (the image does not change)"),
  visemes: tx(
    "Folha de bocas desenhada por imagem + referência do retrato aprovado na grade 4 × 2 declarada, fatiada e medida localmente; não é capacidade nativa de visemes nem sincronização com áudio",
    "Mouth sheet drawn by image + reference of the approved portrait in the declared 4 × 2 grid, sliced and measured locally; not a native viseme capability nor audio sync",
  ),
  speech: tx(
    "Plano temporal derivado do texto pela regra de letras letters-v1: não sintetiza voz, não reconhece fonemas de áudio e não sincroniza com áudio gravado",
    "Timing plan derived from the text by the letters-v1 rule: it does not synthesize voice, recognize audio phonemes or sync with recorded audio",
  ),
  speechRetarget: tx(
    "Mesma sequência de visemes com outra expressão compatível (mesmos IDs e ordem); nenhuma geração",
    "Same viseme sequence with another compatible expression (same IDs and order); no generation",
  ),
  font: tx(
    "Folhas de glyphs desenhadas por imagem + gabarito de grade (rota genérica) e montadas localmente em atlas bitmap com métricas medidas; não é fonte pixel nativa nem TTF",
    "Glyph sheets drawn by image + grid template (generic route) and assembled locally into a bitmap atlas with measured metrics; not a native pixel font nor a TTF",
  ),
  fontExtend: tx(
    "Extensão assistida: glyphs ausentes desenhados por imagem + referência dos glyphs-base aprovados, em células identificadas, e incorporados ao atlas bitmap; não é suporte nativo de charset",
    "Assisted extension: missing glyphs drawn by image + reference of the approved base glyphs, in identified cells, and merged into the bitmap atlas; not native charset support",
  ),
  fontImport: tx(
    "Atlas importado: fatiado pela grade declarada e medido localmente; cobertura = células com tinta",
    "Imported atlas: sliced by the declared grid and measured locally; coverage = cells with ink",
  ),
} as const;

/** Cor da marca da boca na guia de visemes (contorno; o modelo não deve desenhá-la). */
export const MOUTH_MARK = "#ff00c8";

/** Descrição de cada viseme para o prompt (mesma ordem da grade). */
export const VISEME_WORDS: Record<VisemeId, { "pt-BR": string; en: string }> = {
  rest: { "pt-BR": "boca fechada e relaxada (repouso)", en: "closed, relaxed mouth (rest)" },
  ai: { "pt-BR": "boca bem aberta, como em “a”", en: "wide open mouth, as in “ah”" },
  e: { "pt-BR": "meio aberta com lábios esticados, como em “é/i”", en: "half open with stretched lips, as in “eh/ee”" },
  o: { "pt-BR": "aberta e arredondada, como em “ó”", en: "open and round, as in “oh”" },
  u: { "pt-BR": "pequena e arredondada em bico, como em “u”", en: "small rounded pucker, as in “oo”" },
  mbp: { "pt-BR": "lábios apertados um contra o outro (m, b, p)", en: "lips pressed together (m, b, p)" },
  fv: { "pt-BR": "lábio inferior tocando os dentes de cima (f, v)", en: "lower lip touching the upper teeth (f, v)" },
  cons: { "pt-BR": "dentes quase fechados, lábios entreabertos (s, t, d, n…)", en: "teeth nearly closed, lips slightly apart (s, t, d, n…)" },
};

export function compilePortraitPrompt(o: { language: "pt-BR" | "en"; brief: string; framing: "bust" | "head"; size: [number, number]; style: StylePayload; backgroundKey: string | null; alpha: boolean }): string {
  const en = o.language === "en";
  const [w, h] = o.size;
  const framing = o.framing === "head" ? (en ? "head and neck, face filling most of the frame" : "cabeça e pescoço, rosto ocupando quase todo o quadro") : en ? "bust from the chest up, facing the viewer" : "busto do peito para cima, de frente para quem olha";
  const bg = o.alpha
    ? en
      ? "Transparent background."
      : "Fundo transparente."
    : o.backgroundKey
      ? en
        ? `Flat solid ${colorName(o.backgroundKey, "en")} background, no shadow on it, no ${colorName(o.backgroundKey, "en")} on the character.`
        : `Fundo ${colorName(o.backgroundKey, "pt-BR")} chapado, sem sombra nele e sem ${colorName(o.backgroundKey, "pt-BR")} no personagem.`
      : "";
  const brief = o.brief.trim();
  return en
    ? [
        `A pixel art dialogue portrait of the SAME character as image 1: ${framing}.`,
        "Keep identity, hair, clothing colors and palette from image 1; only the camera gets closer. Neutral expression, mouth closed, eyes open.",
        brief ? `Notes: ${brief}.` : "",
        bg,
        `Crisp square pixels on a ${w}×${h} grid, readable at 1×, few colors: ${paletteNames(o.style, "en")}. Light ${lightWords(o.style, "en")}. No text, no frame, no border.`,
      ]
        .filter(Boolean)
        .join(" ")
    : [
        `Um retrato de diálogo em pixel art do MESMO personagem da imagem 1: ${framing}.`,
        "Mantenha identidade, cabelo, cores da roupa e paleta da imagem 1; só a câmera se aproxima. Expressão neutra, boca fechada, olhos abertos.",
        brief ? `Observações: ${brief}.` : "",
        bg,
        `Pixels quadrados e nítidos numa grade de ${w}×${h}, legível em 1×, poucas cores: ${paletteNames(o.style, "pt-BR")}. Luz vinda ${lightWords(o.style, "pt-BR")}. Sem texto, sem moldura e sem borda.`,
      ]
        .filter(Boolean)
        .join(" ");
}

export function compileVisemesPrompt(o: {
  language: "pt-BR" | "en";
  expressionKey: string;
  expressionBrief: string;
  visemeIds: VisemeId[];
  columns: number;
  rows: number;
  cell: [number, number];
  backgroundKey: string | null;
}): string {
  const lang = o.language;
  const en = lang === "en";
  const mark = colorName(MOUTH_MARK, lang);
  const list = o.visemeIds.map((id, i) => `${i + 1}. ${VISEME_WORDS[id][lang]}`).join("; ");
  const expression = o.expressionBrief.trim() || o.expressionKey;
  const [sw, sh] = [o.columns * o.cell[0], o.rows * o.cell[1]];
  const bg = o.backgroundKey
    ? en
      ? `Keep the background flat solid ${colorName(o.backgroundKey, "en")}.`
      : `Mantenha o fundo ${colorName(o.backgroundKey, "pt-BR")} chapado.`
    : en
      ? "Keep the background transparent."
      : "Mantenha o fundo transparente.";
  return en
    ? [
        `Image 1 is the approved pixel art portrait. Image 2 repeats it in a ${o.columns} × ${o.rows} grid of ${o.cell[0]}×${o.cell[1]} cells (${sw}×${sh} in total); the ${mark} outline marks the mouth area.`,
        `Redraw the grid as a mouth-shape sheet for the expression “${expression}”: the same face in every cell, with the expression applied the same way in all cells.`,
        `Change ONLY the mouth inside the marked area, cell by cell, in reading order: ${list}.`,
        `Keep hair, eyes, clothing, outline, palette, size and position identical in every cell; do not draw the ${mark} outline, grid lines, numbers or text.`,
        bg,
      ].join(" ")
    : [
        `A imagem 1 é o retrato aprovado em pixel art. A imagem 2 o repete numa grade ${o.columns} × ${o.rows} de células de ${o.cell[0]}×${o.cell[1]} (${sw}×${sh} no total); o contorno ${mark} marca a área da boca.`,
        `Redesenhe a grade como uma folha de bocas para a expressão “${expression}”: o mesmo rosto em todas as células, com a expressão aplicada igual em todas.`,
        `Mude SÓ a boca dentro da área marcada, célula a célula, na ordem de leitura: ${list}.`,
        `Mantenha cabelo, olhos, roupa, contorno, paleta, tamanho e posição idênticos em todas as células; não desenhe o contorno ${mark}, linhas de grade, números nem texto.`,
        bg,
      ].join(" ");
}

const WEIGHT_WORDS = { light: { "pt-BR": "traço fino (1 px)", en: "thin 1 px strokes" }, regular: { "pt-BR": "traço regular de 1 px", en: "regular 1 px strokes" }, bold: { "pt-BR": "traço grosso (2 px nas hastes)", en: "bold strokes (2 px stems)" } } as const;

/** Página de glyphs: a última imagem é o gabarito com células, baseline e letras-fantasma. */
export function compileFontPrompt(o: {
  language: "pt-BR" | "en";
  brief: string;
  weight: keyof typeof WEIGHT_WORDS;
  capHeight: number;
  columns: number;
  rows: number;
  cell: [number, number];
  chars: string[];
  inkColor: string;
  backgroundKey: string;
  extend: boolean;
}): string {
  const lang = o.language;
  const en = lang === "en";
  const rows: string[] = [];
  for (let r = 0; r * o.columns < o.chars.length; r++) rows.push(o.chars.slice(r * o.columns, (r + 1) * o.columns).join(" "));
  const guideIndex = o.extend ? 2 : 1;
  const ink = colorName(o.inkColor, lang);
  const key = colorName(o.backgroundKey, lang);
  const [sw, sh] = [o.columns * o.cell[0], o.rows * o.cell[1]];
  const brief = o.brief.trim();
  return en
    ? [
        `A pixel font glyph sheet: ${brief || "clean game font"}, ${WEIGHT_WORDS[o.weight].en}, capital letters ${o.capHeight} px tall.`,
        ...(o.extend ? ["Image 1 shows approved glyphs of the same font: copy their exact stroke width, shapes and spacing."] : []),
        `Image ${guideIndex} is the template: a ${o.columns} × ${o.rows} grid of ${o.cell[0]}×${o.cell[1]} cells (${sw}×${sh} in total) with the baseline in red and a gray ghost letter showing which character goes in each cell and where it sits.`,
        `Draw exactly these characters, row by row in reading order (empty cells stay empty): ${rows.map((r, i) => `row ${i + 1}: ${r}`).join("; ")}.`,
        "Accents and the cedilla are part of the letter: keep them inside the same cell, above or below the letter.",
        `Every glyph in solid ${ink}, standing on the baseline of its cell, never touching the cell borders. Flat solid ${key} background everywhere else; do not draw the grid lines, the ghost letters, numbers or labels.`,
      ].join(" ")
    : [
        `Uma folha de glyphs de fonte pixel: ${brief || "fonte limpa de jogo"}, ${WEIGHT_WORDS[o.weight]["pt-BR"]}, maiúsculas com ${o.capHeight} px de altura.`,
        ...(o.extend ? ["A imagem 1 mostra glyphs aprovados da mesma fonte: copie exatamente a espessura do traço, as formas e o espaçamento."] : []),
        `A imagem ${guideIndex} é o gabarito: grade ${o.columns} × ${o.rows} de células de ${o.cell[0]}×${o.cell[1]} (${sw}×${sh} no total), com a baseline em vermelho e uma letra-fantasma cinza indicando qual caractere vai em cada célula e onde ele apoia.`,
        `Desenhe exatamente estes caracteres, linha a linha na ordem de leitura (células vazias continuam vazias): ${rows.map((r, i) => `linha ${i + 1}: ${r}`).join("; ")}.`,
        "Acentos e cedilha fazem parte da letra: mantenha-os dentro da mesma célula, acima ou abaixo da letra.",
        `Cada glyph em ${ink} chapado, apoiado na baseline da sua célula, sem encostar nas bordas da célula. Fundo ${key} chapado em todo o resto; não desenhe as linhas da grade, as letras-fantasma, números nem rótulos.`,
      ].join(" ");
}
