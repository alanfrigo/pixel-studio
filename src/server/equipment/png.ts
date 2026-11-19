import { crc32, deflateSync, inflateSync } from "node:zlib";
import { createImage, type RgbaImage } from "@/lib/media/png";

/**
 * PNG compacto para a arte sintética e o provedor simulado do cartão S2:
 * codificação com deflate (o codificador da fixture usa blocos "stored" para
 * bytes estáveis entre versões de zlib) e decodificação de PNG de 8 bits sem
 * entrelaçamento (RGBA, RGB, cinza, cinza+alfa e paleta), o que o Pillow grava.
 * O processamento raster de produção continua no Python.
 */

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

function chunk(type: string, data: Buffer): Buffer {
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  return Buffer.concat([u32(data.length), td, u32(crc32(td))]);
}

export function encodePngDeflate(img: RgbaImage): Uint8Array {
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (img.width * 4 + 1)] = 0;
    Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(raw, y * (img.width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]),
  );
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const buf = Buffer.from(bytes);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("PNG: só 8 bits sem entrelaçamento");
      colorType = data[9]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`PNG: tipo de cor ${colorType} não suportado`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = createImage(width, height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      let r: number, g: number, bl: number, al: number;
      switch (colorType) {
        case 6:
          [r, g, bl, al] = [line[s]!, line[s + 1]!, line[s + 2]!, line[s + 3]!];
          break;
        case 2:
          [r, g, bl, al] = [line[s]!, line[s + 1]!, line[s + 2]!, 255];
          break;
        case 0:
          [r, g, bl, al] = [line[s]!, line[s]!, line[s]!, 255];
          break;
        case 4:
          [r, g, bl, al] = [line[s]!, line[s]!, line[s]!, line[s + 1]!];
          break;
        default: {
          const idx = line[s]!;
          [r, g, bl] = [palette?.[idx * 3] ?? 0, palette?.[idx * 3 + 1] ?? 0, palette?.[idx * 3 + 2] ?? 0];
          al = trns && idx < trns.length ? trns[idx]! : 255;
        }
      }
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = bl;
      out.data[o + 3] = al;
    }
    prev = line;
  }
  return out;
}
