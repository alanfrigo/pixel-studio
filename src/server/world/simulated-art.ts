import { createHash } from "node:crypto";
import { createImage, encodePng, type RgbaImage, setPixel } from "@/lib/media/png";
import type { ProviderSubmitRequest } from "../providers/types";

/**
 * Respostas do provedor SIMULADO para o mundo (T1), identificadas como
 * simuladas na interface: material repetível por construção (ruído no toro,
 * desenhado 4× para exercitar a recuperação da grade) e tileset guiado que
 * devolve o próprio gabarito recebido (exercita ajuste, faixa travada e emendas).
 */

export interface SimulatedWorldJob {
  /** PNG (base64) do gabarito recebido como primeira referência. */
  echo?: string;
  texture?: boolean;
}

export function simulatedWorldJob(request: Pick<ProviderSubmitRequest, "operation" | "references">): SimulatedWorldJob | null {
  if (request.operation === "generate_tileset" && request.references[0]) return { echo: Buffer.from(request.references[0].bytes).toString("base64") };
  if (request.operation === "generate_texture") return { texture: true };
  return null;
}

export function simulatedWorldImage(job: { prompt: string; size: [number, number]; world?: SimulatedWorldJob }): Uint8Array {
  if (job.world?.echo) return new Uint8Array(Buffer.from(job.world.echo, "base64"));
  return simulatedTexture(job.prompt, job.size, 4);
}

/** Material contínuo nas duas direções: ruído borrado com volta (toro), ampliado `scale`× sem suavização. */
export function simulatedTexture(prompt: string, size: [number, number], scale = 1): Uint8Array {
  return encodePng(torusTexture(prompt, size, scale));
}

/** Imagem do material contínuo (para testes e scripts que ajustam pixels antes de codificar). */
export function torusTexture(prompt: string, [w, h]: [number, number], scale = 1, color?: readonly [number, number, number]): RgbaImage {
  const digest = createHash("sha256").update(prompt).digest();
  const base = color ?? [60 + (digest[0]! % 120), 60 + (digest[1]! % 120), 60 + (digest[2]! % 120)];
  let state = digest.readUInt32BE(4) || 1;
  const rand = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) % 1000) / 1000;
  const raw = Array.from({ length: h }, () => Array.from({ length: w }, () => rand() * 60 - 30));
  const img = createImage(w * scale, h * scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) acc += raw[(y + dy + h) % h]![(x + dx + w) % w]!;
      const v = Math.round(acc / 9);
      const color = [base[0]! + v, base[1]! + v, base[2]! + v, 255].map((c) => Math.max(0, Math.min(255, c))) as [number, number, number, number];
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) setPixel(img, x * scale + sx, y * scale + sy, color);
    }
  }
  return img;
}
