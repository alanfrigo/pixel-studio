"use client";

import { ButtonPayload, type Insets, MenuItemPayload, MeterPayload, PanelPayload, type ScreenPayload, type Size, SlotPayload, type TextSlot } from "@/contracts";
import { contentArea, nineSlice } from "@/domain/ui-geometry";
import { PREVIEW_FONT, previewGlyph } from "@/domain/ui-preview-font";
import { layoutScreen, layoutText, meterFillRegion, type ResolvedInstance, resolveCaption, slotCounterRect } from "@/domain/ui-screen";
import type { RevisionView } from "@/server/catalog/catalog";
import type { ImageChoice } from "@/server/ui/screens";

/**
 * Desenho da prévia do kit de UI em canvas, com as MESMAS rotinas de
 * geometria do domínio (nine-slice, recorte do medidor, âncoras, texto). A
 * legenda usa a fonte de prévia embutida; a fonte do jogo é outro asset.
 */

const cache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = cache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(src));
      img.src = src;
    });
    cache.set(src, p);
  }
  return p;
}

type Rect4 = [number, number, number, number];

/** Região `src` desenhada em `dst`, em nine-slice quando há cortes (cantos nunca esticam). */
export function drawNine(ctx: CanvasRenderingContext2D, img: CanvasImageSource, src: Rect4, insets: Insets | null, dst: Rect4) {
  const [sx, sy, sw, sh] = src;
  const [dx, dy, dw, dh] = dst;
  if (dw <= 0 || dh <= 0) return;
  if (!insets) {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
    return;
  }
  try {
    for (const p of nineSlice([sw, sh], insets, [dw, dh])) ctx.drawImage(img, sx + p.src[0], sy + p.src[1], p.src[2], p.src[3], dx + p.dst[0], dy + p.dst[1], p.dst[2], p.dst[3]);
  } catch {
    // Menor que o mínimo: desenha sem esticar (o compositor acusa o tamanho).
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
  }
}

/** Uma linha na fonte de prévia (3×5 + acentos), pixel a pixel. */
export function drawPreviewLine(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    previewGlyph(ch).rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) if (row[rx] === "#") ctx.fillRect(cx + rx, y + ry - 2, 1, 1);
    });
    cx += PREVIEW_FONT.advance;
  }
}

/** Legenda diagramada na área (quebra/política do componente), alinhada e recortada à área. */
export function drawCaption(ctx: CanvasRenderingContext2D, text: string, area: Rect4, slot: Pick<TextSlot, "wrap" | "overflow" | "align" | "verticalAlign">, color: string, page = 0) {
  const [ax, ay, aw, ah] = area;
  const layout = layoutText(text, [aw, ah], slot);
  const lines = layout.pages[Math.min(page, layout.pages.length - 1)] ?? layout.lines;
  const blockH = lines.length ? (lines.length - 1) * PREVIEW_FONT.lineHeight + PREVIEW_FONT.glyphHeight : 0;
  const top = slot.verticalAlign === "top" ? ay : slot.verticalAlign === "bottom" ? ay + ah - blockH : ay + Math.floor((ah - blockH) / 2);
  ctx.save();
  if (slot.overflow !== "grow") {
    ctx.beginPath();
    ctx.rect(ax, ay - 2, aw, ah + 3);
    ctx.clip();
  }
  lines.forEach((line, i) => {
    const w = [...line].length * PREVIEW_FONT.advance - 1;
    const x = slot.align === "start" ? ax : slot.align === "end" ? ax + aw - w : ax + Math.floor((aw - w) / 2);
    drawPreviewLine(ctx, line, x, top + i * PREVIEW_FONT.lineHeight, color);
  });
  ctx.restore();
  return layout;
}

export interface RenderDeps {
  projectId: string;
  /** Revisões de UI do projeto (componentes, itens de menu). */
  revisions: Map<string, { kind: string; revision: RevisionView }>;
  /** Imagens aprovadas (ícone, retrato) e fundos. */
  images: Map<string, ImageChoice>;
  /** Imagens já carregadas por URL. */
  loaded: Map<string, HTMLImageElement>;
}

export function mediaOf(projectId: string, revision: Pick<RevisionView, "files">, fileKey: string): string | null {
  const f = revision.files.find((x) => x.fileKey === fileKey);
  return f ? `/api/v1/projects/${projectId}/media/${f.id}` : null;
}

/** URLs que a tela precisa (para pré-carregar antes de desenhar). */
export function screenUrls(payload: ScreenPayload, deps: Omit<RenderDeps, "loaded">): string[] {
  const urls = new Set<string>();
  const addRev = (id: string | null | undefined) => {
    if (!id) return;
    const ref = deps.revisions.get(id);
    if (ref) {
      for (const f of ref.revision.files) urls.add(`/api/v1/projects/${deps.projectId}/media/${f.id}`);
      if (ref.kind === "menu_item") addRev(MenuItemPayload.parse(ref.revision.payload).buttonRevisionId);
      return;
    }
    const img = deps.images.get(id);
    if (img) urls.add(`/api/v1/projects/${deps.projectId}/media/${img.mediaFileId}`);
  };
  payload.instances.forEach((i) => {
    addRev(i.componentRevisionId);
    addRev(i.overrides.iconRevisionId);
  });
  if (payload.background) addRev(payload.background.revisionId);
  return [...urls];
}

export interface RenderOptions {
  language: string;
  /** Estado interativo da prévia (ponteiro, teclado, clique), por cima das substituições salvas. */
  hover: string | null;
  focus: string | null;
  pressed: string | null;
  focusColor: string;
  textColor: string;
  guides: boolean;
  selected: string | null;
}

function imageBy(deps: RenderDeps, id: string) {
  const choice = deps.images.get(id);
  if (!choice) return null;
  const img = deps.loaded.get(`/api/v1/projects/${deps.projectId}/media/${choice.mediaFileId}`);
  return img ? { img, rect: choice.rect } : null;
}

/** Desenha a tela inteira na resolução lógica pedida (canvas 1×; a ampliação inteira é feita fora). */
export function renderScreen(ctx: CanvasRenderingContext2D, payload: ScreenPayload, resolution: Size, deps: RenderDeps, o: RenderOptions): ResolvedInstance[] {
  const [W, H] = resolution;
  ctx.clearRect(0, 0, W, H);
  if (payload.background) {
    const bg = imageBy(deps, payload.background.revisionId);
    if (bg) {
      // Fundo de inspeção: escala inteira que cobre a tela, centralizado.
      const k = Math.max(1, Math.ceil(Math.max(W / bg.rect[2], H / bg.rect[3])));
      const dw = bg.rect[2] * k;
      const dh = bg.rect[3] * k;
      ctx.drawImage(bg.img, bg.rect[0], bg.rect[1], bg.rect[2], bg.rect[3], Math.floor((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh);
    }
  }
  const resolved = layoutScreen(payload, resolution);
  for (const r of resolved) {
    if (!r.visible) continue;
    const inst = r.instance;
    const [x, y, w, h] = r.rect;
    const id = inst.componentRevisionId;
    const ref = id ? deps.revisions.get(id) : undefined;
    const media = (rev: RevisionView, key: string) => {
      const url = mediaOf(deps.projectId, rev, key);
      return url ? (deps.loaded.get(url) ?? null) : null;
    };
    if (ref && (ref.kind === "button" || ref.kind === "menu_item")) {
      const menu = ref.kind === "menu_item" ? MenuItemPayload.parse(ref.revision.payload) : null;
      const buttonRef = menu ? deps.revisions.get(menu.buttonRevisionId) : ref;
      if (!buttonRef) continue;
      const button = ButtonPayload.parse(buttonRef.revision.payload);
      const has = (s: string) => button.states.some((st) => st.state === s);
      // Prévia: pressionado > desabilitado salvo > hover do ponteiro > estado salvo > normal.
      const saved = inst.overrides.state;
      const state = saved === "disabled" ? "disabled" : o.pressed === inst.instanceId && has("pressed") ? "pressed" : o.hover === inst.instanceId && has("hover") ? "hover" : saved && has(saved) ? saved : "normal";
      const st = button.states.find((s) => s.state === state) ?? button.states[0]!;
      const img = media(buttonRef.revision, st.fileId);
      const size: Rect4 = button.nineSlice ? [x, y, w, h] : [x, y, button.logicalSize[0], button.logicalSize[1]];
      if (img) drawNine(ctx, img, st.rect, button.nineSlice, size);
      // Foco é sobreposição desenhada por cima do estado atual (inclusive sobre hover).
      if (o.focus === inst.instanceId && button.focus) {
        const f = media(buttonRef.revision, button.focus.fileId);
        if (f) drawNine(ctx, f, button.focus.rect, button.nineSlice, size);
      }
      const slot = menu?.text ?? button.text;
      const caption = resolveCaption(inst, slot, payload.textCatalog, o.language);
      if (slot && caption.text) {
        try {
          const area = contentArea([size[2], size[3]], button.contentPadding);
          drawCaption(ctx, caption.text, [size[0] + area[0], size[1] + area[1], area[2], area[3]], slot, state === "disabled" ? "#8a8a90" : o.textColor);
        } catch {
          /* padding sem área útil: o compositor acusa */
        }
      }
    } else if (ref?.kind === "panel") {
      const panel = PanelPayload.parse(ref.revision.payload);
      const img = media(ref.revision, panel.image.fileId);
      if (img) drawNine(ctx, img, panel.image.rect, panel.nineSlice, [x, y, w, h]);
    } else if (ref?.kind === "slot") {
      const slot = SlotPayload.parse(ref.revision.payload);
      const want = o.focus === inst.instanceId ? "selected" : (inst.overrides.state ?? (inst.overrides.iconRevisionId ? "occupied" : "empty"));
      const st = slot.states.find((s) => s.state === want) ?? slot.states.find((s) => s.state === "empty") ?? slot.states[0]!;
      const img = media(ref.revision, st.fileId);
      if (img) drawNine(ctx, img, st.rect, slot.nineSlice, slot.nineSlice ? [x, y, w, h] : [x, y, slot.logicalSize[0], slot.logicalSize[1]]);
      const icon = inst.overrides.iconRevisionId ? imageBy(deps, inst.overrides.iconRevisionId) : null;
      if (icon) {
        const [ix, iy, iw, ih] = slot.iconRect;
        ctx.drawImage(icon.img, icon.rect[0], icon.rect[1], icon.rect[2], icon.rect[3], x + ix + Math.floor((iw - icon.rect[2]) / 2), y + iy + Math.floor((ih - icon.rect[3]) / 2), icon.rect[2], icon.rect[3]);
      }
      if (inst.overrides.quantity !== undefined) {
        const [cx, cy] = slotCounterRect(slot, inst.overrides.quantity);
        drawPreviewLine(ctx, String(inst.overrides.quantity), x + cx, y + cy, o.textColor);
      }
    } else if (ref?.kind === "meter") {
      const meter = MeterPayload.parse(ref.revision.payload);
      const value = inst.overrides.value ?? meter.range.max;
      const track = media(ref.revision, meter.track.fileId);
      const fill = media(ref.revision, meter.fill.fileId);
      const frame = media(ref.revision, meter.frame.fileId);
      if (track) ctx.drawImage(track, meter.track.rect[0], meter.track.rect[1], meter.track.rect[2], meter.track.rect[3], x, y, meter.track.rect[2], meter.track.rect[3]);
      const region = meterFillRegion(meter, value);
      if (fill && region) ctx.drawImage(fill, region.src[0], region.src[1], region.src[2], region.src[3], x + region.dst[0], y + region.dst[1], region.dst[2], region.dst[3]);
      // A moldura sempre inteira, por cima.
      if (frame) ctx.drawImage(frame, meter.frame.rect[0], meter.frame.rect[1], meter.frame.rect[2], meter.frame.rect[3], x, y, meter.frame.rect[2], meter.frame.rect[3]);
    } else if (id && deps.images.has(id)) {
      const image = imageBy(deps, id);
      if (image) {
        const dw = Math.min(image.rect[2], w);
        const dh = Math.min(image.rect[3], h);
        ctx.drawImage(image.img, image.rect[0], image.rect[1], dw, dh, x + Math.floor((w - dw) / 2), y, dw, dh);
      }
    } else if (inst.text) {
      const caption = resolveCaption(inst, null, payload.textCatalog, o.language);
      if (caption.text) drawCaption(ctx, caption.text, [x, y, w, h], inst.text, o.textColor);
    }
    if (o.guides && o.focus === inst.instanceId) {
      // Auxílio do editor (não é arte): mostra o foco do teclado mesmo em componente sem overlay de foco.
      ctx.save();
      ctx.setLineDash([2, 1]);
      ctx.strokeStyle = o.focusColor;
      ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
      ctx.restore();
    }
    if (o.guides && (o.selected === inst.instanceId || !id)) {
      ctx.strokeStyle = o.selected === inst.instanceId ? "#00e5ff" : "rgba(0,229,255,0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    }
  }
  return resolved;
}

/** Tamanho lógico natural de uma instância (para inserir e para o contador/ícone). */
export function naturalSize(id: string, deps: Omit<RenderDeps, "loaded">): [number, number] | null {
  const ref = deps.revisions.get(id);
  if (ref) {
    if (ref.kind === "menu_item") {
      const button = deps.revisions.get(MenuItemPayload.parse(ref.revision.payload).buttonRevisionId);
      return button ? naturalSize(button.revision.id, deps) : null;
    }
    const size = (ref.revision.payload as { logicalSize?: [number, number] }).logicalSize;
    return size ?? null;
  }
  const img = deps.images.get(id);
  return img ? [img.rect[2], img.rect[3]] : null;
}

export interface ClientCheck {
  resolution: Size;
  offscreen: string[];
  text: { instanceId: string; outcome: string }[];
  small: string[];
}

/** Mesma conferência do salvar, feita na hora: fora da tela, texto que não cabe e componente menor que o mínimo do nine-slice. */
export function screenProblems(payload: ScreenPayload, resolution: Size, deps: Omit<RenderDeps, "loaded">, language: string): ClientCheck {
  const check: ClientCheck = { resolution, offscreen: [], text: [], small: [] };
  for (const r of layoutScreen(payload, resolution)) {
    if (!r.visible) continue;
    const inst = r.instance;
    const [x, y, w, h] = r.rect;
    if (x < 0 || y < 0 || x + w > resolution[0] || y + h > resolution[1]) check.offscreen.push(inst.instanceId);
    const ref = inst.componentRevisionId ? deps.revisions.get(inst.componentRevisionId) : undefined;
    let slot: TextSlot | null = inst.text ?? null;
    let area: [number, number] = [w, h];
    if (ref && (ref.kind === "button" || ref.kind === "menu_item")) {
      const menu = ref.kind === "menu_item" ? MenuItemPayload.parse(ref.revision.payload) : null;
      const buttonRef = menu ? deps.revisions.get(menu.buttonRevisionId) : ref;
      if (!buttonRef) continue;
      const button = ButtonPayload.parse(buttonRef.revision.payload);
      slot = menu?.text ?? button.text;
      const size: [number, number] = button.nineSlice ? [w, h] : button.logicalSize;
      if (button.nineSlice && (w < button.nineSlice.left + button.nineSlice.right + 1 || h < button.nineSlice.top + button.nineSlice.bottom + 1)) check.small.push(inst.instanceId);
      try {
        const c = contentArea(size, button.contentPadding);
        area = [c[2], c[3]];
      } catch {
        area = [0, 0];
      }
    }
    if (slot) {
      const caption = resolveCaption(inst, slot, payload.textCatalog, language);
      if (caption.text) {
        const layout = layoutText(caption.text, area, slot);
        if (layout.overflow) check.text.push({ instanceId: inst.instanceId, outcome: layout.outcome });
      }
    }
  }
  return check;
}
