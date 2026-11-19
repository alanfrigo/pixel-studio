import { crc32 } from "node:zlib";

/**
 * PNG mínimo para fixtures e inspeção. O codificador usa blocos deflate
 * "stored" (sem compressão), o que torna os bytes idênticos em qualquer versão
 * de zlib/Node — necessário para fixtures com hash fixo. O processamento raster
 * de produção fica no Python/Pillow (05).
 */

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA 8 bits, alfa direto, linha a linha. */
  data: Uint8Array;
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export type Rgba = readonly [number, number, number, number];

export function setPixel(img: RgbaImage, x: number, y: number, [r, g, b, a]: Rgba): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) throw new RangeError(`Pixel fora da imagem: ${x},${y}`);
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

export function getPixel(img: RgbaImage, x: number, y: number): Rgba {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

export function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, color: Rgba): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(img, xx, yy, color);
}

function u32(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0);
  return b;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = new Uint8Array(typeBytes.length + payload.length);
  crcInput.set(typeBytes);
  crcInput.set(payload, typeBytes.length);
  return concat([u32(payload.length), crcInput, u32(crc32(crcInput))]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Stream zlib com blocos deflate "stored" de até 65535 bytes. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  const MAX = 65535;
  let offset = 0;
  do {
    const len = Math.min(MAX, raw.length - offset);
    const final = offset + len >= raw.length ? 1 : 0;
    parts.push(Uint8Array.from([final, len & 0xff, len >> 8, ~len & 0xff, (~len >> 8) & 0xff]));
    parts.push(raw.subarray(offset, offset + len));
    offset += len;
  } while (offset < raw.length);
  parts.push(u32(adler32(raw)));
  return concat(parts);
}

/** Codifica RGBA 8 bits, sem entrelaçamento, filtro 0 em todas as linhas. */
export function encodePng(img: RgbaImage): Uint8Array {
  if (img.data.length !== img.width * img.height * 4) throw new RangeError("Tamanho de dados RGBA incoerente");
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, img.width);
  v.setUint32(4, img.height);
  ihdr[8] = 8; // profundidade
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = img.width * 4;
  const raw = new Uint8Array((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))]);
}

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

/** Lê o IHDR sem decodificar pixels (limite de ingestão antes de expandir). */
export function readPngInfo(bytes: Uint8Array): PngInfo | null {
  if (bytes.length < 33) return null;
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(8) !== 13 || new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR") return null;
  return {
    width: v.getUint32(16),
    height: v.getUint32(20),
    bitDepth: bytes[24]!,
    colorType: bytes[25]!,
    interlaced: bytes[28] === 1,
  };
}
