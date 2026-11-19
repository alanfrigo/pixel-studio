import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import type { Manifest, ManifestEntry } from "@/contracts";
import { createImage, encodePng, setPixel } from "@/lib/media/png";
import { asepriteTarget, gifTarget } from "./animation";

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const clip: Extract<ManifestEntry, { family: "character"; kind: "clip" }> = {
  assetId: "mage", revisionId: "cast-v1", name: "Mage", family: "character", kind: "clip", dependencies: [],
  payload: {
    rigRevisionId: null, motionRevisionId: null, action: "cast", state: null, stance: null, direction: "S",
    logicalSize: [7, 5], pivot: [2, 5], margins: { left: 0, right: 0, top: 0, bottom: 0 },
    playback: "ping_pong", events: [],
    frames: [
      { frameId: "windup", durationMs: 17, rootOffset: [0, 0], sockets: [], layers: [
        { partId: "body", fileId: "atlas", rect: [1, 0, 1, 1], offset: [2, 4] },
        { partId: "wand", fileId: "atlas", rect: [0, 0, 1, 1], offset: [2, 4] },
      ] },
      { frameId: "release", durationMs: 60_000, rootOffset: [0, 0], sockets: [], layers: [
        { partId: "wand", fileId: "atlas", rect: [0, 0, 1, 1], offset: [2, 4] },
        { partId: "body", fileId: "atlas", rect: [1, 0, 1, 1], offset: [2, 4] },
      ] },
    ],
  },
};

it("preflights raster coordinate limits without clipping supported durations or signed offsets in GIF", () => {
  const frames = [{ ...clip.payload.frames[0]!, layers: [{ ...clip.payload.frames[0]!.layers[0]!, offset: [32_768, 4] as [number, number] }] }];
  const wide: typeof clip = { ...clip, payload: { ...clip.payload, logicalSize: [65_535, 5], frames } };
  expect(asepriteTarget.problem(clip)).toBeNull();
  expect(asepriteTarget.problem(wide)?.en).toContain("cel positions");
  expect(gifTarget.problem(wide)).toBeNull();
  expect(gifTarget.problem({ ...wide, payload: { ...wide.payload, logicalSize: [65_536, 5] } })?.en).toContain("65,535");
});

/** Small independent reader for frame/chunk boundaries from the Aseprite disk format. */
function readFrames(file: Buffer) {
  let cursor = 128;
  const frames = [];
  for (let f = 0; f < file.readUInt16LE(6); f++) {
    const end = cursor + file.readUInt32LE(cursor);
    expect(file.readUInt16LE(cursor + 4)).toBe(0xf1fa);
    const count = file.readUInt16LE(cursor + 6);
    const duration = file.readUInt16LE(cursor + 8);
    const chunks: { kind: number; data: Buffer }[] = [];
    cursor += 16;
    for (let c = 0; c < count; c++) {
      const size = file.readUInt32LE(cursor);
      chunks.push({ kind: file.readUInt16LE(cursor + 4), data: file.subarray(cursor + 6, cursor + size) });
      cursor += size;
    }
    expect(cursor).toBe(end);
    frames.push({ duration, chunks });
  }
  expect(cursor).toBe(file.length);
  return frames;
}

it.skipIf(!existsSync(PYTHON))("writes editable RGBA cels with atlas cropping, variable timing, ordering, tag and edge pivot", async () => {
  const atlas = createImage(2, 1);
  const body = [12, 34, 56, 127] as const;
  setPixel(atlas, 0, 0, [255, 0, 0, 255]);
  setPixel(atlas, 1, 0, body);
  const bytes = encodePng(atlas);
  const source = { path: "sprites/mage.png", bytes, compress: false };
  const manifest: Manifest = {
    schemaVersion: 1, projectId: "test", profile: "portable-v1", entries: [clip],
    files: [{ fileId: "atlas", path: source.path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      mime: "image/png", width: 2, height: 1 }],
  };
  const workDir = await mkdtemp(path.join(os.tmpdir(), "pixel-studio-aseprite-"));
  try {
    const outputs = await asepriteTarget.build({ manifest, sourceFiles: [source], selected: new Set([clip.revisionId]),
      projectName: "Test", workDir, python: PYTHON, signal: new AbortController().signal, timeoutMs: 5000 });
    expect(outputs.map((output) => output.path)).toEqual(["aseprite/mage-cast_s.aseprite"]);
    const file = Buffer.from(outputs[0]!.bytes);
    expect(file.readUInt32LE(0)).toBe(file.length);
    expect(file.readUInt16LE(4)).toBe(0xa5e0);
    expect([file.readUInt16LE(8), file.readUInt16LE(10), file.readUInt16LE(12)]).toEqual([7, 5, 32]);
    const frames = readFrames(file);
    expect(frames.map((frame) => frame.duration)).toEqual([17, 60_000]);
    const chunks = frames[0]!.chunks;
    expect(chunks.filter(({ kind }) => kind === 0x2004).map(({ data }) => data.toString("utf8", 18))).toEqual(["body", "wand"]);
    const tag = chunks.find(({ kind }) => kind === 0x2018)!.data;
    expect([tag.readUInt16LE(12), tag[14], tag.readUInt16LE(15)]).toEqual([1, 2, 0]); // last frame, ping-pong, default repeat
    expect(tag.toString("utf8", 29)).toBe("cast-s");
    const pivot = chunks.find(({ kind }) => kind === 0x2022)!.data;
    expect(pivot.readUInt32LE(4)).toBe(2); // slice has a pivot
    expect([pivot.readInt32LE(pivot.length - 8), pivot.readInt32LE(pivot.length - 4)]).toEqual([2, 5]);
    const firstCel = chunks.find(({ kind }) => kind === 0x2005)!.data;
    expect([firstCel.readInt16LE(2), firstCel.readInt16LE(4), firstCel.readUInt16LE(7)]).toEqual([2, 4, 2]);
    expect([...inflateSync(firstCel.subarray(20))]).toEqual(body);
    expect(frames[1]!.chunks.map(({ data }) => [data.readUInt16LE(0), data.readInt16LE(9)])).toEqual([[1, -1], [0, 1]]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
