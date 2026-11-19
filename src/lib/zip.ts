import { type LocalizedText, tx } from "@/i18n/locales";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { relativePathProblem } from "@/contracts";

/**
 * ZIP mínimo para o pacote portátil (02a §formato portátil). Escrita com
 * métodos "stored" (PNG já comprimido) ou "deflate" (JSON), nomes UTF-8.
 * Leitura defensiva: caminhos seguros, sem duplicatas, sem links simbólicos,
 * sem criptografia/ZIP64, limites de tamanho e CRC conferido.
 */

export interface ZipInput {
  path: string;
  bytes: Uint8Array;
  compress: boolean;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_U32 = 0xffffffff;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Codifica sem validar nomes (uso interno e testes de leitura hostil). */
export function encodeZip(entries: ZipInput[], date = new Date("2026-01-01T00:00:00Z")): Uint8Array {
  const { time, date: dosDate } = dosDateTime(date);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const data = entry.compress ? new Uint8Array(deflateRawSync(entry.bytes, { level: 9 })) : entry.bytes;
    const method = entry.compress ? 8 : 0;
    const crc = crc32(entry.bytes) >>> 0;
    if (data.length >= MAX_U32 || entry.bytes.length >= MAX_U32 || offset >= MAX_U32) throw new RangeError("Pacote exige ZIP64, não suportado");

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, entry.bytes.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 0x0314, true); // Unix, versão 2.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, entry.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true); // arquivo regular rw-r--r--
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function writeZip(entries: ZipInput[], date?: Date): Uint8Array {
  if (entries.length >= 0xffff) throw new RangeError("Pacote com arquivos demais para ZIP sem ZIP64");
  const seen = new Set<string>();
  for (const e of entries) {
    const problem = relativePathProblem(e.path);
    if (problem) throw new Error(`Caminho inválido no pacote (${e.path}): ${problem}`);
    const key = e.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Caminho duplicado no pacote: ${e.path}`);
    seen.add(key);
  }
  return encodeZip(entries, date);
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 10_000, maxEntryBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 };

/** Pacote recusado na leitura. Como `DomainFailure`: `Error.message` em português, os dois idiomas em `messages`. */
export class ZipError extends Error {
  readonly messages: LocalizedText | null;

  constructor(message: string | LocalizedText) {
    super(typeof message === "string" ? message : message["pt-BR"]);
    this.messages = typeof message === "string" ? null : message;
    this.name = "ZipError";
  }
}

interface CentralEntry {
  path: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

export interface ZipArchive {
  paths: string[];
  has(path: string): boolean;
  read(path: string): Uint8Array;
}

export function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError(tx("Arquivo não é um ZIP (fim do diretório central ausente)", "File is not a ZIP (end of central directory missing)"));
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (v.getUint16(eocd + 4, true) !== 0 || v.getUint16(eocd + 8, true) !== count) throw new ZipError(tx("ZIP multivolume não suportado", "Multi-volume ZIP is not supported"));
  if (count === 0xffff || cdOffset === MAX_U32 || cdSize === MAX_U32) throw new ZipError(tx("ZIP64 não suportado", "ZIP64 is not supported"));
  if (count > limits.maxEntries) throw new ZipError(tx(`ZIP com ${count} entradas excede o limite`, `ZIP with ${count} entries exceeds the limit`));
  if (cdOffset + cdSize > eocd) throw new ZipError(tx("Diretório central fora do arquivo", "Central directory is outside the file"));

  const entries = new Map<string, CentralEntry>();
  const lowerNames = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== CENTRAL_SIG) throw new ZipError(tx("Diretório central corrompido", "Central directory is corrupted"));
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const compressedSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const external = v.getUint32(p + 38, true);
    const offset = v.getUint32(p + 42, true);
    const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError(tx(`${path}: arquivo criptografado não suportado`, `${path}: encrypted file not supported`));
    if (compressedSize === MAX_U32 || size === MAX_U32 || offset === MAX_U32) throw new ZipError(tx("ZIP64 não suportado", "ZIP64 is not supported"));
    if (((external >>> 16) & 0o170000) === 0o120000) throw new ZipError(tx(`${path}: link simbólico recusado`, `${path}: symbolic link refused`));
    if (path.endsWith("/")) continue; // diretório
    const problem = relativePathProblem(path);
    if (problem) throw new ZipError(tx(`Caminho inseguro no ZIP (${path}): ${problem}`, `Unsafe path in the ZIP (${path}): ${problem}`));
    if (lowerNames.has(path.toLowerCase())) throw new ZipError(tx(`Caminho duplicado no ZIP: ${path}`, `Duplicate path in the ZIP: ${path}`));
    if (method !== 0 && method !== 8) throw new ZipError(tx(`${path}: método de compressão ${method} não suportado`, `${path}: compression method ${method} not supported`));
    if (size > limits.maxEntryBytes) throw new ZipError(tx(`${path}: ${size} bytes excede o limite por arquivo`, `${path}: ${size} bytes exceeds the per-file limit`));
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError(tx("Conteúdo descompactado excede o limite do pacote", "Uncompressed content exceeds the package limit"));
    lowerNames.add(path.toLowerCase());
    entries.set(path, { path, method, crc, compressedSize, size, offset });
  }

  return {
    paths: [...entries.keys()],
    has: (path) => entries.has(path),
    read(path) {
      const e = entries.get(path);
      if (!e) throw new ZipError(tx(`Arquivo ausente no ZIP: ${path}`, `File missing from the ZIP: ${path}`));
      if (e.offset + 30 > bytes.length || v.getUint32(e.offset, true) !== LOCAL_SIG) throw new ZipError(tx(`${path}: cabeçalho local inválido`, `${path}: invalid local header`));
      const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
      if (start + e.compressedSize > bytes.length) throw new ZipError(tx(`${path}: dados truncados`, `${path}: truncated data`));
      const raw = bytes.subarray(start, start + e.compressedSize);
      let data: Uint8Array;
      try {
        data = e.method === 0 ? raw.slice() : new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }));
      } catch {
        throw new ZipError(tx(`${path}: falha ao descompactar`, `${path}: failed to decompress`));
      }
      if (data.length !== e.size) throw new ZipError(tx(`${path}: tamanho diverge do diretório central`, `${path}: size does not match the central directory`));
      if ((crc32(data) >>> 0) !== e.crc) throw new ZipError(tx(`${path}: CRC diverge (arquivo corrompido)`, `${path}: CRC mismatch (corrupted file)`));
      return data;
    },
  };
}
