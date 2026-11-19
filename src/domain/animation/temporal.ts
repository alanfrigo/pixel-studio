import type { ClipPayload, Direction, FrameLayout, Offset, PixelIndex } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { tx } from "@/i18n/locales";
import { ClipEditError } from "./timeline";

/**
 * Edição temporal sem refazer tudo (04 §interpolar, editar e corrigir): funções
 * puras sobre o payload do clipe. Quadros não tocados mantêm o MESMO payload
 * (camadas, retângulos, sockets, duração) e, portanto, os mesmos arquivos; os
 * novos recebem IDs novos; eventos ficam presos ao ID do quadro e remover um
 * quadro com evento exige remapeamento explícito.
 */

type Frame = ClipPayload["frames"][number];
type Layer = Frame["layers"][number];
type Socket = Frame["sockets"][number];

/** Divide um total em `count` durações inteiras ≥ 1, o resto nos primeiros quadros (soma exata). */
export function distributeDurations(totalMs: number, count: number): number[] {
  if (count < 1) return [];
  const total = Math.max(count, Math.round(totalMs));
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** IDs novos para os intermediários entre `a` e `b`, sem colidir com os existentes. */
export function intermediateFrameIds(existing: Iterable<string>, a: string, b: string, count: number): string[] {
  const used = new Set(existing);
  const stem = `${a}-${b}`.slice(0, 100);
  const ids: string[] = [];
  for (let i = 1; ids.length < count; i++) {
    const id = `${stem}-i${String(i).padStart(2, "0")}`;
    if (!used.has(id)) {
      ids.push(id);
      used.add(id);
    }
  }
  return ids;
}

/** Sockets presentes nos dois keyframes, na posição interpolada (índice de pixel inteiro). */
export function interpolateSockets(a: readonly Socket[], b: readonly Socket[], t: number): Socket[] {
  return a
    .filter((s) => b.some((x) => x.socketId === s.socketId))
    .map((s) => {
      const e = b.find((x) => x.socketId === s.socketId)!;
      const at: PixelIndex = [Math.round(s.at[0] + (e.at[0] - s.at[0]) * t), Math.round(s.at[1] + (e.at[1] - s.at[1]) * t)];
      return { socketId: s.socketId, at, hidden: s.hidden || e.hidden };
    });
}

export function interpolateOffset(a: Offset, b: Offset, t: number): Offset {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t)];
}

/** Quadro de arquivo único na célula inteira (o que geração e edição produzem). */
export function cellFrame(frameId: string, durationMs: number, fileId: string, [w, h]: [number, number], extra: Partial<Pick<Frame, "sockets" | "rootOffset">> = {}, partId = "body"): Frame {
  return { frameId, durationMs, layers: [{ partId, fileId, rect: [0, 0, w, h], offset: [0, 0] }], sockets: extra.sockets ?? [], rootOffset: extra.rootOffset ?? [0, 0] };
}

/** Insere quadros logo depois de `afterFrameId`; todos os demais ficam idênticos. */
export function insertFrames(clip: ClipPayload, afterFrameId: string, frames: Frame[]): ClipPayload {
  const index = clip.frames.findIndex((f) => f.frameId === afterFrameId);
  if (index < 0) throw new ClipEditError(tx(`Quadro ${afterFrameId} não existe no clipe`, `Frame ${afterFrameId} is not in the clip`));
  const ids = new Set(clip.frames.map((f) => f.frameId));
  for (const f of frames) if (ids.has(f.frameId)) throw new ClipEditError(tx(`ID de quadro repetido: ${f.frameId}`, `Duplicate frame ID: ${f.frameId}`));
  return { ...clip, frames: [...clip.frames.slice(0, index + 1), ...frames, ...clip.frames.slice(index + 1)] };
}

/** Os dois quadros são vizinhos na ordem do clipe (ou fecham o ciclo: último → primeiro)? */
export function adjacent(clip: ClipPayload, a: string, b: string): boolean {
  const i = clip.frames.findIndex((f) => f.frameId === a);
  const j = clip.frames.findIndex((f) => f.frameId === b);
  if (i < 0 || j < 0) return false;
  return j === i + 1 || (clip.playback === "loop" && i === clip.frames.length - 1 && j === 0);
}

/** Troca as camadas dos quadros indicados; IDs, durações, sockets e eventos ficam. */
export function replaceFrameLayers(clip: ClipPayload, replacements: Record<string, Layer[]>): ClipPayload {
  for (const id of Object.keys(replacements)) {
    if (!clip.frames.some((f) => f.frameId === id)) throw new ClipEditError(tx(`Quadro ${id} não existe no clipe`, `Frame ${id} is not in the clip`));
  }
  return { ...clip, frames: clip.frames.map((f) => (replacements[f.frameId] ? { ...f, layers: replacements[f.frameId]! } : f)) };
}

/** Troca uma camada (por `partId`) de um quadro, na mesma posição de desenho. */
export function replaceLayer(clip: ClipPayload, frameId: string, partId: string, layer: Layer): ClipPayload {
  const frame = clip.frames.find((f) => f.frameId === frameId);
  if (!frame) throw new ClipEditError(tx(`Quadro ${frameId} não existe no clipe`, `Frame ${frameId} is not in the clip`));
  const index = frame.layers.findIndex((l) => l.partId === partId);
  if (index < 0) throw new ClipEditError(tx(`O quadro ${frameId} não tem a camada ${partId}`, `Frame ${frameId} has no layer ${partId}`));
  return replaceFrameLayers(clip, { [frameId]: frame.layers.map((l, i) => (i === index ? layer : l)) });
}

export interface RemoveFramesResult {
  clip: ClipPayload;
  removedEvents: string[];
  remappedEvents: { eventId: string; from: string; to: string }[];
}

/**
 * Remove quadros. Evento num quadro removido exige decisão explícita em
 * `remap`: novo `frameId` (que continua no clipe) ou `null` (o evento sai).
 */
export function removeFrames(clip: ClipPayload, frameIds: string[], remap: Record<string, string | null> = {}): RemoveFramesResult {
  const removing = new Set(frameIds);
  for (const id of removing) if (!clip.frames.some((f) => f.frameId === id)) throw new ClipEditError(tx(`Quadro ${id} não existe no clipe`, `Frame ${id} is not in the clip`));
  const frames = clip.frames.filter((f) => !removing.has(f.frameId));
  if (frames.length === 0) throw new ClipEditError(tx("Um clipe precisa de ao menos um quadro", "A clip needs at least one frame"));
  const remaining = new Set(frames.map((f) => f.frameId));
  const events: ClipPayload["events"] = [];
  const removedEvents: string[] = [];
  const remappedEvents: RemoveFramesResult["remappedEvents"] = [];
  for (const event of clip.events) {
    if (!removing.has(event.frameId)) {
      events.push(event);
      continue;
    }
    if (!(event.eventId in remap)) throw new ClipEditError(tx(`O evento ${event.eventId} está no quadro removido ${event.frameId}: remapeie-o para outro quadro ou remova-o explicitamente`, `Event ${event.eventId} is on removed frame ${event.frameId}: remap it to another frame or remove it explicitly`));
    const to = remap[event.eventId];
    if (to === null || to === undefined) {
      removedEvents.push(event.eventId);
      continue;
    }
    if (!remaining.has(to)) throw new ClipEditError(tx(`O evento ${event.eventId} foi remapeado para ${to}, que não fica no clipe`, `Event ${event.eventId} was remapped to ${to}, which is not kept in the clip`));
    events.push({ ...event, frameId: to });
    remappedEvents.push({ eventId: event.eventId, from: event.frameId, to });
  }
  return { clip: { ...clip, frames, events }, removedEvents, remappedEvents };
}

/** Retira uma parte desenhável (camada) de todos os quadros; cada quadro precisa manter ao menos uma camada. */
export function removePart(clip: ClipPayload, partId: string): ClipPayload {
  if (!clip.frames.some((f) => f.layers.some((l) => l.partId === partId))) throw new ClipEditError(tx(`Nenhum quadro tem a parte ${partId}`, `No frame has part ${partId}`));
  const frames = clip.frames.map((f) => {
    const layers = f.layers.filter((l) => l.partId !== partId);
    if (layers.length === 0) throw new ClipEditError(tx(`O quadro ${f.frameId} ficaria sem camadas; remova o quadro em vez da parte`, `Frame ${f.frameId} would have no layers; remove the frame instead of the part`));
    return { ...f, layers };
  });
  return { ...clip, frames };
}

/** Espelho horizontal só entre vistas laterais: N e S encaram a câmera e não têm par. */
export const MIRROR_PAIR: Partial<Record<Direction, Direction>> = { E: "W", W: "E", NE: "NW", NW: "NE", SE: "SW", SW: "SE" };

/** Índice de pixel espelhado (`W − 1 − x`) e ponto da grade espelhado (`W − x`), 04 §exemplo de encaixe. */
export function mirrorPixel([x, y]: PixelIndex, width: number): PixelIndex {
  return [width - 1 - x, y];
}

export function mirrorGridPoint([x, y]: [number, number], width: number): [number, number] {
  return [width - x, y];
}

/**
 * Digest da geometria de um quadro (camadas por hash do arquivo + retângulo,
 * posição, ordem; sockets; movimento da raiz; duração). Dois quadros com o
 * mesmo digest desenham os mesmos pixels no mesmo lugar e no mesmo tempo.
 */
export function frameDigest(frame: Frame, fileSha: (fileId: string) => string): string {
  return canonicalDigest({
    durationMs: frame.durationMs,
    layers: frame.layers.map((l) => ({ partId: l.partId, sha256: fileSha(l.fileId), rect: l.rect, offset: l.offset })),
    sockets: frame.sockets,
    rootOffset: frame.rootOffset,
  });
}

/** Composição congelada (plano) dos quadros pedidos: cada arquivo distinto vira uma fonte, na ordem de primeira aparição. */
export function frameLayouts(clip: ClipPayload, frameIds: string[], firstOrdinal: number, partId?: string): { layouts: FrameLayout[]; files: string[] } {
  const files: string[] = [];
  const layouts = frameIds.map((frameId) => {
    const frame = clip.frames.find((f) => f.frameId === frameId);
    if (!frame) throw new ClipEditError(tx(`Quadro ${frameId} não existe no clipe`, `Frame ${frameId} is not in the clip`));
    const layers = partId ? frame.layers.filter((l) => l.partId === partId) : frame.layers;
    if (layers.length === 0) throw new ClipEditError(tx(`O quadro ${frameId} não tem a camada ${partId}`, `Frame ${frameId} has no layer ${partId}`));
    return {
      frameId,
      layers: layers.map((l) => {
        if (!files.includes(l.fileId)) files.push(l.fileId);
        return { source: firstOrdinal + files.indexOf(l.fileId), rect: l.rect, offset: l.offset };
      }),
    };
  });
  return { layouts, files };
}
