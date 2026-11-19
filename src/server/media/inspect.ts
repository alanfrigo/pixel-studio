import type { FileModality } from "@/contracts";
import { readPngInfo } from "@/lib/media/png";
import { readWavInfo } from "@/lib/media/wav";

/**
 * Inspeção por modalidade (02 §módulos `src/server/media`). Identifica o tipo
 * pelos bytes, nunca pelo nome ou pelo MIME declarado. Raster é normalizado no
 * Python (orientação EXIF, perfil de cor, paleta); aqui só lemos cabeçalhos
 * para aplicar limites antes de expandir pixels.
 */

export interface Sniffed {
  modality: FileModality;
  mime: string;
  format: string;
}

export function sniff(bytes: Uint8Array): Sniffed | null {
  const b = (i: number) => bytes[i] ?? -1;
  const ascii = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (b(0) === 0x89 && ascii(1, 3) === "PNG") return { modality: "raster", mime: "image/png", format: "png" };
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { modality: "raster", mime: "image/jpeg", format: "jpeg" };
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { modality: "raster", mime: "image/gif", format: "gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { modality: "raster", mime: "image/webp", format: "webp" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { modality: "audio", mime: "audio/wav", format: "wav" };
  if (b(0) === 0x00 && b(1) === 0x01 && b(2) === 0x00 && b(3) === 0x00) return { modality: "font", mime: "font/ttf", format: "ttf" };
  if (ascii(0, 4) === "OTTO") return { modality: "font", mime: "font/otf", format: "otf" };
  // Pacote portátil (reabrir ZIP exportado).
  if (ascii(0, 4) === "PK\u0003\u0004") return { modality: "data", mime: "application/zip", format: "zip" };
  return null;
}

export interface RasterHeader {
  width: number;
  height: number;
}

/** Dimensões declaradas no cabeçalho, quando legíveis sem decodificar. */
export function rasterHeader(bytes: Uint8Array, format: string): RasterHeader | null {
  if (format === "png") {
    const info = readPngInfo(bytes);
    return info && { width: info.width, height: info.height };
  }
  if (format === "gif" && bytes.length >= 10) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  }
  return null;
}

export interface AudioMetadata {
  durationMs: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
  codec: string;
}

export function inspectAudio(bytes: Uint8Array, format: string): AudioMetadata | null {
  if (format !== "wav") return null;
  const info = readWavInfo(bytes);
  if (!info || info.frameCount === 0) return null;
  return { durationMs: info.durationMs, sampleRate: info.sampleRate, channels: info.channels, frameCount: info.frameCount, codec: info.codec };
}

export interface FontMetadata {
  glyphCount: number;
  unitsPerEm: number;
  tables: string[];
}

/** Lê o diretório de tabelas sfnt e os campos `maxp.numGlyphs` e `head.unitsPerEm`. */
export function inspectFont(bytes: Uint8Array): FontMetadata | null {
  if (bytes.length < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = v.getUint16(4);
  if (numTables === 0 || 12 + numTables * 16 > bytes.length) return null;
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(o, o + 4));
    tables.set(tag, { offset: v.getUint32(o + 8), length: v.getUint32(o + 12) });
  }
  const maxp = tables.get("maxp");
  const head = tables.get("head");
  if (!maxp || !head || maxp.offset + 6 > bytes.length || head.offset + 20 > bytes.length) return null;
  return {
    glyphCount: v.getUint16(maxp.offset + 4),
    unitsPerEm: v.getUint16(head.offset + 18),
    tables: [...tables.keys()].sort(),
  };
}
