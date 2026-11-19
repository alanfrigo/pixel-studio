import { gridCellOffsets, type GridLayout, type MeterPayload, type Rect, type ScreenInstance, type ScreenPayload, type Size, type SlotPayload, type TextCatalog, type TextSlot } from "@/contracts";
import { anchoredRect, meterFill } from "./ui-geometry";
import { PREVIEW_FONT, previewTextWidth } from "./ui-preview-font";

/**
 * Composição de telas de UI (07 §composição editável, cartão U3), uma única
 * implementação para o compositor, os testes e a prévia de exportação; o
 * leitor portátil (Python) reproduz as mesmas regras.
 *
 * Retângulos aqui podem ter largura/altura 0 (instância colapsada); o
 * contrato `Rect` (largura positiva) vale para arquivos, não para o layout.
 */

export type Box = [x: number, y: number, w: number, h: number];

export interface ResolvedInstance {
  instance: ScreenInstance;
  rect: Box;
  depth: number;
  /** Visível = ela e todos os ancestrais sem `hidden`. */
  visible: boolean;
  /** Posição na ordem de desenho (pais antes dos filhos; irmãos por `order`). */
  drawIndex: number;
}

/** Filhos de cada pai, na ordem de desenho registrada (empate pela posição no array). */
export function childrenByParent(instances: readonly ScreenInstance[]): Map<string | null, ScreenInstance[]> {
  const index = new Map(instances.map((inst, i) => [inst.instanceId, i]));
  const map = new Map<string | null, ScreenInstance[]>();
  for (const inst of instances) {
    const list = map.get(inst.parentId) ?? [];
    list.push(inst);
    map.set(inst.parentId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.order - b.order || index.get(a.instanceId)! - index.get(b.instanceId)!);
  return map;
}

/**
 * Hierarquia → retângulos na resolução pedida: cada lado = origem do pai +
 * fração da dimensão do pai + deslocamento, arredondado à grade.
 */
export function layoutScreen(payload: Pick<ScreenPayload, "instances">, resolution: Size): ResolvedInstance[] {
  const children = childrenByParent(payload.instances);
  const out: ResolvedInstance[] = [];
  const visit = (inst: ScreenInstance, parent: Box, depth: number, parentVisible: boolean, seen: Set<string>) => {
    if (seen.has(inst.instanceId)) return; // ciclo: o contrato já recusa; aqui só encerra
    seen.add(inst.instanceId);
    const rect = anchoredRect(parent, inst.anchors, inst.offsets) as Box;
    const visible = parentVisible && !inst.hidden;
    out.push({ instance: inst, rect, depth, visible, drawIndex: out.length });
    for (const child of children.get(inst.instanceId) ?? []) visit(child, rect, depth + 1, visible, seen);
  };
  const seen = new Set<string>();
  for (const root of children.get(null) ?? []) visit(root, [0, 0, resolution[0], resolution[1]], 0, true, seen);
  return out;
}

export function rectOf(resolved: readonly ResolvedInstance[], instanceId: string): Box | null {
  return resolved.find((r) => r.instance.instanceId === instanceId)?.rect ?? null;
}

// ---------------------------------------------------------------------------
// Foco: ordem registrada, independente da ordem de desenho
// ---------------------------------------------------------------------------

/** Instâncias da ordem de foco que podem receber foco agora (visíveis e não desabilitadas). */
export function focusableIds(payload: Pick<ScreenPayload, "instances" | "focusOrder">, resolution: Size): string[] {
  const resolved = new Map(layoutScreen(payload, resolution).map((r) => [r.instance.instanceId, r]));
  return payload.focusOrder.filter((id) => {
    const r = resolved.get(id);
    return r !== undefined && r.visible && r.instance.overrides.state !== "disabled";
  });
}

/** Próximo foco na ordem registrada (`step` 1 = avança, −1 = volta), circular. */
export function moveFocus(payload: Pick<ScreenPayload, "instances" | "focusOrder">, resolution: Size, current: string | null, step: 1 | -1): string | null {
  const ids = focusableIds(payload, resolution);
  if (ids.length === 0) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return step === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(at + step + ids.length) % ids.length]!;
}

/** Tecla → passo de foco (Tab/setas); 0 = não navega. */
export function focusStepForKey(key: string, shift: boolean): 1 | -1 | 0 {
  if (key === "Tab") return shift ? -1 : 1;
  if (key === "ArrowDown" || key === "ArrowRight") return 1;
  if (key === "ArrowUp" || key === "ArrowLeft") return -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Texto: chave + catálogo + amostra; quebra e política de excesso
// ---------------------------------------------------------------------------

export interface TextMetrics {
  measure(text: string): number;
  /** Distância entre linhas. */
  lineHeight: number;
  /** Altura da caixa do glifo (acentos sobem na entrelinha, como em fontes pixel). */
  glyphHeight: number;
}

export const PREVIEW_METRICS: TextMetrics = { measure: previewTextWidth, lineHeight: PREVIEW_FONT.lineHeight, glyphHeight: PREVIEW_FONT.glyphHeight };

export interface TextLayout {
  /** Linhas visíveis (primeira página quando pagina). */
  lines: string[];
  pages: string[][];
  /** O texto não cabe na área declarada. */
  overflow: boolean;
  /** O que a política fez: cabe, cresce, pagina, reticências ou acusa. */
  outcome: "fits" | "grow" | "paginate" | "ellipsis" | "report";
  /** Tamanho necessário para mostrar tudo (política `grow`). */
  needed: [number, number];
}

function wrapWords(text: string, width: number, metrics: TextMetrics): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (metrics.measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // Palavra maior que a área: quebra por caractere.
      let rest = word;
      while (metrics.measure(rest) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && metrics.measure(rest.slice(0, cut)) > width) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** Diagramação da legenda na área útil segundo `wrap` e `overflow` do componente/elemento. */
export function layoutText(text: string, area: [number, number], slot: Pick<TextSlot, "wrap" | "overflow">, metrics: TextMetrics = PREVIEW_METRICS): TextLayout {
  const [w, h] = area;
  const maxLines = h < metrics.glyphHeight ? 0 : Math.floor((h - metrics.glyphHeight) / metrics.lineHeight) + 1;
  const lines = slot.wrap === "word" ? wrapWords(text, w, metrics) : text.split("\n");
  const widest = Math.max(0, ...lines.map((l) => metrics.measure(l)));
  const needed: [number, number] = [widest, lines.length === 0 ? 0 : (lines.length - 1) * metrics.lineHeight + metrics.glyphHeight];
  const overflow = widest > w || lines.length > maxLines;
  if (!overflow) return { lines, pages: [lines], overflow, outcome: "fits", needed };
  switch (slot.overflow) {
    case "grow":
      return { lines, pages: [lines], overflow, outcome: "grow", needed };
    case "paginate": {
      if (widest > w || maxLines === 0) return { lines, pages: [lines], overflow, outcome: "report", needed };
      const pages: string[][] = [];
      for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines));
      return { lines: pages[0]!, pages, overflow, outcome: "paginate", needed };
    }
    case "ellipsis": {
      const kept = lines.slice(0, Math.max(1, maxLines));
      const last = kept.length - 1;
      let tail = kept[last]!;
      while (tail && metrics.measure(`${tail}…`) > w) tail = tail.slice(0, -1);
      kept[last] = `${tail}…`;
      return { lines: kept, pages: [kept], overflow, outcome: "ellipsis", needed };
    }
    default:
      return { lines, pages: [lines], overflow, outcome: "report", needed };
  }
}

/** Legenda efetiva: texto substituído → catálogo no idioma → amostra do componente/elemento. */
export function resolveCaption(inst: ScreenInstance, componentText: TextSlot | null, catalog: TextCatalog | undefined, language: string): { key: string | null; text: string | null } {
  const key = inst.overrides.textKey ?? inst.text?.key ?? componentText?.key ?? null;
  if (inst.overrides.text !== undefined) return { key, text: inst.overrides.text };
  const entry = key ? catalog?.entries.find((e) => e.key === key) : undefined;
  const localized = entry?.text[language];
  return { key, text: localized ?? inst.text?.sample ?? componentText?.sample ?? null };
}

// ---------------------------------------------------------------------------
// Medidor e slot
// ---------------------------------------------------------------------------

/**
 * Parte visível do preenchimento: região na textura (`src`) e no medidor
 * (`dst`, coordenadas locais). `null` = nada a desenhar (0%). Trilho e moldura
 * são sempre desenhados inteiros.
 */
export function meterFillRegion(meter: Pick<MeterPayload, "fill" | "usefulRect" | "range" | "axis" | "direction">, value: number): { src: Rect; dst: Rect } | null {
  const visible = meterFill(value, meter.range, meter.usefulRect, meter.axis, meter.direction);
  const [fx, fy] = meter.fill.offset;
  const [, , fw, fh] = meter.fill.rect;
  const x0 = Math.max(visible[0], fx);
  const y0 = Math.max(visible[1], fy);
  const x1 = Math.min(visible[0] + visible[2], fx + fw);
  const y1 = Math.min(visible[1] + visible[3], fy + fh);
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    src: [meter.fill.rect[0] + (x0 - fx), meter.fill.rect[1] + (y0 - fy), x1 - x0, y1 - y0],
    dst: [x0, y0, x1 - x0, y1 - y0],
  };
}

/** Retângulo do contador de quantidade (alinhado ao `counterAnchor` do slot) na fonte de prévia. */
export function slotCounterRect(slot: Pick<SlotPayload, "counterAnchor" | "counterAlign">, quantity: number, metrics: TextMetrics = PREVIEW_METRICS): Box {
  const text = String(quantity);
  const w = metrics.measure(text);
  const glyphH = 5;
  const [ax, ay] = slot.counterAnchor;
  const x = slot.counterAlign === "end" ? ax - w + 1 : ax;
  return [x, ay - glyphH + 1, w, glyphH];
}

export function boxInside(inner: Box, outer: Box): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[0] + inner[2] <= outer[0] + outer[2] && inner[1] + inner[3] <= outer[1] + outer[3];
}

// ---------------------------------------------------------------------------
// Grades (inventário) e instâncias de partida
// ---------------------------------------------------------------------------

/** Filhos de uma grade com offsets inteiros nas células (mesma regra validada pelo contrato). */
export function gridChildren(group: ScreenInstance & { layout: GridLayout }, componentRevisionId: string, count: number, idPrefix: string): ScreenInstance[] {
  return Array.from({ length: Math.min(count, group.layout.columns * group.layout.rows) }, (_, k) => ({
    instanceId: `${idPrefix}-${k + 1}`,
    parentId: group.instanceId,
    componentRevisionId,
    anchors: { left: 0, top: 0, right: 0, bottom: 0 },
    offsets: gridCellOffsets(group.layout, k),
    order: k,
    hidden: false,
    overrides: {},
  }));
}

/** Tamanho total de uma grade (para o grupo que a contém). */
export function gridSize(layout: GridLayout): [number, number] {
  return [layout.columns * layout.cell[0] + (layout.columns - 1) * layout.gap[0], layout.rows * layout.cell[1] + (layout.rows - 1) * layout.gap[1]];
}

const fixed = (x: number, y: number, w: number, h: number) => ({ anchors: { left: 0, top: 0, right: 0, bottom: 0 }, offsets: { left: x, top: y, right: x + w, bottom: y + h } });

export interface StarterParts {
  meter?: { revisionId: string; size: [number, number] } | undefined;
  panel?: { revisionId: string } | undefined;
  portrait?: { revisionId: string; size: [number, number] } | undefined;
  continueIndicator?: { revisionId: string; size: [number, number] } | undefined;
  menuItems?: { revisionId: string; size: [number, number] }[] | undefined;
  slot?: { revisionId: string; size: [number, number] } | undefined;
  icon?: { revisionId: string } | undefined;
  background?: { revisionId: string } | undefined;
}

/**
 * Tela de partida do kit (07 §fatias · kit de jogo): vida no alto à esquerda,
 * diálogo na base com 8 px de margem nas duas larguras, menu com os itens e
 * inventário em grade. O artista edita a partir daqui; nada é gerado.
 */
export function starterScreen(parts: StarterParts, resolution: Size = [320, 180]): ScreenPayload {
  const instances: ScreenInstance[] = [];
  const base = (id: string, parentId: string | null, componentRevisionId: string | null, order: number, geometry: Pick<ScreenInstance, "anchors" | "offsets">, extra: Partial<ScreenInstance> = {}): ScreenInstance => ({
    instanceId: id,
    parentId,
    componentRevisionId,
    ...geometry,
    order,
    hidden: false,
    overrides: {},
    ...extra,
  });
  const stretch = { left: 0, top: 0, right: 1, bottom: 1 };
  instances.push(base("root", null, null, 0, { anchors: stretch, offsets: { left: 0, top: 0, right: 0, bottom: 0 } }));
  // HUD: vida no alto à esquerda.
  instances.push(base("hud", "root", null, 1, { anchors: stretch, offsets: { left: 0, top: 0, right: 0, bottom: 0 } }, { role: "hud" }));
  if (parts.meter) instances.push(base("health", "hud", parts.meter.revisionId, 0, fixed(8, 8, ...parts.meter.size), { overrides: { value: 100 } }));
  // Diálogo na base: âncoras esquerda/direita 0/1 e offsets +8/−8 mantêm as margens nas duas larguras.
  instances.push(
    base("dialogue", "root", null, 3, { anchors: { left: 0, top: 1, right: 1, bottom: 1 }, offsets: { left: 8, top: -56, right: -8, bottom: -8 } }, { role: "dialogue" }),
  );
  if (parts.panel) instances.push(base("dialogue-panel", "dialogue", parts.panel.revisionId, 0, { anchors: stretch, offsets: { left: 0, top: 0, right: 0, bottom: 0 } }));
  const portraitW = parts.portrait ? Math.min(40, parts.portrait.size[0]) : 0;
  if (parts.portrait) {
    instances.push(base("dialogue-portrait", "dialogue", parts.portrait.revisionId, 1, { anchors: { left: 0, top: 0, right: 0, bottom: 1 }, offsets: { left: 4, top: 4, right: 4 + portraitW, bottom: -4 } }, { role: "portrait" }));
  }
  const textLeft = parts.portrait ? 8 + portraitW : 6;
  instances.push(
    base("dialogue-title", "dialogue", null, 2, { anchors: { left: 0, top: 0, right: 1, bottom: 0 }, offsets: { left: textLeft, top: 4, right: -6, bottom: 12 } }, {
      role: "title",
      text: { key: "dialogue.title", sample: "Guerreira", align: "start", verticalAlign: "top", wrap: "none", overflow: "ellipsis", fontRevisionId: null },
    }),
  );
  instances.push(
    base("dialogue-body", "dialogue", null, 3, { anchors: { left: 0, top: 0, right: 1, bottom: 1 }, offsets: { left: textLeft, top: 14, right: -6, bottom: -4 } }, {
      role: "body",
      text: { key: "dialogue.forest_1", sample: "A trilha some entre as árvores. Use a poção antes de seguir.", align: "start", verticalAlign: "top", wrap: "word", overflow: "paginate", fontRevisionId: null },
    }),
  );
  if (parts.continueIndicator) {
    const [cw, ch] = parts.continueIndicator.size;
    instances.push(base("dialogue-continue", "dialogue", parts.continueIndicator.revisionId, 4, { anchors: { left: 1, top: 1, right: 1, bottom: 1 }, offsets: { left: -6 - cw, top: -4 - ch, right: -6, bottom: -4 } }, { role: "continue_indicator" }));
  }
  // Menu: itens empilhados à direita, focáveis na ordem registrada.
  const items = parts.menuItems ?? [];
  if (items.length) {
    const width = Math.max(...items.map((i) => i.size[0]));
    const height = items.reduce((n, i) => n + i.size[1] + 2, -2);
    instances.push(base("menu", "root", null, 2, { anchors: { left: 1, top: 0, right: 1, bottom: 0 }, offsets: { left: -8 - width, top: 8, right: -8, bottom: 8 + height } }, { role: "menu" }));
    let y = 0;
    items.forEach((item, k) => {
      instances.push(base(`menu-item-${k + 1}`, "menu", item.revisionId, k, fixed(0, y, ...item.size)));
      y += item.size[1] + 2;
    });
  }
  // Inventário: quatro slots em grade com espaçamento inteiro, a poção nos quatro.
  if (parts.slot) {
    const layout: GridLayout = { kind: "grid", columns: 4, rows: 1, cell: parts.slot.size, gap: [2, 2] };
    const [gw, gh] = gridSize(layout);
    const group = base("inventory", "root", null, 4, { anchors: { left: 0.5, top: 0, right: 0.5, bottom: 0 }, offsets: { left: -Math.floor(gw / 2), top: 8, right: gw - Math.floor(gw / 2), bottom: 8 + gh } }, { role: "inventory", layout }) as ScreenInstance & { layout: GridLayout };
    instances.push(group);
    const slots = gridChildren(group, parts.slot.revisionId, 4, "slot");
    slots.forEach((s, k) => {
      if (parts.icon) s.overrides = { iconRevisionId: parts.icon.revisionId, quantity: [3, 1, 12, 99][k]!, ...(k === 0 ? { state: "selected" as const } : {}) };
    });
    instances.push(...slots);
  }
  const focusOrder = [...items.map((_, k) => `menu-item-${k + 1}`), ...(parts.slot ? [1, 2, 3, 4].map((k) => `slot-${k}`) : [])];
  return {
    referenceResolution: resolution,
    background: parts.background ? { revisionId: parts.background.revisionId, exported: false } : null,
    instances,
    focusOrder,
    textCatalog: {
      languages: ["pt-BR", "en"],
      entries: [
        { key: "dialogue.title", text: { "pt-BR": "Guerreira", en: "Warrior" } },
        { key: "dialogue.forest_1", text: { "pt-BR": "A trilha some entre as árvores. Use a poção antes de seguir.", en: "The trail fades among the trees. Use the potion before moving on." } },
        { key: "menu.continue", text: { "pt-BR": "Continuar", en: "Continue" } },
        { key: "menu.inventory", text: { "pt-BR": "Inventário", en: "Inventory" } },
        { key: "inventory.use", text: { "pt-BR": "Usar", en: "Use" } },
      ],
    },
    testedResolutions: [
      [320, 180],
      [400, 300],
    ],
  };
}
