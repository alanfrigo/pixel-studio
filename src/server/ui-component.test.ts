import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ButtonPayload, PanelPayload } from "@/contracts";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { createAsset, createProject, getUpload } from "./catalog/catalog";
import { DomainFailure } from "./errors";
import { ingestUpload, publishFromSource } from "./services";
import { makeTestStudio, type TestStudio } from "./testing";

const hasPython = existsSync(`${process.cwd()}/python/.venv/bin/python`);
let studio: TestStudio;
afterEach(() => studio?.cleanup());

function framePng(w: number, h: number, fill: [number, number, number, number]): Uint8Array {
  const img = createImage(w, h);
  fillRect(img, 0, 0, w, h, [40, 40, 48, 255]);
  fillRect(img, 1, 1, w - 2, h - 2, fill);
  return encodePng(img);
}

async function upload(projectId: string, name: string, bytes: Uint8Array) {
  const { upload } = await ingestUpload(studio, projectId, { name, bytes });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, projectId, upload.id).status).toBe("ready");
  return { from: "upload" as const, uploadId: upload.id };
}

const insets = { left: 4, right: 4, top: 4, bottom: 4 };
const padding = { left: 7, right: 7, top: 5, bottom: 5 };

describe.skipIf(!hasPython)("componente de UI (cartão U2)", () => {
  it("botão com quatro estados, foco sobreposto, nine-slice e legenda separada", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "UI" });
    const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "ui", kind: "button", name: "Botão de metal" });
    const states = [
      { state: "normal" as const, image: await upload(project.id, "normal.png", framePng(32, 16, [120, 120, 130, 255])) },
      { state: "hover" as const, image: await upload(project.id, "hover.png", framePng(32, 16, [150, 150, 160, 255])) },
      { state: "pressed" as const, image: await upload(project.id, "pressed.png", framePng(32, 16, [90, 90, 100, 255])) },
    ];
    const focus = await upload(project.id, "focus.png", framePng(32, 16, [0, 0, 0, 0]));
    const component = {
      kind: "button" as const,
      states,
      focus: { mode: "overlay" as const, image: focus },
      nineSlice: insets,
      contentPadding: padding,
      text: { key: "inventory.use", sample: "Usar" },
    };
    const partial = publishFromSource(studio, project.id, asset.id, { from: "ui_component", component });
    const payload = ButtonPayload.parse(partial.payload);
    expect(payload.complete).toBe(false); // falta "disabled"
    expect(payload.states.map((s) => s.state)).toEqual(["normal", "hover", "pressed"]);
    expect(payload.text).toMatchObject({ key: "inventory.use", sample: "Usar", align: "center", overflow: "grow" });
    expect(payload.focus).toEqual({ mode: "overlay", fileId: "focus", rect: [0, 0, 32, 16] });
    expect(partial.files.map((f) => f.fileKey).sort()).toEqual(["focus", "state-hover", "state-normal", "state-pressed"]);

    const disabled = await upload(project.id, "disabled.png", framePng(32, 16, [70, 70, 70, 255]));
    const full = publishFromSource(studio, project.id, asset.id, { from: "ui_component", component: { ...component, states: [...states, { state: "disabled", image: disabled }] } });
    expect(ButtonPayload.parse(full.payload).complete).toBe(true);
    expect(full.number).toBe(2);
  });

  it("recusa estados com células diferentes e família errada; painel guarda tamanho mínimo", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "UI" });
    const button = createAsset(studio.db, studio.clock, { projectId: project.id, family: "ui", kind: "button", name: "Botão" });
    const normal = await upload(project.id, "normal.png", framePng(32, 16, [120, 120, 130, 255]));
    const big = await upload(project.id, "hover.png", framePng(34, 16, [150, 150, 160, 255]));
    const base = { kind: "button" as const, focus: null, nineSlice: insets, contentPadding: padding, text: null };
    const err = (() => {
      try {
        publishFromSource(studio, project.id, button.id, { from: "ui_component", component: { ...base, states: [{ state: "normal", image: normal }, { state: "hover", image: big }] } });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(DomainFailure);
    expect((err as DomainFailure).message).toMatch(/hover tem 34×16.*32×16/);
    const item = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "consumable", name: "Poção" });
    expect(() => publishFromSource(studio, project.id, item.id, { from: "ui_component", component: { ...base, states: [{ state: "normal", image: normal }] } })).toThrow(/item\/consumable/);

    const panelAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "ui", kind: "panel", name: "Painel" });
    const panelImage = await upload(project.id, "painel.png", framePng(24, 24, [60, 50, 40, 255]));
    const panel = publishFromSource(studio, project.id, panelAsset.id, {
      from: "ui_component",
      component: { kind: "panel", image: panelImage, nineSlice: { left: 6, right: 6, top: 6, bottom: 6 }, contentPadding: { left: 8, right: 8, top: 8, bottom: 8 } },
    });
    expect(PanelPayload.parse(panel.payload)).toMatchObject({ logicalSize: [24, 24], minSize: [13, 13], stretch: { center: "stretch", edges: "stretch" } });
  });
});
