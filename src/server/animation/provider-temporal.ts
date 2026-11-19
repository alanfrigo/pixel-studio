import { createHash } from "node:crypto";
import { type Capability, type PlanOperation, type ReferenceSheet, TEMPORAL_OPERATIONS } from "@/contracts";
import { createImage, encodePng, type RgbaImage, setPixel } from "@/lib/media/png";
import { decodePng } from "../equipment/png";
import type { ProviderSubmitRequest } from "../providers/types";

/**
 * Capacidades das operações do cartão S3 (estados, objetos, interpolação,
 * edição de trecho, roupa e correção de quadro), no mesmo molde de
 * `world/provider-caps.ts`: os adaptadores delegam para cá.
 *
 * - Rota genérica (imagem + referências): o modelo desenha uma folha na grade
 *   do plano. Nunca declara interpolação, edição ou transferência nativas.
 * - Rota nativa: um provedor que declara a capacidade própria da operação
 *   (`frame_interpolation`, `animation_edit`, `outfit_transfer`, `native_mask`)
 *   recebe os quadros como imagens separadas e devolve um quadro por imagem.
 *   Estado e animação de objeto só existem como folha por imagem + referências.
 */

export const S3_OPERATIONS: PlanOperation[] = ["create_state", ...TEMPORAL_OPERATIONS];

export function isTemporalOperation(operation: PlanOperation): boolean {
  return S3_OPERATIONS.includes(operation);
}

/** Referências que cada operação envia numa rota genérica (a primeira é a folha/fonte). */
export const GENERIC_REFERENCES: Partial<Record<PlanOperation, number>> = {
  create_state: 1,
  animate_object: 1,
  interpolate_frames: 2,
  edit_animation: 1,
  transfer_outfit: 2,
  correct_frame: 2,
};

/** Rota genérica: folha por imagem + referências; correção de quadro = candidato editado + recorte local. */
export function genericTemporalCapabilities(operation: PlanOperation, maxReferences: number): Capability[] {
  if (operation === "correct_frame") return maxReferences >= 2 ? ["image_edit"] : [];
  return maxReferences >= 1 ? ["text_to_image", "image_references"] : [];
}

// ---------------------------------------------------------------------------
// Provedor simulado
// ---------------------------------------------------------------------------

/** Simulado: ensaia as rotas nativas (fila, publicação, revisão) sem custo; nunca vira provedor real. */
export function simulatedTemporalCapabilities(operation: PlanOperation): Capability[] {
  switch (operation) {
    case "create_state":
    case "animate_object":
      return ["image_references"];
    case "interpolate_frames":
      return ["frame_interpolation", "image_references"];
    case "edit_animation":
      return ["animation_edit", "image_references"];
    case "transfer_outfit":
      return ["outfit_transfer", "image_references"];
    case "correct_frame":
      return ["image_edit", "native_mask", "image_references"];
    default:
      return [];
  }
}

export interface SimulatedTemporalJob {
  operation: PlanOperation;
  count: number;
  size: [number, number];
  /** Rota genérica (estado, objeto): a folha devolvida, PNG em base64. */
  sheet?: string;
}

/** Operações que o simulado atende como folha desenhada por imagem + referências. */
const SIMULATED_SHEET_OPS: PlanOperation[] = ["create_state", "animate_object"];

export function simulatedTemporalJob(request: ProviderSubmitRequest): SimulatedTemporalJob | null {
  if (!isTemporalOperation(request.operation)) return null;
  const p = request.params as Record<string, unknown>;
  const size = (p.logicalSize as [number, number] | undefined) ?? [32, 32];
  const sheet = p.sheet as ReferenceSheet | undefined;
  const source = request.references.find((r) => r.role === "source" && r.mime === "image/png");
  if (sheet && source && SIMULATED_SHEET_OPS.includes(request.operation)) {
    const png = simulatedSheet(request.operation, sheet, source.bytes, request.prompt);
    return { operation: request.operation, count: 1, size, sheet: Buffer.from(png).toString("base64") };
  }
  const count = (() => {
    switch (request.operation) {
      case "interpolate_frames":
        // A rota nativa decide a contagem; o simulado devolve 3 intermediários quando o plano não fixa.
        return (p.count as number | null) ?? 3;
      case "edit_animation":
      case "transfer_outfit":
        return (p.frameIds as unknown[]).length;
      default:
        return 1;
    }
  })();
  return { operation: request.operation, count, size };
}

/**
 * Folha simulada na grade do plano: o estado redesenha a folha de referência
 * (mesma disposição) e a animação de objeto repete a vista ampliada em cada
 * célula pedida. Os pixels opacos ganham uma tinta determinística por quadro
 * (a cor-chave do fundo fica intacta), o que basta para ensaiar o fatiamento local.
 */
function simulatedSheet(operation: PlanOperation, sheet: ReferenceSheet, bytes: Uint8Array, prompt: string): Uint8Array {
  const src = decodePng(bytes);
  const single = operation === "animate_object";
  const cw = single ? src.width : Math.floor(src.width / sheet.columns);
  const ch = single ? src.height : Math.floor(src.height / sheet.rows);
  const out = createImage(cw * sheet.columns, ch * sheet.rows);
  const key = sheet.backgroundKey ? pixel(src, 0, 0) : null;
  if (key) for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) setPixel(out, x, y, key);
  const digest = createHash("sha256").update(`${operation}|${prompt}`).digest();
  sheet.frameIds.forEach((_, i) => {
    const [ox, oy] = [(i % sheet.columns) * cw, Math.floor(i / sheet.columns) * ch];
    const [sx, sy] = single ? [0, 0] : [ox, oy];
    const tint = [digest[(i * 3) % 30]!, digest[(i * 3 + 1) % 30]!, digest[(i * 3 + 2) % 30]!];
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const [r, g, b, a] = pixel(src, sx + x, sy + y);
        if (a === 0 || (key && r === key[0] && g === key[1] && b === key[2])) continue;
        setPixel(out, ox + x, oy + y, [mix(r, tint[0]!), mix(g, tint[1]!), mix(b, tint[2]!), a]);
      }
    }
  });
  return encodePng(out);
}

function pixel(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

function mix(channel: number, tint: number): number {
  return Math.round(channel * 0.8 + tint * 0.2);
}

/** Losango determinístico por operação e índice, apoiado no chão da célula (tela inteira nova). */
export function simulatedTemporalImages(job: SimulatedTemporalJob, prompt: string): Uint8Array[] {
  if (job.sheet) return [new Uint8Array(Buffer.from(job.sheet, "base64"))];
  const [w, h] = job.size;
  return Array.from({ length: job.count }, (_, i) => {
    const digest = createHash("sha256").update(`${job.operation}|${prompt}|${i}`).digest();
    const img = createImage(w, h);
    const r = Math.max(2, Math.floor(Math.min(w, h) / 3));
    const cx = Math.floor(w / 2) + ((i % 3) - 1);
    const cy = h - 2 - r - (i % 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(x - cx) + Math.abs(y - cy);
        if (d <= r - 1) setPixel(img, x, y, [digest[0]!, digest[1]!, digest[2]!, 255]);
        else if (d <= r) setPixel(img, x, y, [20, 20, 28, 255]);
      }
    }
    return encodePng(img);
  });
}
