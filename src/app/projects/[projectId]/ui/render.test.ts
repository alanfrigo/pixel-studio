// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ScreenPayload, type ButtonPayload, type MenuItemPayload, type MeterPayload, type PanelPayload, type Rect, type ScreenInstance, type SlotPayload, type TextSlot } from "@/contracts";
import type { RevisionView } from "@/server/catalog/catalog";
import { drawCaption, drawNine, drawPreviewLine, loadImage, mediaOf, naturalSize, type RenderDeps, type RenderOptions, renderScreen, screenProblems, screenUrls } from "./render";

// Record what would be submitted to the browser's 2D canvas. All geometry,
// including text metrics, clipping bounds and atlas offsets, comes from render.ts.
function recordCanvas() {
  let dash: number[] = [];
  const stack: { fill: string; stroke: string; width: number; dash: number[] }[] = [];
  const canvas = {
    fillStyle: "black",
    strokeStyle: "black",
    lineWidth: 3,
    clearRect: vi.fn<(...rect: Rect) => void>(),
    drawImage: vi.fn<(image: HTMLImageElement, ...coords: number[]) => void>(),
    fillRect: vi.fn((...rect: Rect): { color: string; rect: Rect } => ({ color: canvas.fillStyle, rect })),
    beginPath: vi.fn(),
    rect: vi.fn<(...rect: Rect) => void>(),
    clip: vi.fn(),
    save() { stack.push({ fill: canvas.fillStyle, stroke: canvas.strokeStyle, width: canvas.lineWidth, dash }); },
    restore() {
      const saved = stack.pop()!;
      canvas.fillStyle = saved.fill;
      canvas.strokeStyle = saved.stroke;
      canvas.lineWidth = saved.width;
      dash = saved.dash;
    },
    setLineDash(segments: number[]) { dash = segments; },
    strokeRect: vi.fn((...rect: Rect): { color: string; width: number; dash: number[]; rect: Rect } => ({ color: canvas.strokeStyle, width: canvas.lineWidth, dash, rect })),
  };
  return { canvas, ctx: canvas as unknown as CanvasRenderingContext2D };
}

const url = (id: string) => `/api/v1/projects/playtest/media/${id}`;
const insets = { left: 2, top: 1, right: 3, bottom: 2 };
const padding = { left: 3, top: 2, right: 3, bottom: 2 };
const stretch = { center: "stretch", edges: "stretch" } as const;
const text: TextSlot = { key: "button.label", sample: "A", align: "start", verticalAlign: "top", wrap: "none", overflow: "report", fontRevisionId: null };
const button: ButtonPayload = {
  logicalSize: [12, 10],
  states: [
    { state: "normal", fileId: "states", rect: [1, 2, 12, 10] },
    { state: "hover", fileId: "states", rect: [13, 2, 12, 10] },
    { state: "pressed", fileId: "states", rect: [25, 2, 12, 10] },
    { state: "disabled", fileId: "states", rect: [37, 2, 12, 10] },
  ],
  focus: { mode: "overlay", fileId: "focus-ring", rect: [2, 3, 12, 10] },
  requiredStates: ["normal", "hover", "pressed", "disabled"],
  nineSlice: null, contentPadding: padding, stretch, interactiveRect: null, text, accessibleName: null, complete: true,
};
const menu: MenuItemPayload = {
  buttonRevisionId: "button", iconRevisionId: null, actionId: "continue", shortcut: null, selectable: true,
  text: { ...text, key: "menu.continue", sample: "C" },
};
const panel: PanelPayload = {
  logicalSize: [12, 10], image: { fileId: "panel", rect: [10, 20, 12, 10] }, nineSlice: insets,
  contentPadding: padding, stretch, minSize: [6, 4],
};
const slot: SlotPayload = {
  logicalSize: [12, 10], states: [
    { state: "empty", fileId: "slots", rect: [2, 3, 12, 10] },
    { state: "occupied", fileId: "slots", rect: [14, 3, 12, 10] },
    { state: "selected", fileId: "slots", rect: [26, 3, 12, 10] },
  ],
  requiredStates: ["empty", "occupied", "selected"],
  nineSlice: null, iconRect: [1, 1, 10, 8], counterAnchor: [11, 9], counterAlign: "end", complete: true,
};
const meter: MeterPayload = {
  logicalSize: [12, 6], range: { min: 20, max: 100 }, axis: "horizontal", direction: "reverse", rounding: "floor", nineSlice: null,
  track: { fileId: "track", rect: [1, 2, 12, 6] }, fill: { fileId: "fill", rect: [10, 20, 8, 4], offset: [2, 1] },
  frame: { fileId: "frame", rect: [13, 2, 12, 6] }, usefulRect: [2, 1, 8, 4],
};

function instance(instanceId: string, componentRevisionId: string | null, [x, y, w, h]: Rect, patch: Partial<ScreenInstance> = {}): ScreenInstance {
  return {
    instanceId, componentRevisionId, parentId: null, order: 0, hidden: false, overrides: {},
    anchors: { left: 0, top: 0, right: 0, bottom: 0 }, offsets: { left: x, top: y, right: x + w, bottom: y + h }, ...patch,
  };
}

function screen(instances: ScreenInstance[], patch: Partial<ScreenPayload> = {}): ScreenPayload {
  return ScreenPayload.parse({ referenceResolution: [64, 48], background: null, instances, focusOrder: [], ...patch });
}

function assets() {
  const deps: RenderDeps = { projectId: "playtest", revisions: new Map(), images: new Map(), loaded: new Map() };
  function load(id: string) {
    const img = document.createElement("img");
    img.src = url(id);
    deps.loaded.set(url(id), img);
    return img;
  }
  function revision(id: string, kind: string, payload: unknown, files: Record<string, string> = {}) {
    const view: RevisionView = {
      id, assetId: `asset-${id}`, projectId: deps.projectId, number: 1, status: "approved", predecessorId: null,
      styleRevisionId: null, payload, payloadDigest: "", origin: "imported", jobAttemptId: null, technicalReport: null, createdAt: "2026-01-01T00:00:00Z",
      files: Object.entries(files).map(([fileKey, mediaId], idx) => ({ id: mediaId, fileKey, role: fileKey, idx, sha256: "", bytes: 100, mime: "image/png", metadata: {} })),
    };
    deps.revisions.set(id, { kind, revision: view });
    return view;
  }
  function picture(revisionId: string, mediaFileId: string, rect: Rect) {
    deps.images.set(revisionId, { assetId: `asset-${revisionId}`, assetName: revisionId, kind: "sprite", family: "item", revisionId, number: 1, mediaFileId, rect });
    return load(mediaFileId);
  }
  return { deps, load, revision, picture };
}

const defaults: RenderOptions = { language: "en", hover: null, pressed: null, focus: null, focusColor: "#845eef", textColor: "#ffe0a8", guides: false, selected: null };

function paint(payload: ScreenPayload, deps: RenderDeps, options: Partial<RenderOptions> = {}) {
  const { canvas, ctx } = recordCanvas();
  const resolved = renderScreen(ctx, payload, payload.referenceResolution, deps, { ...defaults, ...options });
  return { ...canvas, resolved };
}

describe("preview asset lookup", () => {
  it("shares in-flight and settled loads for the same URL, and rejects on an image error", async () => {
    const images: HTMLImageElement[] = [];
    const ImageAtBoundary = vi.fn(function () {
      const image = document.createElement("img");
      images.push(image);
      return image;
    });
    vi.stubGlobal("Image", ImageAtBoundary);
    try {
      const src = "/atlas-for-preview.png";
      const loading = loadImage(src);
      const duplicate = loadImage(src);
      const [img] = images;
      expect(img?.getAttribute("src")).toBe(src);
      expect(ImageAtBoundary).toHaveBeenCalledTimes(1);
      img!.dispatchEvent(new Event("load"));
      await expect(Promise.all([loading, duplicate, loadImage(src)])).resolves.toEqual([img, img, img]);
      expect(ImageAtBoundary).toHaveBeenCalledTimes(1);

      const failed = loadImage("/missing-preview.png");
      images[1]!.dispatchEvent(new Event("error"));
      await expect(failed).rejects.toThrow("/missing-preview.png");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("collects distinct media from component revisions, menu dependencies, icons and background", () => {
    const { deps, revision, picture } = assets();
    const buttonView = revision("button", "button", button, { states: "button-atlas", "focus-ring": "button-focus" });
    revision("menu", "menu_item", menu, { extra: "menu-extra" });
    picture("icon", "icon-atlas", [12, 3, 6, 4]);
    picture("scene", "scene-atlas", [5, 2, 32, 48]);
    const payload = screen([
      instance("first", "menu", [2, 3, 12, 10], { overrides: { iconRevisionId: "icon" } }),
      instance("second", "button", [2, 13, 12, 10], { overrides: { iconRevisionId: "icon" } }),
      instance("missing", "deleted-revision", [2, 23, 12, 10]),
      instance("group", null, [2, 33, 12, 10]),
    ], { background: { revisionId: "scene", exported: false } });
    expect(mediaOf("playtest", buttonView, "focus-ring")).toBe(url("button-focus"));
    expect(mediaOf("playtest", buttonView, "button-focus")).toBeNull();
    expect(screenUrls(payload, deps)).toEqual([url("menu-extra"), url("button-atlas"), url("button-focus"), url("icon-atlas"), url("scene-atlas")]);
    expect(screenUrls({ ...payload, background: null }, deps)).not.toContain(url("scene-atlas"));
  });

  it("uses a menu's backing button size or the atlas region size, with no guessed size for unknown assets", () => {
    const { deps, revision, picture } = assets();
    revision("button", "button", button);
    revision("menu", "menu_item", menu);
    revision("detached-menu", "menu_item", { ...menu, buttonRevisionId: "removed" });
    revision("other", "template", {});
    picture("portrait", "portrait-atlas", [30, 40, 23, 9]);
    expect(naturalSize("button", deps)).toEqual([12, 10]);
    expect(naturalSize("menu", deps)).toEqual([12, 10]);
    expect(naturalSize("portrait", deps)).toEqual([23, 9]);
    expect(naturalSize("detached-menu", deps)).toBeNull();
    expect(naturalSize("other", deps)).toBeNull();
    expect(naturalSize("missing", deps)).toBeNull();
  });
});

describe("canvas primitives", () => {
  it("preserves the asymmetric corners while stretching the edges and center of an atlas region", () => {
    const { canvas, ctx } = recordCanvas();
    const img = document.createElement("img");
    drawNine(ctx, img, [10, 20, 12, 10], insets, [5, 7, 19, 14]);
    expect(canvas.drawImage.mock.calls).toEqual([
      [img, 10, 20, 2, 1, 5, 7, 2, 1], [img, 12, 20, 7, 1, 7, 7, 14, 1], [img, 19, 20, 3, 1, 21, 7, 3, 1],
      [img, 10, 21, 2, 7, 5, 8, 2, 11], [img, 12, 21, 7, 7, 7, 8, 14, 11], [img, 19, 21, 3, 7, 21, 8, 3, 11],
      [img, 10, 28, 2, 2, 5, 19, 2, 2], [img, 12, 28, 7, 2, 7, 19, 14, 2], [img, 19, 28, 3, 2, 21, 19, 3, 2],
    ]);
  });

  it("keeps native size without cuts or when the cuts cannot fit, and skips collapsed destinations", () => {
    const { canvas, ctx } = recordCanvas();
    const img = document.createElement("img");
    drawNine(ctx, img, [10, 20, 12, 10], null, [1, 2, 30, 30]);
    drawNine(ctx, img, [10, 20, 12, 10], insets, [4, 5, 5, 4]);
    drawNine(ctx, img, [10, 20, 12, 10], insets, [4, 5, 0, 5]);
    drawNine(ctx, img, [10, 20, 12, 10], null, [4, 5, 9, 0]);
    expect(canvas.drawImage.mock.calls).toEqual([[img, 10, 20, 12, 10, 1, 2, 12, 10], [img, 10, 20, 12, 10, 4, 5, 12, 10]]);
  });

  it("draws accents above the baseline, transparent spaces and a cedilla below the glyph", () => {
    const { canvas, ctx } = recordCanvas();
    drawPreviewLine(ctx, "á ç", 10, 20, "#f4b051");
    expect(canvas.fillRect.mock.calls).toEqual([
      [12, 18, 1, 1], [11, 19, 1, 1], [11, 20, 1, 1], [10, 21, 1, 1], [12, 21, 1, 1],
      [10, 22, 1, 1], [11, 22, 1, 1], [12, 22, 1, 1], [10, 23, 1, 1], [12, 23, 1, 1], [10, 24, 1, 1], [12, 24, 1, 1],
      [19, 20, 1, 1], [20, 20, 1, 1], [18, 21, 1, 1], [18, 22, 1, 1], [18, 23, 1, 1], [19, 24, 1, 1], [20, 24, 1, 1], [19, 25, 1, 1],
    ]);
    expect(canvas.fillRect.mock.results.map(({ value }) => value.color)).toEqual(Array(20).fill("#f4b051"));
  });

  it("selects and clips the requested page, capping at the last page and preserving canvas state", () => {
    const { canvas, ctx } = recordCanvas();
    const pagination = { ...text, wrap: "word", overflow: "paginate", align: "end", verticalAlign: "bottom" } as const;
    const layout = drawCaption(ctx, "A B C", [10, 20, 6, 6], pagination, "#fff", 99);
    expect(layout).toEqual({ lines: ["A"], pages: [["A"], ["B"], ["C"]], needed: [3, 21], overflow: true, outcome: "paginate" });
    expect(canvas.rect.mock.calls).toEqual([[10, 18, 6, 9]]);
    expect(canvas.clip).toHaveBeenCalledOnce();
    expect(canvas.clip.mock.invocationCallOrder[0]).toBeLessThan(canvas.fillRect.mock.invocationCallOrder[0]!);
    expect(canvas.fillRect.mock.calls).toEqual([[14, 21, 1, 1], [15, 21, 1, 1], [13, 22, 1, 1], [13, 23, 1, 1], [13, 24, 1, 1], [14, 25, 1, 1], [15, 25, 1, 1]]);
    expect(canvas.fillStyle).toBe("black");
    canvas.fillRect.mockClear();
    drawCaption(ctx, "A B C", [10, 20, 6, 6], pagination, "#fff", 1);
    expect(canvas.fillRect).toHaveBeenNthCalledWith(1, 13, 21, 1, 1); // B, not A or C
  });

  it("centers consecutive lines on their own widths and does not clip growing text", () => {
    const { canvas, ctx } = recordCanvas();
    const grow = { ...text, overflow: "grow", align: "center", verticalAlign: "middle" } as const;
    expect(drawCaption(ctx, "A\nII", [20, 20, 8, 9], grow, "#fff")).toMatchObject({ outcome: "grow", needed: [7, 13] });
    expect(canvas.clip).not.toHaveBeenCalled();
    expect(canvas.fillRect.mock.calls.filter(([, y]) => y === 18 || y === 26)).toEqual([
      [23, 18, 1, 1], [20, 26, 1, 1], [21, 26, 1, 1], [22, 26, 1, 1], [24, 26, 1, 1], [25, 26, 1, 1], [26, 26, 1, 1],
    ]);
  });
});

describe("composited preview", () => {
  it("clears the screen, integer-scales the background to cover, and paints visible layers in hierarchy order", () => {
    const { deps, load, revision, picture } = assets();
    const bg = picture("scene", "scene-atlas", [4, 5, 26, 21]);
    const portrait = picture("portrait", "faces", [22, 5, 8, 12]);
    const paper = load("paper");
    revision("panel", "panel", panel, { panel: "paper" });
    const payload = screen([
      instance("hidden-face", "portrait", [1, 2, 5, 5], { parentId: "hidden" }),
      instance("face", "portrait", [4, 2, 13, 6], { parentId: "box", order: 2 }),
      instance("paper", "panel", [0, 0, 19, 14], { parentId: "box", order: 1 }),
      instance("hidden", null, [0, 0, 30, 30], { hidden: true, order: 1 }),
      instance("box", null, [10, 11, 19, 14]),
    ], { background: { revisionId: "scene", exported: false } });
    const frame = paint(payload, deps);
    expect(frame.clearRect.mock.calls).toEqual([[0, 0, 64, 48]]);
    expect(frame.clearRect.mock.invocationCallOrder[0]).toBeLessThan(frame.drawImage.mock.invocationCallOrder[0]!);
    expect(frame.drawImage.mock.calls.map(([img]) => img)).toEqual([bg, ...Array(9).fill(paper), portrait]);
    expect(frame.drawImage).toHaveBeenNthCalledWith(1, bg, 4, 5, 26, 21, -7, -8, 78, 63);
    expect(frame.drawImage).toHaveBeenNthCalledWith(6, paper, 12, 21, 7, 7, 12, 12, 14, 11);
    expect(frame.drawImage).toHaveBeenLastCalledWith(portrait, 22, 5, 8, 6, 16, 13, 8, 6);
    expect(frame.resolved.map(({ instance: i, visible, rect, depth }) => [i.instanceId, visible, rect, depth])).toEqual([
      ["box", true, [10, 11, 19, 14], 0], ["paper", true, [10, 11, 19, 14], 1], ["face", true, [14, 13, 13, 6], 1],
      ["hidden", false, [0, 0, 30, 30], 0], ["hidden-face", false, [1, 2, 5, 5], 1],
    ]);
    deps.loaded.clear();
    expect(paint(payload, deps).drawImage).not.toHaveBeenCalled();
    deps.images.delete("scene");
    expect(paint(payload, deps).drawImage).not.toHaveBeenCalled();
  });

  it("resolves anchors at the requested viewport size and does not downscale a large backdrop", () => {
    const { deps, picture } = assets();
    const backdrop = picture("scene", "scene-atlas", [6, 1, 31, 29]);
    const portrait = picture("portrait", "faces", [4, 6, 14, 9]);
    const payload = screen([
      instance("root", null, [0, 0, 0, 0], { anchors: { left: 0, top: 0, right: 1, bottom: 1 } }),
      instance("face", "portrait", [0, 0, 1, 1], {
        parentId: "root", anchors: { left: 0.5, top: 0.5, right: 1, bottom: 1 },
        offsets: { left: -1, top: -2, right: -2, bottom: -4 },
      }),
    ], { background: { revisionId: "scene", exported: true } });
    const { canvas, ctx } = recordCanvas();
    const resolved = renderScreen(ctx, payload, [22, 18], deps, defaults);
    expect(resolved.map(({ rect }) => rect)).toEqual([[0, 0, 22, 18], [10, 7, 10, 7]]);
    expect(canvas.drawImage.mock.calls).toEqual([
      [backdrop, 6, 1, 31, 29, -5, -6, 31, 29], [portrait, 4, 6, 10, 7, 10, 7, 10, 7],
    ]);
  });

  it.each([
    { saved: undefined, interaction: {}, atlasX: 1 },
    { saved: "selected", interaction: {}, atlasX: 1 },
    { saved: "pressed", interaction: {}, atlasX: 25 },
    { saved: "pressed", interaction: { hover: "control" }, atlasX: 13 },
    { saved: "hover", interaction: { hover: "control", pressed: "control" }, atlasX: 25 },
    { saved: "disabled", interaction: { hover: "control", pressed: "control" }, atlasX: 37 },
  ] as const)("paints the matching atlas cell for saved=$saved interaction=$interaction", ({ saved, interaction, atlasX }) => {
    const { deps, load, revision } = assets();
    revision("button", "button", button, { states: "atlas", "focus-ring": "ring" });
    const atlas = load("atlas");
    const ring = load("ring");
    const payload = screen([instance("control", "button", [5, 7, 30, 20], { overrides: { state: saved } })]);
    const frame = paint(payload, deps, { focus: "control", ...interaction });
    expect(frame.drawImage.mock.calls).toEqual([[atlas, atlasX, 2, 12, 10, 5, 7, 12, 10], [ring, 2, 3, 12, 10, 5, 7, 12, 10]]);
    expect(frame.fillRect.mock.results[0]?.value).toEqual({ color: saved === "disabled" ? "#8a8a90" : defaults.textColor, rect: [9, 9, 1, 1] });
  });

  it("uses the first state for an incomplete button, including when preview states are absent", () => {
    const { deps, load, revision } = assets();
    revision("partial", "button", {
      ...button, complete: false, focus: null, text: null, accessibleName: "Pause", states: [button.states[1]!],
    }, { states: "atlas" });
    const atlas = load("atlas");
    const payload = screen([instance("control", "partial", [5, 7, 12, 10])]);
    const frame = paint(payload, deps, { focus: "control", pressed: "control", guides: true });
    expect(frame.drawImage.mock.calls).toEqual([[atlas, 13, 2, 12, 10, 5, 7, 12, 10]]);
    expect(frame.fillRect).not.toHaveBeenCalled();
    expect(frame.strokeRect.mock.results[0]?.value).toMatchObject({ color: defaults.focusColor, dash: [2, 1], rect: [4.5, 6.5, 13, 11] });
  });

  it("localizes menu text independently of its button art and skips a menu without a backing button", () => {
    const { deps, load, revision } = assets();
    revision("button", "button", { ...button, nineSlice: insets }, { states: "atlas", "focus-ring": "missing-ring" });
    revision("menu", "menu_item", menu);
    revision("broken", "menu_item", { ...menu, buttonRevisionId: "removed" });
    const atlas = load("atlas");
    const payload = screen([instance("action", "menu", [3, 6, 20, 13]), instance("broken", "broken", [30, 6, 12, 10])], {
      textCatalog: { languages: ["en", "pt-BR"], entries: [{ key: "menu.continue", text: { en: "I", "pt-BR": "C" } }] },
    });
    const en = paint(payload, deps, { focus: "action" });
    const pt = paint(payload, deps, { language: "pt-BR" });
    expect(en.drawImage.mock.calls).toHaveLength(9);
    expect(en.drawImage).toHaveBeenNthCalledWith(5, atlas, 3, 3, 7, 7, 5, 7, 15, 10);
    expect(pt.drawImage.mock.calls).toEqual(en.drawImage.mock.calls);
    expect(en.fillRect.mock.calls[0]).toEqual([6, 8, 1, 1]);
    expect(pt.fillRect.mock.calls[0]).toEqual([7, 8, 1, 1]);
    const small = screen([instance("action", "menu", [3, 6, 6, 4])]);
    const withNoContentArea = paint(small, deps);
    expect(withNoContentArea.drawImage.mock.calls).toHaveLength(9);
    expect(withNoContentArea.fillRect).not.toHaveBeenCalled();
  });

  it("keeps a caption when the button art is absent but respects an explicitly blank override", () => {
    const { deps, revision } = assets();
    revision("button", "button", button);
    const frame = paint(screen([
      instance("captioned", "button", [5, 7, 12, 10]),
      instance("silent", "button", [25, 7, 12, 10], { overrides: { text: "" } }),
    ]), deps);
    expect(frame.drawImage).not.toHaveBeenCalled();
    expect(frame.fillRect).toHaveBeenCalledTimes(10);
    expect(frame.fillRect).toHaveBeenNthCalledWith(1, 9, 9, 1, 1);
  });

  it("renders slot selection, occupied/empty fallbacks, centered icon and a right-aligned quantity", () => {
    const { deps, load, revision, picture } = assets();
    revision("slot", "slot", slot, { slots: "atlas" });
    const atlas = load("atlas");
    const item = picture("potion", "items", [7, 8, 4, 3]);
    revision("partial-slot", "slot", { ...slot, complete: false, nineSlice: insets, states: [slot.states[1]!] }, { slots: "atlas" });
    const payload = screen([
      instance("selected", "slot", [3, 4, 18, 12], { overrides: { iconRevisionId: "potion", quantity: 12, state: "disabled" } }),
      instance("occupied", "slot", [22, 4, 12, 10], { overrides: { iconRevisionId: "unavailable-icon" } }),
      instance("fallback", "slot", [35, 4, 12, 10], { overrides: { state: "disabled" } }),
      instance("empty", "slot", [48, 4, 12, 10]),
      instance("partial", "partial-slot", [3, 19, 16, 11]),
    ]);
    const frame = paint(payload, deps, { focus: "selected" });
    expect(frame.drawImage.mock.calls.slice(0, 5)).toEqual([
      [atlas, 26, 3, 12, 10, 3, 4, 12, 10], [item, 7, 8, 4, 3, 7, 7, 4, 3],
      [atlas, 14, 3, 12, 10, 22, 4, 12, 10], [atlas, 2, 3, 12, 10, 35, 4, 12, 10], [atlas, 2, 3, 12, 10, 48, 4, 12, 10],
    ]);
    expect(frame.drawImage.mock.calls).toHaveLength(14);
    expect(frame.drawImage).toHaveBeenNthCalledWith(10, atlas, 16, 4, 7, 7, 5, 20, 11, 8);
    expect(frame.fillRect.mock.calls.filter(([, y]) => y === 9)).toEqual([[9, 9, 1, 1], [12, 9, 1, 1], [13, 9, 1, 1]]);
    expect(frame.fillRect.mock.calls.filter(([, y]) => y === 13).map(([x]) => x)).toEqual([8, 9, 10, 12, 13, 14]);
    deps.loaded.clear();
    expect(paint(payload, deps, { focus: "selected" }).drawImage).not.toHaveBeenCalled();
  });

  it("crops reverse meter fill, layers its frame last, and handles minimum/default or unavailable media", () => {
    const { deps, load, revision } = assets();
    revision("meter", "meter", meter, { track: "bar-track", fill: "bar-fill", frame: "bar-frame" });
    const track = load("bar-track");
    const fill = load("bar-fill");
    const frame = load("bar-frame");
    const payload = screen([
      instance("quarter", "meter", [3, 7, 12, 6], { overrides: { value: 40 } }),
      instance("empty", "meter", [3, 15, 12, 6], { overrides: { value: 20 } }),
      instance("full", "meter", [3, 23, 12, 6]),
    ]);
    expect(paint(payload, deps).drawImage.mock.calls).toEqual([
      [track, 1, 2, 12, 6, 3, 7, 12, 6], [fill, 16, 20, 2, 4, 11, 8, 2, 4], [frame, 13, 2, 12, 6, 3, 7, 12, 6],
      [track, 1, 2, 12, 6, 3, 15, 12, 6], [frame, 13, 2, 12, 6, 3, 15, 12, 6],
      [track, 1, 2, 12, 6, 3, 23, 12, 6], [fill, 10, 20, 8, 4, 5, 24, 8, 4], [frame, 13, 2, 12, 6, 3, 23, 12, 6],
    ]);
    deps.loaded.clear();
    expect(paint(payload, deps).drawImage).not.toHaveBeenCalled();
  });

  it("draws freestanding captions and editor-only focus/selection outlines without leaking a dashed style", () => {
    const { deps } = assets();
    const payload = screen([
      instance("label", null, [5, 6, 10, 8], { text }),
      instance("blank", null, [16, 6, 10, 8], { text, overrides: { text: "" } }),
      instance("collapsed", null, [1, 1, 0, 0]),
      instance("missing", "deleted-revision", [5, 16, 12, 8]),
    ]);
    const rendered = paint(payload, deps, { focus: "label", selected: "missing", guides: true });
    expect(rendered.fillRect.mock.calls[0]).toEqual([6, 6, 1, 1]);
    expect(rendered.fillRect).toHaveBeenCalledTimes(10);
    expect(rendered.strokeRect.mock.results.map(({ value }) => value)).toEqual([
      { color: defaults.focusColor, width: 3, dash: [2, 1], rect: [4.5, 5.5, 11, 9] },
      { color: "rgba(0,229,255,0.35)", width: 1, dash: [], rect: [5.5, 6.5, 9, 7] },
      { color: "rgba(0,229,255,0.35)", width: 1, dash: [], rect: [16.5, 6.5, 9, 7] },
      { color: "rgba(0,229,255,0.35)", width: 1, dash: [], rect: [1.5, 1.5, 0, 0] },
      { color: "#00e5ff", width: 1, dash: [], rect: [5.5, 16.5, 11, 7] },
    ]);
    const clean = paint(payload, deps, { focus: "label", selected: "missing" });
    expect(clean.strokeRect).not.toHaveBeenCalled();
    expect(clean.fillRect.mock.calls).toEqual(rendered.fillRect.mock.calls);
  });
});

describe("live screen diagnostics", () => {
  it("reports only visible overflow, distinguishing bad bounds, minimum cuts and caption policies", () => {
    const { deps, revision } = assets();
    revision("button", "button", button);
    revision("slice", "button", { ...button, nineSlice: insets });
    revision("menu", "menu_item", { ...menu, buttonRevisionId: "slice" });
    revision("detached", "menu_item", { ...menu, buttonRevisionId: "removed" });
    const payload = screen([
      instance("left", null, [-1, 2, 12, 9]), instance("top", null, [2, -1, 12, 9]),
      instance("right", "button", [60, 20, 6, 10]), instance("bottom", null, [1, 41, 12, 8]),
      instance("corner", null, [60, 44, 4, 4]),
      instance("narrow", "slice", [1, 8, 5, 10]), instance("short", "menu", [7, 8, 10, 3]),
      instance("no-button", "detached", [9, 20, 10, 8]),
      instance("caption", null, [20, 20, 7, 5], { text: { ...text, overflow: "ellipsis" } }),
      instance("blank", null, [30, 20, 2, 2], { text, overrides: { text: "" } }),
      instance("hidden", null, [61, 22, 6, 7], { hidden: true }),
      instance("hidden-caption", null, [0, 0, 2, 2], { text, parentId: "hidden" }),
    ], { textCatalog: { languages: ["en", "pt-BR"], entries: [{ key: text.key, text: { en: "A", "pt-BR": "Abrir" } }] } });
    expect(screenProblems(payload, [64, 48], deps, "en")).toEqual({
      resolution: [64, 48], offscreen: ["left", "top", "right", "bottom"], small: ["narrow", "short"],
      text: [{ instanceId: "narrow", outcome: "report" }, { instanceId: "short", outcome: "report" }],
    });
    expect(screenProblems(payload, [80, 60], deps, "pt-BR")).toEqual({
      resolution: [80, 60], offscreen: ["left", "top"], small: ["narrow", "short"],
      text: [
        { instanceId: "right", outcome: "report" }, { instanceId: "narrow", outcome: "report" },
        { instanceId: "short", outcome: "report" }, { instanceId: "caption", outcome: "ellipsis" },
      ],
    });
  });
});
