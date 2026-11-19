// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ScreenPayload } from "@/contracts";
import { I18nProvider } from "@/i18n/client";
import { ScreenComposer } from "./screen-composer";
import type { UiCatalog } from "./ui-client";

const emptyCatalog: UiCatalog = { components: [], templates: [], screens: [], images: [], backgrounds: [], palette: [], focusColor: "#ee9977" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("edits a caption, navigates the preview, and saves the composition with its chosen language", async () => {
  const context = {
    clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), setLineDash: vi.fn(),
    fillStyle: "",
    imageSmoothingEnabled: true,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const request = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(
    Response.json({ asset: { id: "screen" }, revision: { id: "screen-r1", number: 1 } }, { status: 201 }),
  ));
  vi.stubGlobal("fetch", request);
  const refresh = vi.fn();
  render(<I18nProvider locale="en"><ScreenComposer projectId="playtest" catalog={emptyCatalog} refresh={refresh} /></I18nProvider>);

  fireEvent.click(screen.getByRole("button", { name: "Empty screen" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Opening credits" } });
  fireEvent.change(screen.getByLabelText("Logical resolution"), { target: { value: "400x300" } });
  fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Preview backdrop"), { target: { value: "dark" } });
  fireEvent.change(screen.getByLabelText("Preview language"), { target: { value: "en" } });
  const preview = screen.getByLabelText(/^Screen preview/);
  const canvas = preview.querySelector("canvas")!;
  expect([canvas.width, canvas.height]).toEqual([800, 600]);
  expect(context.imageSmoothingEnabled).toBe(false);
  expect(context.fillStyle).toBe("#14141a");
  expect(context.fillRect).toHaveBeenLastCalledWith(0, 0, 800, 600);
  expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 400, 300);
  expect(context.drawImage).toHaveBeenLastCalledWith(expect.objectContaining({ width: 400, height: 300 }), 0, 0, 800, 600);

  fireEvent.change(screen.getByLabelText("Insert into root"), { target: { value: "text" } });
  fireEvent.click(screen.getByRole("button", { name: "Insert" }));
  const captionId = screen.getByRole("button", { name: /^text-/ }).textContent!;
  expect(screen.getByText("text · 8,8,80,10")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Sample"), { target: { value: "Ancient forest" } });
  fireEvent.change(screen.getByLabelText("Alignment"), { target: { value: "center" } });
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "title" } });
  fireEvent.click(screen.getByRole("button", { name: "Add the selected one" }));
  expect(within(screen.getByRole("list")).getByText(captionId, { exact: false })).toBeDefined();

  fireEvent.keyDown(preview, { key: "Tab" });
  expect(context.setLineDash).toHaveBeenLastCalledWith([2, 1]);
  expect(context.strokeRect).toHaveBeenCalledWith(7.5, 7.5, 81, 11);
  fireEvent.keyDown(preview, { key: "Enter" });
  expect(screen.getByText(`Activated: ${captionId}`)).toBeDefined();
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 120, 800, 600));
  fireEvent.click(canvas, { clientX: 102, clientY: 122 });
  expect(screen.getByRole("heading", { name: "root group" })).toBeDefined();
  fireEvent.mouseMove(canvas, { clientX: 120, clientY: 140 });
  fireEvent.click(canvas, { clientX: 120, clientY: 140 });
  expect(screen.getByRole("heading", { name: `${captionId} text` })).toBeDefined();
  fireEvent.mouseLeave(canvas);

  fireEvent.click(screen.getByRole("button", { name: "Save revision" }));
  expect(await screen.findByText("Revision r1 saved as a candidate.")).toBeDefined();
  expect(refresh).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith("/api/v1/projects/playtest/ui/screens", expect.objectContaining({ method: "POST" }));
  const body = JSON.parse(String(request.mock.calls[0]?.[1].body));
  expect(body).toMatchObject({ name: "Opening credits", language: "en" });
  const payload = ScreenPayload.parse(body.payload);
  expect(payload.focusOrder).toEqual([captionId]);
  expect(payload.testedResolutions).toEqual([[320, 180], [400, 300]]);
  expect(payload.instances).toMatchObject([
    { instanceId: "root", parentId: null },
    { instanceId: captionId, parentId: "root", offsets: { left: 8, top: 8, right: 88, bottom: 18 }, role: "title", text: { sample: "Ancient forest", align: "center" } },
  ]);
});
