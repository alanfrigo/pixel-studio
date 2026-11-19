// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, type Mock, vi } from "vitest";
import type { MapObjectPayload } from "@/contracts";
import { I18nProvider } from "@/i18n/client";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { MapsPanel } from "./maps-panel";
import type { WorldCatalog } from "./world-client";

const projectId = "workshop";
const api = `/api/v1/projects/${projectId}`;
const date = "2026-01-01T00:00:00Z";

function asset(id: string, family: AssetView["family"], kind: string, name: string, approvedRevisionId: string | null = null): AssetView {
  return { id, projectId, family, kind, name, approvedRevisionId, archivedAt: null, createdAt: date, updatedAt: date };
}

function revision(asset: AssetView, id: string, number: number, status: RevisionView["status"], payload: unknown = {}): RevisionView {
  return {
    id, assetId: asset.id, projectId, number, status, payload, predecessorId: null, styleRevisionId: null,
    payloadDigest: "fixture", origin: "import", jobAttemptId: null, technicalReport: null, createdAt: date, files: [],
  };
}

function panel(data: Partial<WorldCatalog> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  const refresh = vi.fn();
  const catalog = { textures: [], tilesets: [], maps: [], objects: [], ...data };
  const view = render(<I18nProvider locale="en"><MapsPanel projectId={projectId} catalog={catalog} refresh={refresh} initialMap={null} /></I18nProvider>);
  return { ...view, fetch, refresh };
}

const object = asset("mill", "map", "object", "Mill", "mill-r1");
const prop: MapObjectPayload = {
  projection: "side", fileId: "mill-image", rect: [0, 0, 16, 24], logicalSize: [16, 24], supportPoint: [8, 23],
  footprintCells: [1, 1], collision: [[4, 12, 8, 12]], occlusionAboveY: null,
};
const objects = [{ asset: object, revisions: [
  {
    ...revision(object, "mill-r2", 2, "candidate", prop),
    files: [{ id: "mill-media", role: "normalized", idx: 0, fileKey: "mill-image", sha256: "fixture", mime: "image/png", bytes: 64, metadata: {} }],
  },
  revision(object, "mill-r1", 1, "approved", prop),
] }];

function selectPng(container: HTMLElement) {
  // JSDOM cannot decode a blob URL. Simulate the browser reporting the decoded dimensions.
  const image = document.createElement("img");
  image.width = 31;
  image.height = 20;
  vi.spyOn(window, "Image").mockImplementation(function () { return image; });
  const revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, {
    createObjectURL: () => "blob:map-object",
    revokeObjectURL: revoke,
  }));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["image"], "mill.png", { type: "image/png" })] } });
  fireEvent.load(image);
  return { input, revoke };
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

function expectPost(fetch: Mock<typeof globalThis.fetch>, url: string, body: object) {
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(body);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("offers only non-rejected tilesets and keeps the authored map fields after a create error", async () => {
  const terrain = asset("cliff", "tileset", "sidescroller", "Cliff");
  const { fetch, refresh } = panel({ tilesets: [{ asset: terrain, revisions: [revision(terrain, "cliff-r2", 2, "rejected"), revision(terrain, "cliff-r1", 1, "candidate")] }] });
  fetch.mockResolvedValueOnce(Response.json({ code: "validation_failed", message: "The map is too wide" }, { status: 422 }));
  const tileset = screen.getByRole<HTMLSelectElement>("combobox", { name: "Tileset" });
  const create = button("Create");
  expect(create.disabled).toBe(true);
  expect(within(tileset).queryByRole("option", { name: /rejected/ })).toBeNull();

  fireEvent.change(tileset, { target: { value: "cliff-r1" } });
  const name = within(create.closest("section")!).getByRole<HTMLInputElement>("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "West cliff" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Columns" }), { target: { value: "129" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Rows" }), { target: { value: "3" } });
  fireEvent.click(create);

  expect(await screen.findByText("The map is too wide")).toBeTruthy();
  expectPost(fetch, `${api}/world/maps`, { name: "West cliff", tilesetRevisionId: "cliff-r1", size: [129, 3] });
  expect(name.value).toBe("West cliff");
  expect(tileset.value).toBe("cliff-r1");
  expect(screen.getByText("No maps yet.")).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
});

it("requires a nonblank rejection reason and reviews against the current approved object revision", async () => {
  const { fetch, refresh } = panel({ objects });
  expect(screen.getByRole("img", { name: "Mill" }).getAttribute("src")).toBe(`${api}/media/mill-media`);
  const prompt = vi.spyOn(window, "prompt").mockReturnValueOnce(null).mockReturnValueOnce("  ").mockReturnValueOnce("  The base clips into walls.  ");
  fetch.mockResolvedValueOnce(Response.json({}));
  fireEvent.click(button("Reject"));
  fireEvent.click(button("Reject"));
  expect(fetch).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(prompt).toHaveBeenLastCalledWith("Reason for rejecting");

  fireEvent.click(button("Reject"));
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expectPost(fetch, `${api}/assets/mill/reviews`, { revisionId: "mill-r2", decision: "reject", reason: "The base clips into walls.", expectedActiveRevisionId: "mill-r1" });
});

it("shows a stale object approval error without refreshing the catalog", async () => {
  const { fetch, refresh } = panel({ objects });
  fetch.mockResolvedValueOnce(Response.json({ code: "revision_conflict", message: "The approved revision changed" }, { status: 409 }));
  fireEvent.click(button("Approve"));
  expect(await screen.findByText("The approved revision changed")).toBeTruthy();
  expectPost(fetch, `${api}/assets/mill/reviews`, { revisionId: "mill-r2", decision: "approve", reason: null, expectedActiveRevisionId: "mill-r1" });
  expect(refresh).not.toHaveBeenCalled();
});

it("publishes the normalized image with reviewed side-view support, footprint and collision metadata", async () => {
  const { container, fetch, refresh } = panel();
  fetch.mockImplementation(async (url, init) => {
    if (url === `${api}/uploads` && init?.method === "POST") return Response.json({ upload: { id: "mill-upload" } });
    if (url === `${api}/uploads/mill-upload`) return Response.json({ upload: { id: "mill-upload", status: "ready" } });
    if (url === `${api}/world/objects` && init?.method === "POST") return Response.json({ revision: { number: 3 } });
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  const { revoke } = selectPng(container);
  const submit = button("Import");
  const fields = within(submit.closest("section")!);
  expect(fields.getByText("31×20 px")).toBeTruthy();
  expect(fields.getByRole<HTMLInputElement>("textbox", { name: "Support x,y" }).value).toBe("15,19");
  expect(revoke).toHaveBeenCalledWith("blob:map-object");

  fireEvent.change(fields.getByRole("textbox", { name: "Name" }), { target: { value: "Mill" } });
  fireEvent.change(fields.getByRole("combobox", { name: "View" }), { target: { value: "side" } });
  fireEvent.change(fields.getByRole("textbox", { name: "Support x,y" }), { target: { value: " 14, 18 " } });
  fireEvent.change(fields.getByRole("textbox", { name: "Footprint" }), { target: { value: "2, 1" } });
  fireEvent.change(fields.getByRole("textbox", { name: "Collision" }), { target: { value: "2, 10, 4, 9; 12, 14, 6, 5" } });
  fireEvent.change(fields.getByRole("textbox", { name: "Occlusion above y" }), { target: { value: " " } });
  fireEvent.click(submit);

  expect(await fields.findByText("Mill r3 published as a candidate")).toBeTruthy();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([`${api}/uploads`, `${api}/uploads/mill-upload`, `${api}/world/objects`]);
  const form = fetch.mock.calls[0]![1]!.body as FormData;
  expect(form.get("file")).toMatchObject({ name: "mill.png", type: "image/png" });
  expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string)).toEqual({
    target: { name: "Mill" },
    object: { image: { from: "upload", uploadId: "mill-upload" }, projection: "side", supportPoint: [14, 18], footprintCells: [2, 1], collision: [[2, 10, 4, 9], [12, 14, 6, 5]], occlusionAboveY: null },
  });
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("never publishes an object when normalization rejects its PNG", async () => {
  const { container, fetch, refresh } = panel();
  fetch.mockResolvedValueOnce(Response.json({ upload: { id: "bad-upload" } }));
  fetch.mockResolvedValueOnce(Response.json({ upload: { id: "bad-upload", status: "rejected" } }));
  const submit = button("Import");
  expect(submit.disabled).toBe(true);
  const { input } = selectPng(container);
  fireEvent.click(submit);

  expect(await screen.findByText("The image could not be imported")).toBeTruthy();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([`${api}/uploads`, `${api}/uploads/bad-upload`]);
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [] } });
  expect(submit.disabled).toBe(true);
  expect(screen.queryByText("31×20 px")).toBeNull();
});
