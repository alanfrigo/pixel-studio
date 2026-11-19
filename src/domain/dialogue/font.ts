import { type FontPayload, formatCodepoint } from "@/contracts";

/**
 * Fonte bitmap do cartão D1: kits de cobertura, cobertura derivada dos textos
 * do projeto, geometria da célula do gabarito e paginação das folhas.
 *
 * Métricas (Y positivo para baixo, posicionamento inteiro):
 * - `bearingX/bearingY` são relativos à origem da caneta na baseline; um glyph
 *   apoiado na baseline tem `bearingY = -altura` (topo acima dela).
 * - `ascent` = maior altura acima da baseline; `descent` = maior profundidade
 *   abaixo; `lineHeight = ascent + descent + 1` (1 px de entrelinha);
 *   `baseline` = distância do topo da linha à baseline (= ascent).
 * - Montagem proporcional: `bearingX = 0`, `advanceX = largura + tracking`.
 * - Espaço não é glyph: `spaceAdvance = max(2, floor(capHeight / 2))`.
 * - Kerning: nenhum par é inventado (lista vazia e explícita).
 */

/** Kit português: obrigatório no kit pt-BR (07 §cobertura do projeto). */
export const PT_KIT = "áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ";

/** Pontuação comum do conjunto básico (inclui o travessão do texto de teste). */
export const BASIC_PUNCTUATION = ".,;:!?'\"-()/—…%+=";

/** Textos de teste do aceite (07 §tipografia). */
export const FONT_TEST_STRINGS = ["Ação, Poção, Coração — ÁRVORE", "Inventário", "0123456789", ".,;:!?'\"-()/…%+="] as const;

export const codepointsOf = (text: string) => [...new Set([...text.normalize("NFC")].map((c) => c.codePointAt(0)!))];

export function basicCodepoints(): number[] {
  const letters = Array.from({ length: 26 }, (_, i) => [0x41 + i, 0x61 + i]).flat();
  const digits = Array.from({ length: 10 }, (_, i) => 0x30 + i);
  return [...letters, ...digits, ...codepointsOf(BASIC_PUNCTUATION)];
}

/** Espaço, quebra e controles não são glyphs (o espaço é métrica). */
export function isGlyphCodepoint(cp: number): boolean {
  return cp > 0x20 && !(cp >= 0x7f && cp <= 0x9f) && !/\s/u.test(String.fromCodePoint(cp));
}

export type FontKit = "basic" | "basic_pt";

export interface CoverageSource {
  /** De onde o texto veio (ex.: `ui:inventory.use`, `speech:intro`, `test`, `extra`). */
  source: string;
  text: string;
}

/** Ordem estável: maiúsculas, minúsculas, dígitos, pontuação ASCII, depois o resto por codepoint. */
export function sortCodepoints(cps: Iterable<number>): number[] {
  const rank = (cp: number) => (cp >= 0x41 && cp <= 0x5a ? 0 : cp >= 0x61 && cp <= 0x7a ? 1 : cp >= 0x30 && cp <= 0x39 ? 2 : cp < 0x80 ? 3 : 4);
  return [...new Set(cps)].sort((a, b) => rank(a) - rank(b) || a - b);
}

/**
 * Codepoints exigidos pelo projeto: kit escolhido + todos os caracteres dos
 * textos (NFC), com a origem de cada um. Nada é deduzido de um PNG de letras.
 */
export function requiredCoverage(kit: FontKit, sources: CoverageSource[]) {
  const from = new Map<number, Set<string>>();
  const add = (cp: number, source: string) => {
    if (!isGlyphCodepoint(cp)) return;
    if (!from.has(cp)) from.set(cp, new Set());
    from.get(cp)!.add(source);
  };
  basicCodepoints().forEach((cp) => add(cp, "kit:basic"));
  if (kit === "basic_pt") codepointsOf(PT_KIT).forEach((cp) => add(cp, "kit:pt"));
  for (const s of sources) codepointsOf(s.text).forEach((cp) => add(cp, s.source));
  const codepoints = sortCodepoints(from.keys());
  return { codepoints, sources: Object.fromEntries(codepoints.map((cp) => [cp, [...from.get(cp)!]])) as Record<number, string[]> };
}

/** Cobertura real de uma fonte (glyphs inspecionados) contra o exigido: ausentes listados, nunca substituídos. */
export function coverageReport(font: Pick<FontPayload, "glyphs"> | null, required: number[]) {
  const present = new Set(font?.glyphs.map((g) => g.codepoint) ?? []);
  const missing = required.filter((cp) => !present.has(cp));
  return {
    required: required.length,
    present: required.length - missing.length,
    missing,
    missingLabels: missing.map(formatCodepoint),
    complete: missing.length === 0,
  };
}

export interface GlyphGeometry {
  capHeight: number;
  cell: [number, number];
  baselineY: number;
  padLeft: number;
  accentSpace: number;
  descender: number;
}

/**
 * Célula do gabarito para uma altura de maiúscula G: espaço de acento acima
 * (Á) com folga, corpo G e descendente (g, ç) abaixo; 1 px de margem à esquerda.
 */
export function glyphGeometry(capHeight: number): GlyphGeometry {
  // Acento de 2–3 linhas + 1 de folga acima da maiúscula; letras largas (M, W) cabem com 1 px de cada lado.
  const accentSpace = Math.max(3, Math.ceil(capHeight * 0.375)) + 1;
  const descender = Math.max(2, Math.ceil(capHeight * 0.375));
  return { capHeight, cell: [capHeight + 4, accentSpace + capHeight + descender], baselineY: accentSpace + capHeight, padLeft: 1, accentSpace, descender };
}

export const PAGE_GRID = { columns: 8, rows: 4 } as const;

/** Pagina os codepoints (na ordem estável) em folhas de 8 × 4 células; cada folha é uma parte do plano. */
export function pageCodepoints(codepoints: number[], perPage: number = PAGE_GRID.columns * PAGE_GRID.rows) {
  const sorted = sortCodepoints(codepoints);
  const pages: { partKey: string; codepoints: number[] }[] = [];
  for (let i = 0; i < sorted.length; i += perPage) pages.push({ partKey: `glyph_set:p${pages.length + 1}`, codepoints: sorted.slice(i, i + perPage) });
  return pages;
}

export const spaceAdvanceFor = (capHeight: number) => Math.max(2, Math.floor(capHeight / 2));

/** Métricas de linha a partir dos glyphs medidos (mesma regra na geração, extensão e importação). */
export function lineMetrics(glyphs: { bearingY: number; rect: readonly number[] }[], capHeight: number) {
  const ascent = Math.max(1, ...glyphs.map((g) => -g.bearingY));
  const descent = Math.max(0, ...glyphs.map((g) => g.bearingY + g.rect[3]!));
  return { ascent, descent, lineHeight: ascent + descent + 1, spaceAdvance: spaceAdvanceFor(capHeight), baseline: ascent };
}

/** Caracteres em ordem de leitura → codepoints da grade (`null` = célula vazia declarada por espaço). */
export function cellsFromChars(chars: string): (number | null)[] {
  return [...chars.normalize("NFC")].map((c) => (c === " " ? null : c.codePointAt(0)!));
}
