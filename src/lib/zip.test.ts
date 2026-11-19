import { describe, expect, it } from "vitest";
import { encodeZip, readZip, writeZip } from "./zip";

const enc = (s: string) => new TextEncoder().encode(s);

describe("ZIP", () => {
  it("ida e volta com stored e deflate, nomes UTF-8", () => {
    const zip = writeZip([
      { path: "manifest.json", bytes: enc('{"a":1}'.repeat(100)), compress: true },
      { path: "sprites/poção.png", bytes: new Uint8Array([1, 2, 3]), compress: false },
    ]);
    const archive = readZip(zip);
    expect(archive.paths).toEqual(["manifest.json", "sprites/poção.png"]);
    expect(new TextDecoder().decode(archive.read("manifest.json"))).toBe('{"a":1}'.repeat(100));
    expect([...archive.read("sprites/poção.png")]).toEqual([1, 2, 3]);
  });

  it("escritor recusa caminhos inseguros e duplicados", () => {
    expect(() => writeZip([{ path: "../fora", bytes: enc("x"), compress: false }])).toThrow(/inválido/);
    expect(() =>
      writeZip([
        { path: "A.png", bytes: enc("x"), compress: false },
        { path: "a.png", bytes: enc("y"), compress: false },
      ]),
    ).toThrow(/duplicado/);
  });

  it.each(["../evil.sh", "/etc/passwd", "ok/../../evil", "C:/win.ini"])("leitor recusa zip-slip: %s", (name) => {
    const zip = encodeZip([{ path: name, bytes: enc("x"), compress: false }]);
    expect(() => readZip(zip)).toThrow(/inseguro/);
  });

  it("detecta conteúdo corrompido pelo CRC", () => {
    const zip = writeZip([{ path: "a.txt", bytes: enc("pixel art"), compress: false }]);
    const first = 30 + "a.txt".length; // primeiro byte dos dados
    zip[first] = zip[first]! ^ 0xff;
    expect(() => readZip(zip).read("a.txt")).toThrow(/CRC/);
  });

  it("aplica limite de tamanho antes de descompactar (zip bomb)", () => {
    const zip = writeZip([{ path: "zeros.bin", bytes: new Uint8Array(1_000_000), compress: true }]);
    expect(zip.length).toBeLessThan(5_000);
    expect(() => readZip(zip, { maxEntries: 10, maxEntryBytes: 100_000, maxTotalBytes: 100_000 })).toThrow(/excede/);
  });

  it("recusa arquivo que não é ZIP", () => {
    expect(() => readZip(enc("não sou zip"))).toThrow(/não é um ZIP/);
  });
});
