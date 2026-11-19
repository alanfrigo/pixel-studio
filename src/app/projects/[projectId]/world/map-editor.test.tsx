// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CornerTilesetPayload, IsoPiece, IsoTilesetPayload, MapObjectPayload, SideTilesetPayload, TilemapPayload } from "@/contracts";
import { I18nProvider } from "@/i18n/client";
import { MapEditor } from "./map-editor";

type Point = [number, number];
const projectId = "workshop";
const assetId = "courtyard";
const mapUrl = `/api/v1/projects/${projectId}/world/maps/${assetId}`;
const draftUrl = `/api/v1/projects/${projectId}/assets/${assetId}/draft`;
const date = "2026-01-01T00:00:00Z";
const doors: TilemapPayload["entrances"] = [
  { entranceId: "west", name: "West Gate", cell: [0, 0], side: "W" },
  { entranceId: "east", name: "East Gate", cell: [2, 0], side: "E" },
];
const route = [{ from: "west", to: "east" }];
const atlas = { fileId: "atlas", margin: 0, spacing: 0 };
const corner: CornerTilesetPayload = {
  projection: "three_quarter", cellSize: [8, 8], atlas, complete: false,
  terrains: [{ terrainId: "grass", name: "Grass", color: "#33cc33" }, { terrainId: "water", name: "Water", color: "#3333cc" }],
  diagonals: { mask5: "separate", mask10: "separate" },
  tiles: [{ tileKey: "grass", mask: 0, variant: 0, weight: 1, rect: [0, 0, 8, 8], frames: [] }],
};
const sideConfigurations = ["surface_middle", "surface_right", "surface_single"] as const;
const side: SideTilesetPayload = {
  projection: "side", cellSize: [8, 8], atlas, complete: true,
  platformMaterial: "Stone", surfaceMaterial: "Grass", walkableLineY: 1,
  requiredConfigurations: [...sideConfigurations],
  tiles: sideConfigurations.map((configuration, i) => ({
    tileKey: configuration, configuration, variant: 0, weight: 1, rect: [i * 8, 0, 8, 8], frames: [],
  })),
};
const floor: IsoPiece = {
  pieceKey: "cobble", kind: "floor", name: "Cobblestone", rect: [0, 0, 16, 8], logicalSize: [16, 8], groundOrigin: [8, 0],
  supportPoint: [8, 4], footprintCells: [1, 1], elevation: 0, occluderRect: null, blocksMovement: false,
};
const statue: IsoPiece = {
  pieceKey: "statue", kind: "prop", name: "Statue", rect: [16, 0, 24, 16], logicalSize: [24, 16], groundOrigin: [8, 4],
  supportPoint: [12, 10], footprintCells: [2, 1], elevation: 0, occluderRect: null, blocksMovement: true,
};
const iso: IsoTilesetPayload = {
  projection: "isometric", groundDiamondSize: [16, 8], logicalCellSize: [8, 8], elevationStepPx: 2,
  sortRule: "depth_ij_elevation_v1", atlas, pieces: [floor, statue],
};
const gate: MapObjectPayload = {
  projection: "three_quarter", fileId: "gate-image", rect: [0, 0, 8, 8], logicalSize: [8, 8], supportPoint: [4, 4],
  footprintCells: [1, 1], collision: [[0, 0, 8, 8]], occlusionAboveY: 2,
};

function courtyard(edits: Partial<TilemapPayload> = {}): TilemapPayload {
  return {
    projection: "three_quarter", size: [3, 2], cellSize: [8, 8], seed: 7, units: { cell: "cell", offset: "px", polygon: "px" },
    objects: [], collisions: [], regions: [], entrances: doors, passages: route,
    terrain: { mode: "corner", tilesetRevisionId: "terrain-r1", rule: "corner-v1", vertices: Array<0>(12).fill(0), walkable: [true, false], overrides: [], resolved: Array<string>(6).fill("grass") },
    ...edits,
  };
}

function opened(payload = courtyard(), extra: Record<string, unknown> = {}) {
  const terrain = payload.terrain;
  const tileset = {
    assetId: "terrain", name: "Terrain", revisionId: terrain.tilesetRevisionId, number: 1, status: "approved", atlasMediaId: "atlas-media",
    ...(terrain.mode === "side" ? { kind: "sidescroller", payload: side } : terrain.mode === "isometric" ? { kind: "isometric", payload: iso } : { kind: "corner", payload: corner }),
  };
  return {
    asset: { id: assetId, projectId, family: "map", kind: "tilemap", name: "Courtyard", approvedRevisionId: null, archivedAt: null, createdAt: date, updatedAt: date },
    payload, source: { kind: "draft", version: 4 }, draftVersion: 4,
    tileset, objects: {}, available: { objects: [], tilesets: [] }, revisions: [], ...extra,
  };
}

function editor(data: object) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(data));
  vi.stubGlobal("fetch", fetch);
  const onCatalogChange = vi.fn();
  const onOpen = vi.fn();
  const { container } = render(<I18nProvider locale="en"><MapEditor projectId={projectId} assetId={assetId} onCatalogChange={onCatalogChange} onOpen={onOpen} /></I18nProvider>);
  function writes(url: string, method: "PUT" | "POST") {
    return fetch.mock.calls.filter(([path, req]) => path === url && req?.method === method).map(([, req]) => JSON.parse(req!.body as string) as unknown);
  }
  return { fetch, onCatalogChange, onOpen, writes, canvas: () => container.querySelector("canvas")! };
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
const click = (name: string) => fireEvent.click(button(name));
const change = (control: HTMLElement, value: string) => fireEvent.change(control, { target: { value } });
const orthoCenter = (x: number, y: number): Point => [8 + 16 * x, 8 + 16 * y];
// Screen centers of the test atlas's 16×8 diamonds at 2× zoom, including vertical headroom.
const isoCenter = (x: number, y: number): Point => [32 + 16 * (x - y), 56 + 8 * (x + y)];

function stroke(canvas: HTMLCanvasElement, start: Point, stop: Point = start) {
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: start[0], clientY: start[1], buttons: 1 });
  if (stop !== start) fireEvent.pointerMove(canvas, { pointerId: 1, clientX: stop[0], clientY: stop[1], buttons: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: stop[0], clientY: stop[1], buttons: 0 });
}

beforeEach(() => {
  // The interactions target logical cells. No pixel rendering is needed in JSDOM.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    beginPath() {}, clearRect() {}, closePath() {}, drawImage() {}, fill() {}, fillRect() {}, fillText() {},
    lineTo() {}, moveTo() {}, stroke() {}, strokeRect() {},
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps conflicting local edits until the author reloads the newer draft and saves against its version", async () => {
  const remote = courtyard({ entrances: [{ ...doors[0]!, name: "West Ramp" }, doors[1]!] });
  const { fetch, writes } = editor(opened());
  fetch.mockResolvedValueOnce(Response.json({ code: "revision_conflict", message: "Expected draft version 4, found 7" }, { status: 409 }));
  fetch.mockResolvedValueOnce(Response.json(opened(remote, { source: { kind: "draft", version: 7 }, draftVersion: 7 })));
  fetch.mockResolvedValueOnce(Response.json({ draft: { version: 8 } }));
  const west = await screen.findByDisplayValue("West Gate");
  change(west, "Local archway");
  click("Save draft");
  expect(await screen.findByText("The draft was changed in another tab; reload before saving.")).toBeTruthy();
  expect(screen.getByDisplayValue("Local archway")).toBeTruthy();

  click("Reopen draft");
  change(await screen.findByDisplayValue("West Ramp"), "West Ramp Annex");
  expect(screen.queryByDisplayValue("Local archway")).toBeNull();
  click("Undo");
  expect(screen.getByDisplayValue("West Ramp")).toBeTruthy();
  expect(button("Undo").disabled).toBe(true);
  click("Save draft");
  expect(await screen.findByText("Draft saved (version 8).")).toBeTruthy();
  expect(writes(draftUrl, "PUT")).toEqual([
    { expectedVersion: 4, payload: { ...courtyard(), entrances: [{ ...doors[0], name: "Local archway" }, doors[1]] } },
    { expectedVersion: 7, payload: remote },
  ]);
});

it("opens a historical revision but copies the latest published revision with the selected tileset", async () => {
  const revisions = [
    { id: "map-r2", number: 2, status: "candidate", createdAt: date, technicalReport: { passages: [{ from: "west", to: "east", connected: true }] } },
    { id: "map-r1", number: 1, status: "approved", createdAt: date, technicalReport: null },
  ];
  const available = { objects: [], tilesets: [{ revisionId: "moss-r3", name: "Mossy terrain", number: 3, status: "approved" as const }] };
  const historical = courtyard({ regions: [{ regionId: "orchard", name: "Old orchard", kind: "area", rect: [1, 0, 1, 2] }] });
  const { fetch, onCatalogChange, onOpen, writes } = editor(opened(courtyard(), { revisions, available }));
  fetch.mockResolvedValueOnce(Response.json(opened(historical, { revisions, available, source: { kind: "revision", revisionId: "map-r1", number: 1 } })));
  fetch.mockResolvedValueOnce(Response.json({ asset: { id: "courtyard-copy" } }));

  const approved = await screen.findByText("approved");
  fireEvent.click(within(approved.closest("li")!).getByRole("button", { name: "Open" }));
  expect(await screen.findByText("Revision r1 opened: editing and saving replaces the draft.")).toBeTruthy();
  expect(screen.getByDisplayValue("Old orchard")).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith(`${mapUrl}?revision=map-r1`, expect.anything());
  change(screen.getByRole("combobox", { name: "Copy the latest revision with tileset" }), "moss-r3");
  click("Copy");
  await vi.waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith("courtyard-copy"));
  expect(onCatalogChange).toHaveBeenCalledTimes(1);
  expect(writes(`${mapUrl}/copy`, "POST")).toEqual([{ revisionId: "map-r2", name: "Courtyard (copy)", tilesetRevisionId: "moss-r3" }]);
});

it("explains an entrance blocked by an object and only publishes it after an explicit override", async () => {
  const available = {
    objects: [{ revisionId: "gate-r3", assetId: "gate", name: "Iron gate", number: 3, status: "candidate" as const, payload: gate, mediaId: "gate-media" }],
    tilesets: [],
  };
  const edited = courtyard({ objects: [{ objectId: "obj-1", objectRevisionId: "gate-r3", pieceKey: null, cell: [2, 0], offsetPx: [0, 0], label: "Iron gate" }] });
  const blocked = { from: "west", to: "east", connected: false };
  const published = { id: "map-r1", number: 1, status: "candidate", createdAt: date, technicalReport: { passages: [blocked] } };
  const { fetch, onCatalogChange, writes, canvas } = editor(opened(courtyard(), { available }));
  fetch.mockResolvedValueOnce(Response.json({ draft: { version: 5 } }));
  fetch.mockResolvedValueOnce(Response.json({ code: "validation_failed", message: "Passage blocked: west → east", details: { passages: [blocked] } }, { status: 422 }));
  fetch.mockResolvedValueOnce(Response.json({ draft: { version: 6 } }));
  fetch.mockResolvedValueOnce(Response.json({ revision: published, missing: [] }));
  fetch.mockResolvedValueOnce(Response.json(opened(edited, { available, revisions: [published], draftVersion: 6, source: { kind: "draft", version: 6 } })));

  expect(await screen.findByText("connected (2 steps)")).toBeTruthy();
  click("Place and move objects");
  expect(screen.getByRole("option", { name: "Iron gate r3 (candidate)" })).toBeTruthy();
  change(screen.getByRole("combobox", { name: "Object to place" }), "gate-r3");
  stroke(canvas(), orthoCenter(2, 0));
  expect(screen.getByText("Entrance East Gate is on a blocked cell")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Publish despite the blocked passage" })).toBeNull();
  click("Publish revision");
  expect(await screen.findByText("Passage blocked: west → east")).toBeTruthy();
  expect(writes(`${mapUrl}/publish`, "POST")).toEqual([{ payload: edited, allowBrokenPassages: false }]);
  expect(onCatalogChange).not.toHaveBeenCalled();

  click("Publish despite the blocked passage");
  expect(await screen.findByText(/passages blocked/, { selector: "li" })).toBeTruthy();
  expect(writes(`${mapUrl}/publish`, "POST")).toEqual([{ payload: edited, allowBrokenPassages: false }, { payload: edited, allowBrokenPassages: true }]);
  expect(writes(draftUrl, "PUT")).toEqual([{ expectedVersion: 4, payload: edited }, { expectedVersion: 5, payload: edited }]);
  expect(screen.queryByRole("button", { name: "Publish despite the blocked passage" })).toBeNull();
  expect(onCatalogChange).toHaveBeenCalledTimes(1);
});

it("validates authored coordinates and keeps door references, regions and polygons in the draft", async () => {
  const { canvas, fetch, writes } = editor(opened(courtyard({ passages: [] })));
  fetch.mockResolvedValueOnce(Response.json({ draft: { version: 5 } }));
  await screen.findByDisplayValue("East Gate");
  click("Require a passage between the first two doors");
  const east = within(screen.getByDisplayValue("East Gate").closest(".row")!);
  change(east.getByRole("spinbutton", { name: "x" }), "3");
  expect(screen.getByText("entrances.1.cell: Entrance outside the map")).toBeTruthy();
  expect(button("Publish revision").disabled).toBe(true);
  change(east.getByRole("spinbutton", { name: "x" }), "2");
  change(east.getByRole("textbox", { name: "Stable ID" }), "courtyard-exit");
  expect(screen.getByText(/west → courtyard-exit:/)).toBeTruthy();
  expect(button("Publish revision").disabled).toBe(false);

  click("Region (drag)");
  stroke(canvas(), orthoCenter(2, 1), orthoCenter(1, 0));
  expect(screen.getByDisplayValue("1,0,2,2")).toBeTruthy();
  change(screen.getByDisplayValue("Region 1"), "Camp");
  change(screen.getByRole("combobox", { name: "Type" }), "spawn");
  const rect = screen.getByRole("textbox", { name: "x,y,w,h" });
  change(rect, "0,0,2,1");
  fireEvent.blur(rect);
  click("Add collision polygon");
  const polygon = screen.getByRole("textbox", { name: /polygon in map px/ });
  change(polygon, "16,0 24,0 24,8 16,8");
  fireEvent.blur(polygon);
  expect(screen.getByText("Entrance East Gate is on a blocked cell")).toBeTruthy();

  fireEvent.click(within(screen.getByDisplayValue("West Gate").closest(".row")!).getByRole("button", { name: "Remove" }));
  expect(screen.queryByText(/west → courtyard-exit:/)).toBeNull();
  expect(button("Publish revision").disabled).toBe(false);
  click("Save draft");
  expect(await screen.findByText("Draft saved (version 5).")).toBeTruthy();
  expect(writes(draftUrl, "PUT")).toEqual([{ expectedVersion: 4, payload: courtyard({
    entrances: [{ ...doors[1]!, entranceId: "courtyard-exit" }], passages: [],
    regions: [{ regionId: "regiao-1", name: "Camp", kind: "spawn", rect: [0, 0, 2, 1] }],
    collisions: [{ collisionId: "poligono-1", kind: "polygon", points: [[16, 0], [24, 0], [24, 8], [16, 8]] }],
  }) }]);
});

it("flood-fills connected corner terrain, reports missing masks and restores passage on undo", async () => {
  const { canvas } = editor(opened());
  expect(await screen.findByText("connected (2 steps)")).toBeTruthy();

  click("Fill terrain");
  stroke(canvas(), orthoCenter(2, 1));
  expect(screen.getByText("Entrance West Gate is on a blocked cell")).toBeTruthy();

  click("Select / inspect");
  stroke(canvas(), orthoCenter(1, 0));
  expect(screen.getByText("Cell (1, 0): mask 15 → MISSING from the tileset · blocked")).toBeTruthy();

  click("Undo");
  expect(screen.getByText("connected (2 steps)")).toBeTruthy();
  stroke(canvas(), orthoCenter(1, 0));
  expect(screen.getByText("Cell (1, 0): mask 0 → grass · walkable")).toBeTruthy();
});

it("paints and erases side-view platforms and leaves door connectivity explicitly unchecked", async () => {
  const map = courtyard({ projection: "side", size: [3, 1], entrances: [], passages: [],
    terrain: { mode: "side", tilesetRevisionId: "side-r1", rule: "side-v1", solid: [0, 0, 0], resolved: [null, null, null] },
  });
  const { canvas, fetch, writes } = editor(opened(map));
  fetch.mockResolvedValueOnce(Response.json({ draft: { version: 5 } }));
  expect(await screen.findByText("Side-view passages need jump physics: not checked for this profile.")).toBeTruthy();
  click("Paint solid");
  stroke(canvas(), orthoCenter(0, 0), orthoCenter(1, 0));
  click("Erase (air)");
  stroke(canvas(), orthoCenter(0, 0));
  click("Select / inspect");
  stroke(canvas(), orthoCenter(1, 0));
  expect(screen.getByText(/^Cell \(1, 0\): solid: surface_single/)).toBeTruthy();
  stroke(canvas(), orthoCenter(0, 0));
  expect(screen.getByText(/^Cell \(0, 0\): air/)).toBeTruthy();
  click("Door / entrance");
  stroke(canvas(), orthoCenter(0, 0));
  stroke(canvas(), orthoCenter(2, 0));
  click("Require a passage between the first two doors");
  expect(screen.getByText("Side-view passage needs jump physics; not checked")).toBeTruthy();
  click("Save draft");
  expect(await screen.findByText("Draft saved (version 5).")).toBeTruthy();
  expect(writes(draftUrl, "PUT")).toEqual([{ expectedVersion: 4, payload: {
    ...map, terrain: { ...map.terrain, solid: [0, 1, 0], resolved: [null, "surface_single", null] },
    entrances: [{ entranceId: "porta-1", name: "Door 1", cell: [0, 0], side: "W" }, { entranceId: "porta-2", name: "Door 2", cell: [2, 0], side: "E" }],
    passages: [{ from: "porta-1", to: "porta-2" }],
  } }]);
});

it("paints an elevated isometric floor and moves a blocking two-cell prop by its footprint", async () => {
  const cells = Array.from({ length: 6 }, () => ({ pieceKey: "cobble", elevation: 0 }));
  const terrain = { mode: "isometric", tilesetRevisionId: "iso-r1", rule: "iso-v1", cells } as const;
  const map = courtyard({ projection: "isometric", cellSize: [16, 8], terrain });
  const { canvas, fetch, writes } = editor(opened(map));
  fetch.mockResolvedValueOnce(Response.json({ draft: { version: 5 } }));
  expect(await screen.findByText("connected (2 steps)")).toBeTruthy();
  click("Paint piece");
  const piece = screen.getByRole("combobox", { name: "Piece" });
  expect(within(piece).queryByRole("option", { name: "Statue" })).toBeNull();
  change(piece, "cobble");
  change(screen.getByRole("spinbutton", { name: "Elevation" }), "2");
  stroke(canvas(), isoCenter(1, 0));
  click("Select / inspect");
  stroke(canvas(), isoCenter(1, 0));
  expect(screen.getByText("Cell (1, 0): piece cobble, elevation 2 · walkable")).toBeTruthy();

  click("Place and move objects");
  const props = screen.getByRole("combobox", { name: "Object to place" });
  expect(within(props).queryByRole("option", { name: "Cobblestone" })).toBeNull();
  change(props, "piece:statue");
  stroke(canvas(), isoCenter(0, 0));
  expect(screen.getByText("Entrance West Gate is on a blocked cell")).toBeTruthy();
  stroke(canvas(), isoCenter(1, 0), isoCenter(1, 1));
  expect(screen.getByText("connected (2 steps)")).toBeTruthy();
  change(screen.getByRole("spinbutton", { name: "Δx px" }), "-3");
  click("Save draft");
  expect(await screen.findByText("Draft saved (version 5).")).toBeTruthy();
  expect(writes(draftUrl, "PUT")).toEqual([{ expectedVersion: 4, payload: {
    ...map, terrain: { ...terrain, cells: cells.map((cell, i) => i === 1 ? { ...cell, elevation: 2 } : cell) },
    objects: [{ objectId: "obj-1", objectRevisionId: null, pieceKey: "statue", cell: [1, 1], offsetPx: [-3, 0], label: "Statue" }],
  } }]);
});
