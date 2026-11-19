import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { verifyManifestFiles } from "@/domain/manifest/verify-files";
import { validateManifest } from "@/domain/manifest/validate";
import { readPngInfo } from "@/lib/media/png";
import { readWavInfo } from "@/lib/media/wav";
import { buildClareira } from "./clareira";
import { allFixtureFiles } from "./layout";

const root = path.resolve(import.meta.dirname, "..", "..", "fixtures", "clareira");
const fixture = buildClareira();

/** Decodifica um PNG RGBA 8 bits sem filtro (como o nosso codificador grava). */
function decodeRgba(bytes: Uint8Array) {
  const info = readPngInfo(bytes)!;
  const idat: Uint8Array[] = [];
  let o = 8;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (o < bytes.length) {
    const len = v.getUint32(o);
    const type = new TextDecoder().decode(bytes.subarray(o + 4, o + 8));
    if (type === "IDAT") idat.push(bytes.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = info.width * 4;
  return {
    ...info,
    pixel(x: number, y: number) {
      expect(raw[y * (stride + 1)]).toBe(0);
      const i = y * (stride + 1) + 1 + x * 4;
      return [...raw.subarray(i, i + 4)];
    },
  };
}

describe("fixture clareira no disco", () => {
  it("bate byte a byte com o gerador (rode npm run fixtures:build se mudar o gerador)", async () => {
    for (const file of allFixtureFiles(fixture)) {
      const onDisk = await readFile(path.join(root, file.path));
      expect(Buffer.compare(onDisk, Buffer.from(file.bytes)), file.path).toBe(0);
    }
  });

  it("o pacote gravado valida e confere hashes, tamanhos e metadados", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "package", "manifest.json"), "utf8"));
    const result = validateManifest(manifest);
    expect(result.issues).toEqual([]);
    const issues = await verifyManifestFiles(result.manifest!, (p) => readFile(path.join(root, "package", p)));
    expect(issues).toEqual([]);
  });

  it("verificação de bytes acusa arquivo adulterado", async () => {
    const manifest = structuredClone(fixture.manifest);
    const issues = await verifyManifestFiles(manifest, async (p) => {
      const bytes = new Uint8Array(await readFile(path.join(root, "package", p)));
      const i = bytes.length - 20;
      if (p === "textures/spark.png") bytes[i] = bytes[i]! ^ 0xff;
      return bytes;
    });
    expect(issues).toEqual([expect.objectContaining({ code: "hash_mismatch", fileId: "spark-texture" })]);
  });
});

describe("pixels conhecidos", () => {
  const png = (p: string) => decodeRgba(fixture.packageFiles.find((f) => f.path === p)!.bytes);

  it("faísca 16×8: (3,3) no primeiro frame; (11,2) e (12,3) com alfa parcial no segundo", () => {
    const spark = png("textures/spark.png");
    expect([spark.width, spark.height]).toEqual([16, 8]);
    expect(spark.pixel(3, 3)).toEqual([255, 230, 90, 255]);
    expect(spark.pixel(11, 2)).toEqual([255, 230, 90, 128]);
    expect(spark.pixel(12, 3)).toEqual([255, 230, 90, 64]);
    expect(spark.pixel(4, 3)[3]).toBe(0);
  });

  it("tile da máscara 9 tem água nos dois cantos a oeste", () => {
    const tiles = png("tiles/grass-water.png");
    const [ox, oy] = [(9 % 4) * 32, Math.floor(9 / 4) * 32];
    const water = [50, 100, 200, 255];
    const grass = [70, 150, 60, 255];
    expect(tiles.pixel(ox, oy)).toEqual(water); // NO
    expect(tiles.pixel(ox + 31, oy)).toEqual(grass); // NE
    expect(tiles.pixel(ox + 31, oy + 31)).toEqual(grass); // SE
    expect(tiles.pixel(ox, oy + 31)).toEqual(water); // SO
  });

  it("o guerreiro é assimétrico (escudo só de um lado)", () => {
    const base = png("sprites/warrior-base-s.png");
    let differs = false;
    for (let y = 0; y < 64 && !differs; y++) {
      for (let x = 0; x < 32; x++) {
        if (base.pixel(x, y).join() !== base.pixel(63 - x, y).join()) {
          differs = true;
          break;
        }
      }
    }
    expect(differs).toBe(true);
  });

  it("o som tem 2205 frames a 22 050 Hz, mono", () => {
    const wav = fixture.packageFiles.find((f) => f.path === "audio/hit.wav")!.bytes;
    expect(readWavInfo(wav)).toMatchObject({ sampleRate: 22_050, channels: 1, frameCount: 2205, durationMs: 100, codec: "pcm_s16le" });
  });
});
