import { describe, expect, it } from "vitest";
import { type BasePayload, type ClipPayload, ClipPayload as ClipSchema } from "@/contracts";
import { resizeBaseCanvas, resizeClipCanvas } from "./canvas";
import { adjacent, distributeDurations, frameDigest, frameLayouts, insertFrames, intermediateFrameIds, interpolateSockets, mirrorGridPoint, mirrorPixel, removeFrames, removePart, replaceLayer } from "./temporal";

function clip(): ClipPayload {
  const frame = (frameId: string, x: number, fileId = "atlas") => ({
    frameId,
    durationMs: 100,
    layers: [{ partId: "body", fileId, rect: [x, 0, 16, 16] as [number, number, number, number], offset: [0, 0] as [number, number] }],
    sockets: [{ socketId: "hand_right", at: [10 + x / 16, 8] as [number, number], hidden: false }],
    rootOffset: [0, 0] as [number, number],
  });
  return {
    rigRevisionId: null,
    motionRevisionId: null,
    action: "open",
    state: "closed",
    stance: null,
    direction: "S",
    logicalSize: [16, 16],
    pivot: [8, 15],
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    playback: "once",
    frames: [frame("a", 0), frame("b", 16), frame("c", 32)],
    events: [{ eventId: "hit", frameId: "b", kind: "impact", vfx: { revisionId: "fx", socketId: "hand_right", offset: [2, 0] }, audio: null }],
  };
}

describe("edição temporal (domínio)", () => {
  it("distribui o tempo em ms inteiros, soma exata, resto nos primeiros", () => {
    expect(distributeDurations(301, 3)).toEqual([101, 100, 100]);
    expect(distributeDurations(2, 3)).toEqual([1, 1, 1]);
    expect(distributeDurations(100, 0)).toEqual([]);
  });

  it("intermediários: IDs novos sem colisão, extremos intactos e sockets interpolados", () => {
    const c = clip();
    expect(intermediateFrameIds(["a", "b", "a-b-i01"], "a", "b", 2)).toEqual(["a-b-i02", "a-b-i03"]);
    expect(adjacent(c, "a", "b")).toBe(true);
    expect(adjacent(c, "a", "c")).toBe(false);
    expect(adjacent({ ...c, playback: "loop" }, "c", "a")).toBe(true);
    expect(interpolateSockets(c.frames[0]!.sockets, c.frames[1]!.sockets, 0.5)).toEqual([{ socketId: "hand_right", at: [11, 8], hidden: false }]);
    const next = insertFrames(c, "a", [{ ...c.frames[0]!, frameId: "a-b-i01" }]);
    expect(next.frames.map((f) => f.frameId)).toEqual(["a", "a-b-i01", "b", "c"]);
    expect(next.frames[0]).toBe(c.frames[0]);
    expect(() => insertFrames(c, "a", [c.frames[1]!])).toThrow(/repetido/);
    expect(ClipSchema.safeParse(next).success).toBe(true);
  });

  it("remover quadro com evento exige remapeamento; remover parte mantém ao menos uma camada", () => {
    const c = clip();
    expect(() => removeFrames(c, ["b"])).toThrow(/remapeie/);
    expect(removeFrames(c, ["b"], { hit: "c" }).clip.events[0]!.frameId).toBe("c");
    expect(() => removeFrames(c, ["b"], { hit: "b" })).toThrow(/não fica no clipe/);
    expect(removeFrames(c, ["b"], { hit: null }).removedEvents).toEqual(["hit"]);
    expect(() => removePart(c, "body")).toThrow(/sem camadas/);
    const two = replaceLayer(c, "a", "body", { partId: "body", fileId: "fix", rect: [0, 0, 16, 16], offset: [0, 0] });
    expect(two.frames[0]!.layers[0]!.fileId).toBe("fix");
    expect(two.frames[1]).toBe(c.frames[1]);
  });

  it("digest de quadro: mesmo arquivo, retângulo e tempo dão o mesmo digest", () => {
    const c = clip();
    const sha = (id: string) => (id === "atlas" ? "a".repeat(64) : "b".repeat(64));
    expect(frameDigest(c.frames[0]!, sha)).toBe(frameDigest({ ...c.frames[0]! }, sha));
    expect(frameDigest(c.frames[0]!, sha)).not.toBe(frameDigest({ ...c.frames[0]!, durationMs: 101 }, sha));
    const { layouts, files } = frameLayouts(c, ["a", "c"], 3);
    expect(files).toEqual(["atlas"]);
    expect(layouts.map((l) => l.layers[0]!.source)).toEqual([3, 3]);
  });

  it("espelho: índice de pixel por W − 1 − x e ponto da grade por W − x", () => {
    expect(mirrorPixel([39, 34], 64)).toEqual([24, 34]);
    expect(mirrorGridPoint([32, 60], 64)).toEqual([32, 60]);
    expect(mirrorGridPoint([10, 5], 64)).toEqual([54, 5]);
  });
});

describe("canvas (domínio)", () => {
  it("ampliar desloca camadas, sockets, pivô e margens pela mesma margem; eventos não mudam", () => {
    const c = clip();
    const r = resizeClipCanvas(c, { left: 4, right: 2, top: 3, bottom: 1 });
    expect(r.problems).toEqual([]);
    expect(r.payload.logicalSize).toEqual([22, 20]);
    expect(r.payload.pivot).toEqual([12, 18]);
    expect(r.payload.frames[1]!.layers[0]!.offset).toEqual([4, 3]);
    expect(r.payload.frames[1]!.sockets[0]!.at).toEqual([15, 11]);
    expect(r.payload.margins).toEqual({ left: 4, right: 2, top: 3, bottom: 1 });
    expect(r.payload.events).toEqual(c.events);
    expect(ClipSchema.safeParse(r.payload).success).toBe(true);
  });

  it("reduzir exige o conteúdo medido e recusa cortar pixel visível ou ficar menor que a célula original", () => {
    // Célula ampliada com quadros gerados já na célula inteira (24×16): reduzir corta a camada.
    const base = clip();
    const grown: ClipPayload = { ...base, logicalSize: [24, 16], pivot: [12, 15], margins: { left: 4, right: 4, top: 0, bottom: 0 }, frames: base.frames.map((f) => ({ ...f, layers: [{ ...f.layers[0]!, rect: [0, 0, 24, 16], offset: [0, 0] }], sockets: [] })), events: [] };
    expect(resizeClipCanvas(grown, { left: -4, right: -4, top: 0, bottom: 0 }).problems[0]).toMatch(/medir o conteúdo/);
    const boxes = Object.fromEntries(grown.frames.map((f) => [f.frameId, [6, 2, 10, 13] as [number, number, number, number]]));
    const back = resizeClipCanvas(grown, { left: -4, right: -4, top: 0, bottom: 0 }, boxes);
    expect(back.problems).toEqual([]);
    expect(back.payload.frames[0]!.layers[0]).toMatchObject({ rect: [4, 0, 16, 16], offset: [0, 0] });
    const tight = Object.fromEntries(grown.frames.map((f) => [f.frameId, [1, 2, 20, 13] as [number, number, number, number]]));
    expect(resizeClipCanvas(grown, { left: -4, right: -4, top: 0, bottom: 0 }, tight).problems.join(" ")).toMatch(/visíveis/);
    expect(resizeClipCanvas(grown, { left: -6, right: 0, top: 0, bottom: 0 }, boxes).problems.join(" ")).toMatch(/margens/);
  });

  it("base: vistas vão para a tela nova com o mesmo deslocamento do apoio", () => {
    const base: BasePayload = { logicalSize: [32, 32], groundOrigin: [16, 30], state: "default", predecessorRevisionId: null, subject: "object", views: [{ direction: "S", fileId: "v", rect: [0, 0, 32, 32], sourceOffset: [0, 0] }] };
    const r = resizeBaseCanvas(base, { left: 4, right: 4, top: 8, bottom: 0 });
    expect(r.payload.logicalSize).toEqual([40, 40]);
    expect(r.payload.groundOrigin).toEqual([20, 38]);
    expect(r.placements[0]!.offset).toEqual([4, 8]);
  });
});
