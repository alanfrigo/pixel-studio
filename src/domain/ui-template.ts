import type { AssetFamily, MeterPart, Rect, TemplateCell, UiComponentType, UiState } from "@/contracts";

/**
 * Template de UI (cartão U3): layout declarado das peças pedidas, que vira a
 * guia raster da rota genérica e, depois, a proposta de separação. A barra é
 * pedida como três peças (trilho, preenchimento e moldura) porque recortar um
 * contorno achatado não cria camadas independentes.
 */

export interface RequestedComponent {
  localId: string;
  componentType: UiComponentType;
  logicalSize: [number, number];
  requiredStates?: UiState[] | undefined;
}

export const DEFAULT_REQUIRED_STATES: Record<UiComponentType, UiState[]> = {
  button: ["normal", "hover", "pressed", "disabled"],
  menu_item: ["normal", "hover", "pressed", "disabled", "selected"],
  slot: ["empty", "occupied", "selected"],
  panel: [],
  meter: [],
};

/** Estado-base (referência aprovada) de cada tipo com estados. */
export const BASE_STATE: Partial<Record<string, UiState>> = { button: "normal", slot: "empty" };

/** Recuo do preenchimento dentro do trilho/moldura da barra. */
export function meterInset([w, h]: [number, number]): number {
  return Math.max(1, Math.floor(Math.min(w, h) / 4));
}

/** Células da barra: trilho e moldura no tamanho pedido, preenchimento na área útil. */
function cellsOf(c: RequestedComponent): { localId: string; meterPart: MeterPart | null; size: [number, number] }[] {
  if (c.componentType !== "meter") return [{ localId: c.localId, meterPart: null, size: c.logicalSize }];
  const i = meterInset(c.logicalSize);
  const fill: [number, number] = [c.logicalSize[0] - 2 * i, c.logicalSize[1] - 2 * i];
  return [
    { localId: `${c.localId}.track`, meterPart: "track", size: c.logicalSize },
    { localId: `${c.localId}.fill`, meterPart: "fill", size: fill },
    { localId: `${c.localId}.frame`, meterPart: "frame", size: c.logicalSize },
  ];
}

/**
 * Empacota as peças em prateleiras com espaçamento inteiro, na ordem pedida, e
 * completa o template até no máximo 2:1 (modelos de imagem têm proporções
 * limitadas; a sobra fica na cor-chave).
 */
export function packTemplate(components: RequestedComponent[], gap = 4): { logicalSize: [number, number]; cells: TemplateCell[] } {
  const flat = components.flatMap((c) => cellsOf(c).map((cell) => ({ ...cell, component: c })));
  const widest = Math.max(...flat.map((f) => f.size[0]));
  const area = flat.reduce((n, f) => n + (f.size[0] + gap) * (f.size[1] + gap), 0);
  const maxW = Math.max(widest + 2 * gap, Math.ceil(Math.sqrt(area) * 1.3));
  const cells: TemplateCell[] = [];
  let x = gap;
  let y = gap;
  let rowH = 0;
  let width = 0;
  for (const f of flat) {
    if (x > gap && x + f.size[0] + gap > maxW) {
      x = gap;
      y += rowH + gap;
      rowH = 0;
    }
    const cell: Rect = [x, y, f.size[0], f.size[1]];
    cells.push({
      localId: f.localId,
      componentId: f.component.localId,
      componentType: f.component.componentType,
      meterPart: f.meterPart,
      cell,
      requiredStates: f.component.requiredStates ?? DEFAULT_REQUIRED_STATES[f.component.componentType],
    });
    x += f.size[0] + gap;
    rowH = Math.max(rowH, f.size[1]);
    width = Math.max(width, x);
  }
  let w = width;
  let h = y + rowH + gap;
  if (w > 2 * h) h = Math.ceil(w / 2);
  if (h > 2 * w) w = Math.ceil(h / 2);
  return { logicalSize: [w, h], cells };
}

/** Componente de cada célula (as três partes da barra compartilham o mesmo). */
export function groupCells<T extends { componentId: string }>(cells: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const c of cells) map.set(c.componentId, [...(map.get(c.componentId) ?? []), c]);
  return map;
}

/**
 * Imagem principal de uma revisão para prévia/referência: ícone do item, vista
 * do personagem, retrato, cena/plano/sala, textura ou estado-base do componente.
 */
export function imageOfPayload(family: AssetFamily, kind: string, payload: unknown): { fileId: string; rect: [number, number, number, number] } | null {
  const p = payload as Record<string, unknown>;
  const region = (v: unknown) => {
    const r = v as { fileId?: unknown; rect?: unknown } | null | undefined;
    return r && typeof r.fileId === "string" && Array.isArray(r.rect) ? { fileId: r.fileId, rect: r.rect as [number, number, number, number] } : null;
  };
  if (family === "item") return region((p.representations as unknown[] | undefined)?.find((r) => (r as { role?: string }).role === "icon") ?? (p.representations as unknown[] | undefined)?.[0]);
  if (family === "character" && kind === "base") return region((p.views as unknown[] | undefined)?.[0]);
  if (family === "map" && kind === "scene") return region(p.image);
  if (family === "map" && kind === "room") return region(p.background ?? p.picture);
  if (family === "ui" && (kind === "button" || kind === "slot")) {
    const states = (p.states as { state: string }[] | undefined) ?? [];
    return region(states.find((s) => s.state === BASE_STATE[kind]) ?? states[0]);
  }
  if (family === "ui" && (kind === "panel" || kind === "template")) return region(p.image);
  if (family === "ui" && kind === "meter") return region(p.frame);
  return region(p);
}
