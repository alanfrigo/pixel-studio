/**
 * WAV PCM mínimo: escrita para fixtures e leitura de metadados (taxa, canais,
 * frames, duração) para validar áudio sem tratá-lo como raster.
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frameCount: number;
  durationMs: number;
  codec: string;
}

/** Codifica amostras inteiras de 16 bits intercaladas por canal. */
export function encodeWavPcm16(samples: Int16Array, sampleRate: number, channels: number): Uint8Array {
  if (samples.length % channels !== 0) throw new RangeError("Amostras não fecham frames completos");
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i]!, true);
  return out;
}

export function readWavInfo(bytes: Uint8Array): WavInfo | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = v.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16) {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === "data" && fmt) {
      if (fmt.blockAlign === 0 || fmt.sampleRate === 0) return null;
      const frameCount = Math.floor(Math.min(size, bytes.length - body) / fmt.blockAlign);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        frameCount,
        durationMs: Math.round((frameCount / fmt.sampleRate) * 1000),
        codec: fmt.format === 1 ? `pcm_s${fmt.bits}le` : `wav_format_${fmt.format}`,
      };
    }
    offset = body + size + (size % 2);
  }
  return null;
}
