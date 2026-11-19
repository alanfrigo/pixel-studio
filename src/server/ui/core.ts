import type { StylePayload, TemplateCell, UiState } from "@/contracts";
import { colorName } from "@/domain/color-names";
import { type LocalizedText, tx } from "@/i18n/locales";
import { lightWords, paletteNames } from "../world/core";

/**
 * Núcleo do cartão U3 sem dependência dos casos de uso HTTP (usado pelos
 * pipelines do worker e pelos serviços): rótulos honestos de cada rota e
 * receitas de prompt. Nenhum provedor real declara template ou estados de UI
 * nativos: na rota genérica o template é uma imagem achatada pintada sobre a
 * guia raster, e os estados são derivados por imagem + referência do
 * componente aprovado. Cores vão por nome, nunca em hexadecimal.
 */

export const UI_ROUTE_LABELS = {
  template: tx(
    "Imagem + referências: o layout vira guia raster e o modelo pinta as peças nas células. A imagem é achatada; cada peça só vira componente pelo recorte local revisado (não é template nativo)",
    "Image + references: the layout becomes a raster guide and the model paints the pieces into the cells. The image is flat; each piece only becomes a component through the reviewed local crop (not a native template)",
  ),
  states: tx(
    "Estados derivados por imagem + referência do componente aprovado (folha na mesma célula, conferida localmente); não é geração nativa de estados",
    "States derived by image + reference of the approved component (sheet in the same cell, checked locally); not native state generation",
  ),
  split: tx("Recorte local explícito do template revisado: separar recorta pixels, não gera arte", "Explicit local crop of the reviewed template: splitting cuts pixels, it does not generate art"),
  localTransform: tx("Transformação local explícita (sem IA): rampa da paleta, realce ou deslocamento do miolo, contorno preservado", "Explicit local transformation (no AI): palette ramp, highlight or center offset, outline preserved"),
  focusOverlay: tx("Overlay de foco desenhado localmente na cor reservada; não é uma sexta aparência", "Focus overlay drawn locally in the reserved color; not a sixth appearance"),
  menuItem: tx("Item de menu montado localmente: botão aprovado + legenda por chave; sem geração", "Menu item assembled locally: approved button + keyed caption; no generation"),
  screen: tx("Tela composta localmente com revisões fixas dos componentes; sem geração", "Screen composed locally from pinned component revisions; no generation"),
  rebind: tx("Nova revisão da tela com as instâncias religadas à revisão escolhida do componente", "New screen revision with the instances rebound to the chosen component revision"),
} satisfies Record<string, LocalizedText>;

/** Cor de foco reservada pelo estilo (exceção `reserved_focus_color` com um #RRGGBB nas notas) ou amarelo padrão. */
export function focusColor(style: StylePayload): string {
  const rules = style.exceptions.filter((e) => e.rule === "reserved_focus_color");
  const rule = rules.find((e) => e.family === "ui") ?? rules[0];
  const hex = rule?.notes.match(/#[0-9a-fA-F]{6}/)?.[0];
  return (hex ?? "#ffd600").toLowerCase();
}

const PIECE_WORDS: Record<string, { "pt-BR": string; en: string }> = {
  button: { "pt-BR": "botão", en: "button" },
  menu_item: { "pt-BR": "botão de item de menu", en: "menu item button" },
  panel: { "pt-BR": "painel/janela", en: "panel/window" },
  slot: { "pt-BR": "slot de inventário vazio", en: "empty inventory slot" },
  track: { "pt-BR": "trilho da barra de vida (fundo escuro)", en: "health bar track (dark background)" },
  fill: { "pt-BR": "preenchimento da barra de vida (barra lisa colorida)", en: "health bar fill (plain colored bar)" },
  frame: { "pt-BR": "moldura da barra de vida (só o anel da borda, miolo vazio)", en: "health bar frame (border ring only, empty middle)" },
};

export function pieceWord(cell: Pick<TemplateCell, "componentType" | "meterPart">, language: "pt-BR" | "en"): string {
  return PIECE_WORDS[cell.meterPart ?? cell.componentType]?.[language] ?? cell.componentType;
}

export interface TemplatePromptInput {
  language: "pt-BR" | "en";
  brief: string;
  cells: TemplateCell[];
  style: StylePayload;
  backgroundKey: string;
  references: number;
}

/** Receita do template (07 §template): peças separadas nas células da guia, sem letras, centro livre para a legenda. */
export function compileTemplatePrompt(o: TemplatePromptInput): string {
  const en = o.language === "en";
  const key = colorName(o.backgroundKey, o.language);
  const list = o.cells.map((c) => `${c.localId} (${pieceWord(c, o.language)}, ${c.cell[2]}×${c.cell[3]})`).join("; ");
  const parts = en
    ? [
        `Pixel art game UI kit: ${o.brief}.`,
        `Image 1 is a layout guide on a flat ${key} background: each grey box is ONE separate UI piece. Paint each piece exactly inside its own box, filling the box edge to edge, and keep everything outside the boxes flat solid ${key}.`,
        `Pieces, left to right and top to bottom: ${list}.`,
        `Light-grey boxes are the health bar fill; boxes drawn only as a grey ring are the health bar frame: paint only that ring and keep its middle ${key}.`,
        "No letters, numbers, icons or symbols on any piece; button and panel centers stay plain and uniform for captions.",
        `Crisp square pixels, no anti-aliasing, ${o.style.outline.widthPx}px dark outline, light ${lightWords(o.style, "en")}, colors: ${paletteNames(o.style, "en")}.`,
      ]
    : [
        `Kit de interface de jogo em pixel art: ${o.brief}.`,
        `A imagem 1 é uma guia de layout em fundo ${key} chapado: cada caixa cinza é UMA peça de interface separada. Pinte cada peça exatamente dentro da sua caixa, ocupando-a de borda a borda, e deixe tudo fora das caixas em ${key} chapado.`,
        `Peças, da esquerda para a direita e de cima para baixo: ${list}.`,
        `Caixas cinza-claras são o preenchimento da barra de vida; caixas desenhadas só como anel cinza são a moldura da barra: pinte só esse anel e deixe o miolo em ${key}.`,
        "Sem letras, números, ícones ou símbolos em nenhuma peça; o centro de botões e painéis fica liso e uniforme para a legenda.",
        `Pixels quadrados e nítidos, sem anti-aliasing, contorno escuro de ${o.style.outline.widthPx} px, luz vinda ${lightWords(o.style, "pt-BR")}, cores: ${paletteNames(o.style, "pt-BR")}.`,
      ];
  if (o.references) {
    parts.push(
      en
        ? `Images 2–${o.references + 1}: approved art of the same game (scene, item); match material, tone and pixel size.`
        : `Imagens 2–${o.references + 1}: arte aprovada do mesmo jogo (cena, item); siga material, tom e tamanho de pixel.`,
    );
  }
  return parts.join(" ");
}

export const STATE_DESCRIPTIONS: Record<UiState, { "pt-BR": string; en: string }> = {
  normal: { "pt-BR": "aparência normal", en: "normal look" },
  hover: { "pt-BR": "um pouco mais clara e realçada, como com o ponteiro em cima", en: "slightly brighter and highlighted, as if the pointer is over it" },
  pressed: { "pt-BR": "afundada: miolo mais escuro e 1 pixel mais baixo, mesmo contorno", en: "pushed in: darker center, 1 pixel lower, same outline" },
  disabled: { "pt-BR": "inativa: dessaturada e mais escura", en: "inactive: desaturated and darker" },
  selected: { "pt-BR": "opção escolhida: brilho dourado quente por dentro da borda, mesmo contorno", en: "chosen option: warm golden glow inside the rim, same outline" },
  empty: { "pt-BR": "slot vazio", en: "empty slot" },
  occupied: { "pt-BR": "slot ocupado: miolo levemente afundado e mais escuro (o ícone do item é desenhado por cima depois)", en: "occupied slot: center slightly sunken and darker (the item icon is drawn on top later)" },
};

/** Receita da folha de estados: a célula 1 mostra o estado-base aprovado; as demais repetem a MESMA peça em outro estado. */
export function compileStatesPrompt(o: { language: "pt-BR" | "en"; baseStates: UiState[]; states: { state: UiState; description: string | null }[]; backgroundKey: string }): string {
  const en = o.language === "en";
  const key = colorName(o.backgroundKey, o.language);
  const list = o.states.map((s) => `${s.state} — ${s.description ?? STATE_DESCRIPTIONS[s.state][o.language]}`).join("; ");
  const base = [...new Set(o.baseStates)].join("/");
  return en
    ? [
        `Pixel art game UI states. Image 1 is a sheet on a flat ${key} background: the top-left cell shows the approved piece in its ${base} state; every other cell is a grey placeholder box of the same size.`,
        `Repaint the SAME piece inside each placeholder, left to right then top to bottom, in this order: ${list}.`,
        "Keep exactly the same size, silhouette, outline, corners and padding as the approved piece; change only light, color and inner details. No letters or symbols.",
        `Everything outside the pieces stays flat solid ${key}. Crisp square pixels, no anti-aliasing, do not resize or move the cells.`,
      ].join(" ")
    : [
        `Estados de interface de jogo em pixel art. A imagem 1 é uma folha em fundo ${key} chapado: a célula do canto superior esquerdo mostra a peça aprovada no estado ${base}; cada outra célula é uma caixa cinza do mesmo tamanho.`,
        `Repinte a MESMA peça dentro de cada caixa, da esquerda para a direita e de cima para baixo, nesta ordem: ${list}.`,
        "Mantenha exatamente o mesmo tamanho, silhueta, contorno, cantos e padding da peça aprovada; mude só luz, cor e detalhes internos. Sem letras ou símbolos.",
        `Tudo fora das peças fica em ${key} chapado. Pixels quadrados e nítidos, sem anti-aliasing, sem redimensionar nem mover as células.`,
      ].join(" ");
}
